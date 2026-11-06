/**
 * A fake `undici` module namespace.
 *
 * Production code must resolve pi's real undici instance, so the router and the
 * installer are written against a structural subset. This fake implements that
 * subset and records everything, which keeps the routing matrix testable
 * without sockets.
 */
import type {
  Dispatcher,
  DispatcherHandler,
  DispatcherRequestOptions,
  UndiciModule,
} from "../../src/types.js";

export interface AgentRecord {
  kind: "agent" | "proxy";
  options: Record<string, unknown>;
  dispatches: DispatcherRequestOptions[];
  closed: number;
  destroyed: number;
}

export interface FakeDispatcher extends Dispatcher {
  readonly name: string;
  dispatches: DispatcherRequestOptions[];
}

export interface FakeUndici {
  module: UndiciModule;
  agents: AgentRecord[];
  inherit: FakeDispatcher;
  globalDispatcher(): Dispatcher;
}

export interface FakeUndiciOptions {
  /** Throw when a proxy agent is constructed with this URI. */
  failProxyUris?: readonly string[];
}

export function createFakeDispatcher(name: string): FakeDispatcher {
  const dispatcher: FakeDispatcher = {
    name,
    dispatches: [],
    dispatch(options: DispatcherRequestOptions, _handler: DispatcherHandler): boolean {
      dispatcher.dispatches.push(options);
      return true;
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
    destroy(): Promise<void> {
      return Promise.resolve();
    },
  };
  return dispatcher;
}

export function createFakeUndici(options: FakeUndiciOptions = {}): FakeUndici {
  const inherited = createFakeDispatcher("inherit");
  const state = { current: inherited as Dispatcher };
  const agents: AgentRecord[] = [];
  const failProxyUris = new Set(options.failProxyUris ?? []);

  class BaseDispatcher {
    dispatch(_options: DispatcherRequestOptions, _handler: DispatcherHandler): boolean {
      throw new Error("base dispatcher should be overridden");
    }

    close(): Promise<void> {
      return Promise.resolve();
    }

    destroy(_error?: Error | null): Promise<void> {
      return Promise.resolve();
    }
  }

  class FakeAgent extends BaseDispatcher {
    readonly record: AgentRecord;

    constructor(agentOptions: Record<string, unknown> = {}) {
      super();
      this.record = { kind: "agent", options: agentOptions, dispatches: [], closed: 0, destroyed: 0 };
      agents.push(this.record);
    }

    override dispatch(request: DispatcherRequestOptions, _handler: DispatcherHandler): boolean {
      this.record.dispatches.push(request);
      return true;
    }
  }

  class FakeProxyAgent extends BaseDispatcher {
    readonly record: AgentRecord;

    constructor(agentOptions: { uri: string } & Record<string, unknown>) {
      super();
      if (failProxyUris.has(agentOptions.uri)) {
        throw new Error(`cannot connect to proxy ${agentOptions.uri}`);
      }
      this.record = { kind: "proxy", options: agentOptions, dispatches: [], closed: 0, destroyed: 0 };
      agents.push(this.record);
    }

    override dispatch(request: DispatcherRequestOptions, _handler: DispatcherHandler): boolean {
      this.record.dispatches.push(request);
      return true;
    }
  }

  const module: UndiciModule = {
    Dispatcher: BaseDispatcher,
    Agent: FakeAgent,
    ProxyAgent: FakeProxyAgent,
    getGlobalDispatcher: () => state.current,
    setGlobalDispatcher: (dispatcher: Dispatcher) => {
      state.current = dispatcher;
    },
  };

  return {
    module,
    agents,
    inherit: inherited,
    globalDispatcher: () => state.current,
  };
}
