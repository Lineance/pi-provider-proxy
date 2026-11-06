/**
 * Runtime state for the extension: effective config, provider index, stats and
 * the dispatcher installer. Everything the command handler and the lifecycle
 * hooks need lives here, so `index.ts` stays a thin wiring file.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { serializeConfig, type Config, type ConfigIssue, type RouteRule } from "../core/config.js";
import { DispatcherInstaller, type InstallState } from "../core/install.js";
import { debug } from "../core/log.js";
import { probeProvider, type ProbeResult } from "../core/probe.js";
import { buildProviderIndex, type ProviderIndex } from "../core/providers.js";
import { explainRoute, formatRoute, resolveRoute, type ResolveContext, type Route } from "../core/resolve.js";
import { DEFAULT_AGENT_TUNING, type AgentTuning } from "../core/router.js";
import { ProxyStats } from "../core/stats.js";
import { loadConfig, writeConfigFile, type LoadedConfig } from "../core/store.js";

export type ConfigTarget = "global" | "project";

export interface ProxyRuntimeOptions {
  api: ExtensionAPI;
  env?: Record<string, string | undefined> | undefined;
}

const EMPTY_INDEX: ProviderIndex = {
  hostToProviders: new Map(),
  providerHosts: new Map(),
  conflicts: new Map(),
};

export class ProxyRuntime {
  readonly stats = new ProxyStats();

  private loaded: LoadedConfig;
  private index: ProviderIndex = EMPTY_INDEX;
  private tuning: AgentTuning = DEFAULT_AGENT_TUNING;
  private readonly installer: DispatcherInstaller;
  private notifiedInstallFailure: string | undefined;
  private readonly api: ExtensionAPI;
  private readonly env: Record<string, string | undefined>;

  constructor(options: ProxyRuntimeOptions) {
    this.api = options.api;
    this.env = options.env ?? process.env;
    this.loaded = loadConfig({ cwd: process.cwd(), env: this.env });
    this.installer = new DispatcherInstaller({
      resolveRoute: (host) => this.route(host),
      stats: this.stats,
      tuning: this.tuning,
      env: this.env,
      onReinstalled: () => {
        debug("dispatcher was replaced by someone else; reinstalled");
      },
    });
  }

  /** Effective config (defaults applied, project layer merged). */
  get config(): Config {
    return this.loaded.config;
  }

  get issues(): ConfigIssue[] {
    return this.loaded.issues;
  }

  get configPaths(): { global: string; project: string; projectLoaded: boolean } {
    return {
      global: this.loaded.globalPath,
      project: this.loaded.projectPath,
      projectLoaded: this.loaded.projectLoaded,
    };
  }

  get knownProviders(): Map<string, string[]> {
    return this.index.providerHosts;
  }

  get hostConflicts(): Map<string, string[]> {
    return this.index.conflicts;
  }

  installState(): InstallState {
    return this.installer.getState();
  }

  /** Installer state with the tried undici locations, for `/proxy`. */
  installStateText(): string {
    return this.installer.describeState();
  }

  /** Reload config + provider index from disk/registry, then ensure install. */
  async refresh(ctx: ExtensionContext, options: { projectTrusted?: boolean } = {}): Promise<void> {
    this.loaded = loadConfig({
      cwd: ctx.cwd,
      env: this.env,
      projectTrusted: options.projectTrusted ?? safeIsProjectTrusted(ctx),
    });

    // provider → host comes from the model catalogue; top-level `hosts` rules are the escape hatch.
    this.index = buildProviderIndex(
      ctx.modelRegistry.getAll().map((model) => ({ provider: model.provider, baseUrl: model.baseUrl })),
    );

    const settings = safeSettings(this.api);
    const timeout = readTimeout(settings);
    this.tuning = {
      ...DEFAULT_AGENT_TUNING,
      ...(timeout === undefined ? {} : { headersTimeoutMs: timeout, bodyTimeoutMs: timeout }),
    };

    await this.ensureInstalled(ctx);
    debug("runtime refreshed", {
      providers: this.index.providerHosts.size,
      layers: this.loaded.layers,
      issues: this.loaded.issues.length,
    });
  }

  /** Cheap identity check; installs on first use and after dispatcher resets. */
  async ensureInstalled(ctx?: ExtensionContext): Promise<InstallState> {
    const state = await this.installer.ensure();
    if (state.status === "failed" && this.notifiedInstallFailure !== state.reason) {
      this.notifiedInstallFailure = state.reason;
      ctx?.ui.notify(
        `pi-provider-proxy: proxy routing unavailable — ${this.installer.describeState()}`,
        "warning",
      );
    }
    if (state.status === "installed") this.notifiedInstallFailure = undefined;
    return state;
  }

  async uninstall(): Promise<void> {
    await this.installer.uninstall();
  }

  route(host: string): Route {
    return resolveRoute(host, this.resolveContext());
  }

  resolveContext(): ResolveContext {
    return { config: this.loaded.config, hostToProviders: this.index.hostToProviders };
  }

  explain(host: string): string[] {
    return explainRoute(host, this.resolveContext());
  }

  routeLabel(host: string): string {
    return formatRoute(this.route(host));
  }

  providerHosts(provider: string): string[] {
    return this.index.providerHosts.get(provider) ?? [];
  }

  baseUrlFor(provider: string): string | undefined {
    const hosts = this.providerHosts(provider);
    const host = hosts[0];
    return host === undefined ? undefined : `https://${host}`;
  }

  /** Effective route for a provider (first host wins when it has several). */
  routeForProvider(provider: string): Route | undefined {
    const host = this.providerHosts(provider)[0];
    return host === undefined ? undefined : this.route(host);
  }

  async probe(provider: string, fetchImpl?: typeof fetch): Promise<ProbeResult> {
    const baseUrl = this.baseUrlFor(provider);
    if (baseUrl === undefined) {
      throw new Error(`unknown provider "${provider}" — no model uses it in this session`);
    }
    return probeProvider({
      provider,
      baseUrl,
      route: this.route(new URL(baseUrl).hostname),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }

  setStatusLine(mode: Config["statusLine"], showDirect?: boolean, target: ConfigTarget = "global"): void {
    this.loaded = {
      ...this.loaded,
      config: {
        ...this.loaded.config,
        statusLine: mode,
        ...(showDirect === undefined ? {} : { statusLineShowDirect: showDirect }),
      },
    };
    this.persist(target);
  }

  setEnabled(enabled: boolean, target: ConfigTarget = "global"): void {
    this.loaded = { ...this.loaded, config: { ...this.loaded.config, enabled } };
    this.persist(target);
  }

  setDefaultRule(rule: RouteRule, target: ConfigTarget = "global"): void {
    this.loaded = { ...this.loaded, config: { ...this.loaded.config, default: rule } };
    this.persist(target);
  }

  setProviderRule(provider: string, rule: RouteRule | undefined, target: ConfigTarget = "global"): void {
    const providers =
      rule === undefined
        ? withoutKey(this.loaded.config.providers, provider)
        : { ...this.loaded.config.providers, [provider]: rule };
    this.loaded = { ...this.loaded, config: { ...this.loaded.config, providers } };
    this.persist(target);
  }

  setHostRule(host: string, rule: RouteRule | undefined, target: ConfigTarget = "global"): void {
    const hosts =
      rule === undefined
        ? withoutKey(this.loaded.config.hosts, host)
        : { ...this.loaded.config.hosts, [host]: rule };
    this.loaded = { ...this.loaded, config: { ...this.loaded.config, hosts } };
    this.persist(target);
  }

  private persist(target: ConfigTarget): void {
    const path = target === "project" ? this.loaded.projectPath : this.loaded.globalPath;
    writeConfigFile(path, serializeConfig(this.loaded.config));
    debug("config saved", path);
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

function readTimeout(settings: Record<string, unknown>): number | undefined {
  const raw = settings["httpIdleTimeoutMs"];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    if (raw.trim().toLowerCase() === "disabled") return 0;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function safeSettings(api: ExtensionAPI): Record<string, unknown> {
  try {
    return api.getSettings() as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeIsProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}
