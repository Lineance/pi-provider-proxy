/**
 * Installs and keeps installed the routing dispatcher.
 *
 * pi applies `settings.httpProxy` and installs its own dispatcher *after* the
 * extension runtime is created, so an eager install during module load would be
 * overwritten. Instead the extension calls `ensure()` on lifecycle events; a
 * cheap identity check makes repeated calls free and self-heals after
 * `/reload` or a settings change that resets the dispatcher.
 */
import type { Dispatcher, UndiciModule, UndiciResolution } from "../types.js";
import { debug } from "./log.js";
import type { Route } from "./resolve.js";
import { createRouter, isProviderProxyRouter, type AgentTuning, type RouterHandle } from "./router.js";
import type { ProxyStats } from "./stats.js";
import { errorMessage, resolveUndiciCached, type UndiciResolutionOptions } from "./undici.js";

export type InstallState =
  | { status: "installed"; undiciPath: string; affectsPi: boolean }
  | { status: "disabled"; reason: string }
  | { status: "failed"; reason: string; attempts: readonly string[] };

export interface InstallerOptions {
  resolveRoute(host: string): Route;
  stats: ProxyStats;
  tuning?: Partial<AgentTuning> | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** Recorded once, used to detect "someone else replaced the dispatcher". */
  onReinstalled?: (() => void) | undefined;
  /** Injection point for tests; defaults to resolving pi's own undici. */
  resolveUndici?: (() => Promise<UndiciResolution>) | undefined;
}

export class DispatcherInstaller {
  private handle: RouterHandle | undefined;
  private module: UndiciModule | undefined;
  private previous: Dispatcher | undefined;
  private state: InstallState = { status: "disabled", reason: "not installed yet" };
  private disabledReason: string | undefined;

  constructor(private readonly options: InstallerOptions) {
    const env = options.env ?? process.env;
    const escape = env["PI_PROVIDER_PROXY_DISABLE"]?.trim().toLowerCase();
    if (escape === "1" || escape === "true" || escape === "yes") {
      this.disabledReason = "PI_PROVIDER_PROXY_DISABLE is set";
    }
  }

  getState(): InstallState {
    return this.state;
  }

  /** One-line diagnostics for notifications and `/proxy`. */
  describeState(): string {
    if (this.state.status !== "failed") return this.state.status;
    const attempts = this.state.attempts.slice(0, 3).join("; ");
    return attempts === "" ? this.state.reason : `${this.state.reason} (tried: ${attempts})`;
  }

  /** True when our dispatcher is the process-wide one right now. */
  isActive(): boolean {
    if (this.handle === undefined || this.module === undefined) return false;
    return this.module.getGlobalDispatcher() === this.handle.dispatcher;
  }

  /**
   * Make sure our dispatcher is installed. Safe to call on every event: the
   * common path is one identity comparison.
   */
  async ensure(): Promise<InstallState> {
    if (this.disabledReason !== undefined) {
      this.state = { status: "disabled", reason: this.disabledReason };
      return this.state;
    }

    if (this.isActive()) return this.state;

    try {
      const resolution = await this.resolve();
      const { module } = resolution;
      this.module = module;
      const current = module.getGlobalDispatcher();
      const alreadyOurs = this.handle?.dispatcher === current;

      if (!alreadyOurs) {
        if (this.handle !== undefined) {
          // Someone (pi or another extension) replaced our router: retire ours.
          await this.handle.close().catch(() => undefined);
          this.options.onReinstalled?.();
        }
        if (this.previous === undefined || !isProviderProxyRouter(this.previous)) {
          this.previous = current;
        }

        this.handle = createRouter({
          undici: module,
          resolveRoute: (host: string) => this.options.resolveRoute(host),
          inherit: this.previous,
          stats: this.options.stats,
          tuning: this.options.tuning,
        });

        module.setGlobalDispatcher(this.handle.dispatcher);
        debug("dispatcher installed", resolution.path);
      }

      const installed = this.handle;
      if (installed === undefined) {
        this.state = {
          status: "failed",
          reason: "internal error: router missing after install",
          attempts: [],
        };
        return this.state;
      }

      this.state = {
        status: "installed",
        undiciPath: resolution.path,
        affectsPi: module.getGlobalDispatcher() === installed.dispatcher,
      };
      return this.state;
    } catch (error) {
      this.state = {
        status: "failed",
        reason: errorMessage(error),
        attempts: (error as { attempts?: readonly string[] }).attempts ?? [],
      };
      debug("dispatcher install failed", this.state.reason);
      return this.state;
    }
  }

  /** Resolve pi's undici with cached env options. */
  private async resolve(): Promise<UndiciResolution> {
    const injected = this.options.resolveUndici;
    if (injected !== undefined) return injected();
    const env = this.options.env;
    const resolutionOptions: UndiciResolutionOptions = env ? { env } : {};
    return resolveUndiciCached(resolutionOptions);
  }

  /** Restore pi's dispatcher (used on session shutdown). */
  async uninstall(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle === undefined) return;

    const previous = this.previous;
    const installedModule = this.module;
    if (previous !== undefined && installedModule?.getGlobalDispatcher() === handle.dispatcher) {
      try {
        installedModule.setGlobalDispatcher(previous);
      } catch {
        // Nothing sensible to do: leaving ours installed only affects this process.
      }
    }
    await handle.close().catch(() => undefined);
    this.state = { status: "disabled", reason: "uninstalled" };
  }
}
