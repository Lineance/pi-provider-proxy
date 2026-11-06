/**
 * Minimal structural types for the parts of `undici` this extension touches.
 *
 * We deliberately do NOT depend on the `undici` package at runtime: pi already
 * owns one instance, and mixing a second copy of undici with pi's fetcher is the
 * exact failure mode documented in pi's own HTTP dispatcher ("compressed
 * responses consumed through another undici copy"). Instead we resolve pi's
 * instance at runtime and type against this structural subset.
 */

/** Options handed to a dispatcher by `fetch`. Only `origin` is inspected. */
export type DispatcherRequestOptions = Record<string, unknown> & { origin?: string | URL };

/** Undici handler objects are opaque to this extension. */
export type DispatcherHandler = Record<string, unknown>;

/** The subset of `undici.Dispatcher` used here. */
export interface Dispatcher {
  dispatch(options: DispatcherRequestOptions, handler: DispatcherHandler): boolean;
  close(): Promise<void>;
  destroy(error?: Error | null): Promise<void>;
}

/** Constructor shape for undici's agent classes. */
export type DispatcherConstructor = new (options?: Record<string, unknown>) => Dispatcher;

/** Constructor shape for `ProxyAgent`. */
export type ProxyAgentConstructor = new (options: { uri: string } & Record<string, unknown>) => Dispatcher;

/** The subset of the `undici` module namespace this extension needs. */
export interface UndiciModule {
  Dispatcher: DispatcherConstructor;
  Agent: DispatcherConstructor;
  ProxyAgent: ProxyAgentConstructor;
  getGlobalDispatcher(): Dispatcher;
  setGlobalDispatcher(dispatcher: Dispatcher): void;
}

/** Result of resolving pi's own undici instance. */
export interface UndiciResolution {
  module: UndiciModule;
  /** File URL the module was loaded from. */
  path: string;
  /**
   * True when a process-wide dispatcher is already installed, so pi's fetcher
   * consults the dispatcher slot this extension replaces.
   */
  affectsPi: boolean;
}

/** Thrown when no usable undici instance can be located. */
export class UndiciResolutionError extends Error {
  override readonly name = "UndiciResolutionError";

  constructor(
    message: string,
    readonly attempts: readonly string[] = [],
  ) {
    super(message);
  }
}
