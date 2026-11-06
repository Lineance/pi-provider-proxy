/**
 * Configuration model + validation for pi-provider-proxy.
 *
 * Zero dependencies on purpose: the validation errors are part of the UX
 * (`/proxy` prints them with a JSON path), so they are hand written instead of
 * delegated to a schema library.
 */

export type ProviderMode = "inherit" | "direct" | "proxy";

export type StatusLineMode = "auto" | "always" | "off";

/** One routing rule. */
export interface RouteRule {
  mode: ProviderMode;
  /** Proxy URL, required when `mode` is `"proxy"` unless a default proxy exists. */
  proxy?: string;
}

/** Fully resolved configuration (defaults applied). */
export interface Config {
  enabled: boolean;
  default: RouteRule;
  providers: Record<string, RouteRule>;
  hosts: Record<string, RouteRule>;
  loopbackAlwaysDirect: boolean;
  statusLine: StatusLineMode;
  /** Show `direct`/`inherit` rules in the footer. Off by default. */
  statusLineShowDirect: boolean;
}

/** Layer value: what a single config file says, before defaults. */
export interface RawConfig {
  enabled?: boolean;
  default?: RouteRule;
  providers?: Record<string, RouteRule>;
  hosts?: Record<string, RouteRule>;
  loopbackAlwaysDirect?: boolean;
  statusLine?: StatusLineMode;
  statusLineShowDirect?: boolean;
}

/** A validation problem, addressed at its JSON path. */
export interface ConfigIssue {
  /** JSON path inside the file, e.g. `providers.provider-a.mode`. */
  path: string;
  message: string;
}

export interface ParsedLayer {
  value: RawConfig;
  issues: ConfigIssue[];
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  default: { mode: "inherit" },
  providers: {},
  hosts: {},
  loopbackAlwaysDirect: true,
  statusLine: "auto",
  statusLineShowDirect: false,
};

const MODES: readonly ProviderMode[] = ["inherit", "direct", "proxy"];
const STATUS_LINE_MODES: readonly StatusLineMode[] = ["auto", "always", "off"];

const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "enabled",
  "default",
  "providers",
  "hosts",
  "loopbackAlwaysDirect",
  "statusLine",
  "statusLineShowDirect",
]);

const RULE_KEYS = new Set(["mode", "proxy"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a proxy URL.
 *
 * undici's `ProxyAgent` supports `http:` and `https:` proxies only. Clash /
 * mihomo `mixed-port` speaks HTTP, so this covers the common local setup while
 * failing loudly (instead of silently) for `socks5://`.
 */
export function validateProxyUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `invalid URL: ${value}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `unsupported protocol ${parsed.protocol} — undici supports http:// and https:// proxies only; use your client's mixed/HTTP port (e.g. Clash mihomo mixed-port 7890)`;
  }
  if (!parsed.hostname) return "proxy URL has no host";
  return undefined;
}

function parseRule(value: unknown, path: string, issues: ConfigIssue[]): RouteRule | undefined {
  if (typeof value === "string") {
    if (!MODES.includes(value as ProviderMode)) {
      issues.push({
        path,
        message: `unknown mode ${JSON.stringify(value)}; expected inherit, direct or proxy`,
      });
      return undefined;
    }
    return { mode: value as ProviderMode };
  }

  if (!isPlainObject(value)) {
    issues.push({
      path,
      message: `expected "inherit" | "direct" | "proxy" or an object with { mode, proxy }`,
    });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!RULE_KEYS.has(key)) issues.push({ path: `${path}.${key}`, message: "unknown key" });
  }

  const mode = value["mode"];
  if (typeof mode !== "string" || !MODES.includes(mode as ProviderMode)) {
    issues.push({
      path: `${path}.mode`,
      message: `expected inherit, direct or proxy (got ${JSON.stringify(mode)})`,
    });
    return undefined;
  }

  const rule: RouteRule = { mode: mode as ProviderMode };
  const rawProxy = value["proxy"];
  if (rawProxy === undefined) return rule;

  if (typeof rawProxy !== "string") {
    issues.push({ path: `${path}.proxy`, message: "expected a proxy URL string" });
    return rule;
  }
  const problem = validateProxyUrl(rawProxy);
  if (problem) {
    issues.push({ path: `${path}.proxy`, message: problem });
    return rule;
  }
  rule.proxy = rawProxy;
  return rule;
}

function parseRuleMap(value: unknown, path: string, issues: ConfigIssue[]): Record<string, RouteRule> {
  const result: Record<string, RouteRule> = {};
  if (value === undefined) return result;
  if (!isPlainObject(value)) {
    issues.push({ path, message: "expected an object mapping provider/host names to rules" });
    return result;
  }
  for (const [key, rawRule] of Object.entries(value)) {
    const rule = parseRule(rawRule, `${path}.${key}`, issues);
    if (rule) result[key] = rule;
  }
  return result;
}

/** Parse one config layer, collecting every problem instead of throwing. */
export function parseConfigLayer(raw: unknown, label = "config"): ParsedLayer {
  const issues: ConfigIssue[] = [];
  const value: RawConfig = {};

  if (raw === undefined || raw === null) return { value, issues };
  if (!isPlainObject(raw)) {
    issues.push({ path: "", message: `${label} must contain a JSON object` });
    return { value, issues };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) issues.push({ path: key, message: "unknown key" });
  }

  if (raw["enabled"] !== undefined) {
    if (typeof raw["enabled"] !== "boolean") {
      issues.push({ path: "enabled", message: "expected a boolean" });
    } else {
      value.enabled = raw["enabled"];
    }
  }

  if (raw["loopbackAlwaysDirect"] !== undefined) {
    if (typeof raw["loopbackAlwaysDirect"] !== "boolean") {
      issues.push({ path: "loopbackAlwaysDirect", message: "expected a boolean" });
    } else {
      value.loopbackAlwaysDirect = raw["loopbackAlwaysDirect"];
    }
  }

  if (raw["statusLineShowDirect"] !== undefined) {
    if (typeof raw["statusLineShowDirect"] !== "boolean") {
      issues.push({ path: "statusLineShowDirect", message: "expected a boolean" });
    } else {
      value.statusLineShowDirect = raw["statusLineShowDirect"];
    }
  }

  if (raw["statusLine"] !== undefined) {
    const statusLine = raw["statusLine"];
    if (typeof statusLine !== "string" || !STATUS_LINE_MODES.includes(statusLine as StatusLineMode)) {
      issues.push({ path: "statusLine", message: "expected auto, always or off" });
    } else {
      value.statusLine = statusLine as StatusLineMode;
    }
  }

  if (raw["default"] !== undefined) {
    const rule = parseRule(raw["default"], "default", issues);
    if (rule) value.default = rule;
  }

  const providers = parseRuleMap(raw["providers"], "providers", issues);
  if (Object.keys(providers).length > 0) value.providers = providers;

  const hosts = parseRuleMap(raw["hosts"], "hosts", issues);
  if (Object.keys(hosts).length > 0) value.hosts = hosts;

  return { value, issues };
}

/** Merge later layers over earlier ones, per provider/host key. */
export function mergeRawConfig(base: RawConfig, override: RawConfig): RawConfig {
  const merged: RawConfig = { ...base, ...override };
  const providers = { ...base.providers, ...override.providers };
  const hosts = { ...base.hosts, ...override.hosts };
  if (Object.keys(providers).length > 0) merged.providers = providers;
  if (Object.keys(hosts).length > 0) merged.hosts = hosts;
  return merged;
}

function withDefaults(raw: RawConfig): Config {
  return {
    enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
    default: raw.default ?? DEFAULT_CONFIG.default,
    providers: raw.providers ?? {},
    hosts: raw.hosts ?? {},
    loopbackAlwaysDirect: raw.loopbackAlwaysDirect ?? DEFAULT_CONFIG.loopbackAlwaysDirect,
    statusLine: raw.statusLine ?? DEFAULT_CONFIG.statusLine,
    statusLineShowDirect: raw.statusLineShowDirect ?? DEFAULT_CONFIG.statusLineShowDirect,
  };
}

export interface ConfigLayer {
  /** File path or logical name, used in issue messages. */
  label: string;
  raw: unknown;
}

export interface ConfigBuildResult {
  config: Config;
  issues: ConfigIssue[];
  /** Layers that contributed at least one value. */
  layers: string[];
}

/** Validate every layer, then merge them in order (later wins). */
export function buildConfig(layers: readonly ConfigLayer[]): ConfigBuildResult {
  const issues: ConfigIssue[] = [];
  const contributing: string[] = [];
  let merged: RawConfig = {};

  for (const layer of layers) {
    const parsed = parseConfigLayer(layer.raw, layer.label);
    for (const issue of parsed.issues) {
      issues.push({ path: issue.path, message: `${layer.label}: ${issue.message}` });
    }
    if (Object.keys(parsed.value).length > 0) contributing.push(layer.label);
    merged = mergeRawConfig(merged, parsed.value);
  }

  return { config: withDefaults(merged), issues, layers: contributing };
}

/** Serialize a config back to a file body (defaults and empty maps omitted). */
export function serializeConfig(config: Config): string {
  const body: Record<string, unknown> = {
    $schema: "https://unpkg.com/pi-provider-proxy/schema.json",
    enabled: config.enabled,
    default: serializeRule(config.default),
    loopbackAlwaysDirect: config.loopbackAlwaysDirect,
    statusLine: config.statusLine,
    statusLineShowDirect: config.statusLineShowDirect,
  };
  if (Object.keys(config.providers).length > 0) {
    body["providers"] = Object.fromEntries(
      Object.entries(config.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, rule]) => [key, serializeRule(rule)]),
    );
  }
  if (Object.keys(config.hosts).length > 0) {
    body["hosts"] = config.hosts;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

function serializeRule(rule: RouteRule): unknown {
  return rule.proxy === undefined ? rule.mode : { mode: rule.mode, proxy: rule.proxy };
}

/** Effective proxy URL for a rule, taking the default rule into account. */
export function proxyUrlFor(rule: RouteRule, config: Config): string | undefined {
  return rule.proxy ?? config.default.proxy;
}
