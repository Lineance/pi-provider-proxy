/**
 * End-to-end routing test with real undici + real sockets, no external network.
 *
 * `localhost` and `127.0.0.1` stand in for two providers: both resolve locally,
 * but only one of them is routed through the CONNECT proxy, so the proxy's
 * tunnel log tells us exactly which requests took which path.
 */
import {
  Agent,
  Dispatcher,
  getGlobalDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
  fetch as undiciFetch,
} from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createRouter, type RouterHandle } from "../src/core/router.js";
import type { Dispatcher as MinimalDispatcher, UndiciModule } from "../src/types.js";
import { ProxyStats } from "../src/core/stats.js";
import {
  startConnectProxy,
  startTargetServer,
  type ConnectProxy,
  type TargetServer,
} from "./fixtures/servers.js";

let target: TargetServer;
let proxy: ConnectProxy;
let router: RouterHandle | undefined;
let previousDispatcher: Dispatcher;

/** Real undici, narrowed to the structural subset the extension targets. */
const undiciModule = {
  Dispatcher,
  Agent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} as unknown as UndiciModule;

function useDispatcher(dispatcher: MinimalDispatcher | Dispatcher): void {
  setGlobalDispatcher(dispatcher as Dispatcher);
}

const stats = new ProxyStats();

beforeAll(async () => {
  target = await startTargetServer();
  proxy = await startConnectProxy();
  previousDispatcher = getGlobalDispatcher();
});

afterAll(async () => {
  useDispatcher(previousDispatcher);
  await proxy.close();
  await target.close();
});

afterEach(async () => {
  await router?.close();
  router?.dispatcher.destroy().catch(() => undefined);
  router = undefined;
  useDispatcher(previousDispatcher);
  proxy.connects.length = 0;
  stats.reset();
});

/** Synthetic "provider hosts" mapped onto the two local addresses. */
function installRouter(rules: Record<string, "direct" | "proxy">): { inheritCalls: () => number } {
  let inheritCalls = 0;

  // Inherit is a thin wrapper so we can count delegations without changing them.
  // Real undici types are richer than the structural subset the extension uses.
  const inherit: MinimalDispatcher = {
    dispatch: (options, handler) => {
      inheritCalls += 1;
      return (new Agent() as unknown as MinimalDispatcher).dispatch(options, handler);
    },
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };

  router = createRouter({
    undici: undiciModule,
    resolveRoute: (host) => {
      const mode = rules[host] ?? "inherit";
      if (mode === "proxy") return { kind: "proxy", url: proxy.url, reason: "test rule" };
      if (mode === "direct") return { kind: "direct", reason: "test rule" };
      return { kind: "inherit", reason: "test rule" };
    },
    inherit,
    stats,
  });

  useDispatcher(router.dispatcher);
  return { inheritCalls: () => inheritCalls };
}

describe("routing through real sockets", () => {
  it("sends the proxied host through CONNECT and the direct host straight to the target", async () => {
    installRouter({ localhost: "proxy", "127.0.0.1": "direct" });

    const proxied = await undiciFetch(`http://localhost:${String(target.port)}/a`);
    expect(await proxied.text()).toBe(`ok:localhost:${String(target.port)}`);
    expect(proxy.connects).toEqual([`localhost:${String(target.port)}`]);

    const direct = await undiciFetch(`http://127.0.0.1:${String(target.port)}/b`);
    expect(await direct.text()).toBe(`ok:127.0.0.1:${String(target.port)}`);
    // The direct request never opened a tunnel.
    expect(proxy.connects).toEqual([`localhost:${String(target.port)}`]);

    expect(stats.proxy).toBe(1);
    expect(stats.direct).toBe(1);
  });

  it("keeps a direct route direct even when a global proxy is configured", async () => {
    const previousHttpProxy = process.env["HTTP_PROXY"];
    const previousHttpsProxy = process.env["HTTPS_PROXY"];
    process.env["HTTP_PROXY"] = "http://127.0.0.1:1";
    process.env["HTTPS_PROXY"] = "http://127.0.0.1:1";

    try {
      installRouter({ "127.0.0.1": "direct" });
      const response = await undiciFetch(`http://127.0.0.1:${String(target.port)}/direct`);
      expect(response.status).toBe(200);
      expect(proxy.connects).toEqual([]);
    } finally {
      restoreEnv("HTTP_PROXY", previousHttpProxy);
      restoreEnv("HTTPS_PROXY", previousHttpsProxy);
    }
  });

  it("delegates inherit routes to pi's dispatcher", async () => {
    const counter = installRouter({});
    const response = await undiciFetch(`http://localhost:${String(target.port)}/inherit`);
    expect(response.status).toBe(200);
    expect(counter.inheritCalls()).toBe(1);
    expect(proxy.connects).toEqual([]);
  });

  it("reports a broken proxy instead of silently falling back", async () => {
    installRouter({ localhost: "proxy" });
    const brokenProxy = "http://127.0.0.1:1";
    // Re-install with an unreachable proxy URL.
    await router?.close();
    let calls = 0;
    router = createRouter({
      undici: undiciModule,
      resolveRoute: () => ({ kind: "proxy", url: brokenProxy, reason: "test rule" }),
      inherit: {
        dispatch: () => ((calls += 1), true),
        close: () => Promise.resolve(),
        destroy: () => Promise.resolve(),
      },
      stats,
    });
    useDispatcher(router.dispatcher);

    await expect(undiciFetch(`http://localhost:${String(target.port)}/x`)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}
