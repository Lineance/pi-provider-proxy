import { describe, expect, it } from "vitest";

import { createRouter, isProviderProxyRouter } from "../src/core/router.js";
import type { Route } from "../src/core/resolve.js";
import { ProxyStats } from "../src/core/stats.js";
import { createFakeUndici } from "./fixtures/fake-undici.js";

const PROXY = "http://127.0.0.1:7890";

function routes(map: Record<string, Route>, fallback: Route = { kind: "inherit", reason: "default" }) {
  return (host: string): Route => map[host] ?? fallback;
}

function setup(map: Record<string, Route>, options: { failProxyUris?: string[] } = {}) {
  const fake = createFakeUndici(options);
  const stats = new ProxyStats();
  const router = createRouter({
    undici: fake.module,
    resolveRoute: routes(map),
    inherit: fake.inherit,
    stats,
  });
  return { fake, stats, router };
}

const request = (origin: string) => ({ origin, method: "GET", path: "/" });

describe("router dispatch", () => {
  it("routes a proxied host through a ProxyAgent and caches it", () => {
    const { fake, router } = setup({
      "api.example.com": { kind: "proxy", url: PROXY, reason: "providers[provider-a]" },
    });

    router.dispatcher.dispatch(request("https://api.example.com/v1"), {});
    router.dispatcher.dispatch(request("https://api.example.com/v1"), {});

    expect(fake.agents).toHaveLength(1);
    const agent = fake.agents[0]!;
    expect(agent.kind).toBe("proxy");
    expect(agent.options["uri"]).toBe(PROXY);
    expect(agent.options["proxyTunnel"]).toBe(true);
    expect(agent.dispatches).toHaveLength(2);
    expect(fake.inherit.dispatches).toHaveLength(0);
  });

  it("routes a direct host through its own Agent, never the inherited dispatcher", () => {
    const { fake, router } = setup({
      "api.example.net": { kind: "direct", reason: "providers[provider-b]" },
    });

    router.dispatcher.dispatch(request("https://api.example.net/inference/go/openai/v1"), {});

    expect(fake.agents).toHaveLength(1);
    expect(fake.agents[0]!.kind).toBe("agent");
    expect(fake.agents[0]!.options["allowH2"]).toBe(false);
    expect(fake.inherit.dispatches).toHaveLength(0);
  });

  it("delegates inherit traffic to pi's dispatcher", () => {
    const { fake, router } = setup({});
    router.dispatcher.dispatch(request("https://example.test/"), {});
    expect(fake.inherit.dispatches).toHaveLength(1);
    expect(fake.agents).toHaveLength(0);
  });

  it("uses a distinct agent per proxy URL", () => {
    const { fake, router } = setup({
      "a.test": { kind: "proxy", url: PROXY, reason: "r" },
      "b.test": { kind: "proxy", url: "http://127.0.0.1:7899", reason: "r" },
    });
    router.dispatcher.dispatch(request("https://a.test/"), {});
    router.dispatcher.dispatch(request("https://b.test/"), {});
    expect(fake.agents.map((agent) => agent.options["uri"])).toEqual([PROXY, "http://127.0.0.1:7899"]);
  });

  it("falls back to the inherited dispatcher when the origin is missing", () => {
    const { fake, router } = setup({});
    router.dispatcher.dispatch({ method: "GET" }, {});
    expect(fake.inherit.dispatches).toHaveLength(1);
  });

  it("records stats per host", () => {
    const { stats, router } = setup({
      "a.test": { kind: "direct", reason: "r" },
      "b.test": { kind: "proxy", url: PROXY, reason: "r" },
    });
    router.dispatcher.dispatch(request("https://a.test/"), {});
    router.dispatcher.dispatch(request("https://b.test/"), {});
    router.dispatcher.dispatch(request("https://c.test/"), {});

    expect(stats.direct).toBe(1);
    expect(stats.proxy).toBe(1);
    expect(stats.inherit).toBe(1);
    expect(stats.lastRoutes.get("b.test")?.detail).toBe(PROXY);
  });

  it("falls back to inherit when the resolver throws", () => {
    const fake = createFakeUndici();
    const stats = new ProxyStats();
    const router = createRouter({
      undici: fake.module,
      resolveRoute: () => {
        throw new Error("boom");
      },
      inherit: fake.inherit,
      stats,
    });

    expect(router.dispatcher.dispatch(request("https://a.test/"), {})).toBe(true);
    expect(fake.inherit.dispatches).toHaveLength(1);
    expect(stats.errors).toBe(1);
  });

  it("falls back to inherit when a proxy agent cannot be created", () => {
    const { fake, stats, router } = setup(
      { "a.test": { kind: "proxy", url: PROXY, reason: "r" } },
      {
        failProxyUris: [PROXY],
      },
    );

    router.dispatcher.dispatch(request("https://a.test/"), {});
    expect(fake.inherit.dispatches).toHaveLength(1);
    expect(stats.errors).toBe(1);
  });
});

describe("router lifecycle", () => {
  it("closes every agent once and is idempotent", async () => {
    const { router } = setup({
      "a.test": { kind: "direct", reason: "r" },
      "b.test": { kind: "proxy", url: PROXY, reason: "r" },
    });
    router.dispatcher.dispatch(request("https://a.test/"), {});
    router.dispatcher.dispatch(request("https://b.test/"), {});
    expect(router.agentCount()).toBe(2);

    await router.close();
    await router.close();
    expect(router.agentCount()).toBe(0);
  });

  it("destroy() is safe without prior dispatch", async () => {
    const { router } = setup({});
    await expect(router.destroy(new Error("bye"))).resolves.toBeUndefined();
  });

  it("can be recognised by the marker", () => {
    const { router } = setup({});
    expect(isProviderProxyRouter(router.dispatcher)).toBe(true);
    expect(isProviderProxyRouter({})).toBe(false);
    expect(isProviderProxyRouter(null)).toBe(false);
  });

  it("passes the idle timeout through to its agents", () => {
    const fake = createFakeUndici();
    const router = createRouter({
      undici: fake.module,
      resolveRoute: () => ({ kind: "direct", reason: "r" }),
      inherit: fake.inherit,
      stats: new ProxyStats(),
      tuning: { headersTimeoutMs: 1234, bodyTimeoutMs: 1234 },
    });
    router.dispatcher.dispatch(request("https://a.test/"), {});
    expect(fake.agents[0]!.options["headersTimeout"]).toBe(1234);
  });
});
