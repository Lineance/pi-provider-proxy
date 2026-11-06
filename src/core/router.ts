/**
 * The dispatcher that turns "which provider is this request for" into
 * "direct / proxy / inherit".
 *
 * It replaces pi's global undici dispatcher, so it sees every request pi's
 * fetcher makes — including provider SDK calls that never touch
 * `globalThis.fetch` directly. Undici dispatches per origin, which maps 1:1 to
 * the host of a provider's `baseUrl`.
 */
import type { Dispatcher, DispatcherHandler, DispatcherRequestOptions, UndiciModule } from "../types.js";
import { debug, warn } from "./log.js";
import { normalizeHost, type Route } from "./resolve.js";
import type { ProxyStats } from "./stats.js";

/** Marker used to detect "our router is already installed". */
export const ROUTER_MARKER = Symbol.for("pi-provider-proxy.router");

/** Agent tuning mirroring pi's own dispatcher defaults. */
export interface AgentTuning {
  allowH2: boolean;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  autoSelectFamilyAttemptTimeoutMs: number;
}

export const DEFAULT_AGENT_TUNING: AgentTuning = {
  allowH2: false,
  // Matches pi's DEFAULT_HTTP_IDLE_TIMEOUT_MS.
  headersTimeoutMs: 300_000,
  bodyTimeoutMs: 300_000,
  autoSelectFamilyAttemptTimeoutMs: 2_000,
};

export interface RouterOptions {
  undici: UndiciModule;
  /** Decision function, called once per dispatch. */
  resolveRoute(host: string): Route;
  /** pi's dispatcher captured at install time; used for `inherit` and as fallback. */
  inherit: Dispatcher;
  stats: ProxyStats;
  tuning?: Partial<AgentTuning> | undefined;
}

export interface RouterHandle {
  dispatcher: Dispatcher;
  close(): Promise<void>;
  destroy(error?: Error | null): Promise<void>;
  agentCount(): number;
  readonly stats: ProxyStats;
}

function hostFromOrigin(origin: string | URL | undefined): string | undefined {
  if (origin === undefined) return undefined;
  try {
    const url = origin instanceof URL ? origin : new URL(origin);
    return normalizeHost(url.hostname);
  } catch {
    return undefined;
  }
}

/** True when the given value is a router created by this module. */
export function isProviderProxyRouter(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[ROUTER_MARKER] === true
  );
}

export function createRouter(options: RouterOptions): RouterHandle {
  const { undici, inherit, stats } = options;
  const tuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, ...options.tuning };
  const agents = new Map<string, Dispatcher>();
  let closed = false;

  const agentOptions: Record<string, unknown> = {
    allowH2: tuning.allowH2,
    headersTimeout: tuning.headersTimeoutMs,
    bodyTimeout: tuning.bodyTimeoutMs,
    connect: { autoSelectFamilyAttemptTimeout: tuning.autoSelectFamilyAttemptTimeoutMs },
  };

  const cachedAgent = (key: string, factory: () => Dispatcher): Dispatcher => {
    const existing = agents.get(key);
    if (existing !== undefined) return existing;
    const created = factory();
    agents.set(key, created);
    return created;
  };

  const directAgent = (): Dispatcher => cachedAgent("direct", () => new undici.Agent(agentOptions));

  const proxyAgent = (url: string): Dispatcher =>
    cachedAgent(
      `proxy:${url}`,
      () => new undici.ProxyAgent({ uri: url, proxyTunnel: true, ...agentOptions }),
    );

  const closeAll = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const pending = [...agents.values()].map((agent) => agent.close().catch(() => undefined));
    await Promise.all(pending);
    agents.clear();
  };

  const destroyAll = async (error?: Error | null): Promise<void> => {
    if (closed) return;
    closed = true;
    const pending = [...agents.values()].map((agent) => agent.destroy(error).catch(() => undefined));
    await Promise.all(pending);
    agents.clear();
  };

  class ProviderProxyRouter extends undici.Dispatcher {
    override dispatch(request: DispatcherRequestOptions, handler: DispatcherHandler): boolean {
      const host = hostFromOrigin(request.origin);
      if (host === undefined) return inherit.dispatch(request, handler);

      let route: Route;
      try {
        route = options.resolveRoute(host);
      } catch (error) {
        stats.recordError();
        warn(`route resolution failed for ${host}, falling back to inherit: ${String(error)}`);
        route = { kind: "inherit", reason: "resolver error" };
      }

      stats.record(host, route);
      debug("dispatch", host, route.kind, route.kind === "proxy" ? route.url : route.reason);

      try {
        switch (route.kind) {
          case "direct":
            return directAgent().dispatch(request, handler);
          case "proxy":
            return proxyAgent(route.url).dispatch(request, handler);
          case "inherit":
            return inherit.dispatch(request, handler);
          default: {
            const exhaustive: never = route;
            throw new Error(`unhandled route ${JSON.stringify(exhaustive)}`);
          }
        }
      } catch (error) {
        stats.recordError();
        warn(`dispatch to ${route.kind} failed for ${host}, falling back to inherit: ${String(error)}`);
        return inherit.dispatch(request, handler);
      }
    }

    override close(): Promise<void> {
      return closeAll();
    }

    override destroy(error?: Error | null): Promise<void> {
      return destroyAll(error);
    }
  }

  const dispatcher: Dispatcher = new ProviderProxyRouter();
  (dispatcher as unknown as Record<symbol, unknown>)[ROUTER_MARKER] = true;

  return {
    dispatcher,
    close: closeAll,
    destroy: destroyAll,
    agentCount: () => agents.size,
    stats,
  };
}
