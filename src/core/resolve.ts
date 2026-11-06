/**
 * Pure routing decision: given a request host, decide direct / proxy / inherit.
 *
 * Everything here is synchronous and side-effect free so the whole rule matrix
 * is unit testable without a network or a pi process.
 */
import { proxyUrlFor, type Config, type RouteRule } from "./config.js";

export type Route =
  | { kind: "direct"; reason: string }
  | { kind: "proxy"; url: string; reason: string }
  | { kind: "inherit"; reason: string };

export interface ResolveContext {
  config: Config;
  /** host → every provider that uses it, built from pi's model registry. */
  hostToProviders: ReadonlyMap<string, readonly string[]>;
}

const IPV4_PRIVATE_PATTERNS: readonly RegExp[] = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^169\.254\./, // link-local
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT / Tailscale 100.64.0.0/10
  /^0\.0\.0\.0$/,
];

const IPV4_172_PRIVATE = /^172\.(\d{1,3})\./;

/** Lowercase, drop brackets, drop a single trailing dot. */
export function normalizeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  return normalized;
}

/** Loopback, link-local, RFC1918 and `.local` style names. */
export function isLocalHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === "") return false;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique-local
  for (const pattern of IPV4_PRIVATE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  const match172 = IPV4_172_PRIVATE.exec(normalized);
  if (match172?.[1] !== undefined) {
    const second = Number.parseInt(match172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  return false;
}

/**
 * Match a host against a rule key.
 *
 * Supported forms: `api.example.com`, `*.example.com`, `*`.
 */
export function matchesPattern(host: string, pattern: string): boolean {
  const normalized = normalizeHost(host);
  const candidate = normalizeHost(pattern);
  if (candidate === "*") return true;
  if (candidate.startsWith("*.")) {
    const suffix = candidate.slice(1); // ".example.com"
    return normalized === candidate.slice(2) || normalized.endsWith(suffix);
  }
  return normalized === candidate;
}

/** Find the most specific matching key in a rule map. */
export function findRuleKey(host: string, rules: Record<string, RouteRule>): string | undefined {
  const normalized = normalizeHost(host);
  if (rules[normalized] !== undefined) return normalized;

  let bestKey: string | undefined;
  for (const key of Object.keys(rules)) {
    if (!matchesPattern(normalized, key)) continue;
    if (key === "*") {
      bestKey ??= key;
      continue;
    }
    if (bestKey === undefined || key.length > bestKey.length) bestKey = key;
  }
  return bestKey;
}

function routeFromRule(rule: RouteRule, config: Config, reason: string): Route {
  switch (rule.mode) {
    case "direct":
      return { kind: "direct", reason };
    case "inherit":
      return { kind: "inherit", reason };
    case "proxy": {
      const url = proxyUrlFor(rule, config);
      if (!url) {
        return {
          kind: "inherit",
          reason: `${reason} requested proxy but no proxy URL is configured (set default.proxy or a rule proxy)`,
        };
      }
      return { kind: "proxy", url, reason };
    }
    default: {
      const exhaustive: never = rule.mode;
      return { kind: "inherit", reason: `unknown mode ${String(exhaustive)}` };
    }
  }
}

/**
 * Resolve the route for a host.
 *
 * Precedence: disabled → private/loopback guard → `hosts` rule → provider rule
 * → default rule → inherit.
 */
export function resolveRoute(host: string, context: ResolveContext): Route {
  const { config } = context;
  const normalized = normalizeHost(host);

  if (!config.enabled) return { kind: "inherit", reason: "extension disabled" };

  if (config.loopbackAlwaysDirect && isLocalHost(normalized)) {
    return { kind: "direct", reason: "private/loopback host" };
  }

  const hostKey = findRuleKey(normalized, config.hosts);
  if (hostKey !== undefined) {
    const rule = config.hosts[hostKey];
    if (rule) return routeFromRule(rule, config, `hosts[${hostKey}]`);
  }

  // A host can belong to several providers (several APIs behind one gateway).
  // The first claimant with an explicit rule wins; otherwise the default applies.
  for (const provider of providersForHost(normalized, context)) {
    const rule = config.providers[provider];
    if (rule) return routeFromRule(rule, config, `providers[${provider}]`);
  }

  return routeFromRule(config.default, config, "default");
}

/** Every provider that uses this host. */
export function providersForHost(host: string, context: ResolveContext): readonly string[] {
  return context.hostToProviders.get(normalizeHost(host)) ?? [];
}

/** Human readable explanation, used by `/proxy why`. */
export function explainRoute(host: string, context: ResolveContext): string[] {
  const normalized = normalizeHost(host);
  const providers = providersForHost(normalized, context);
  const route = resolveRoute(normalized, context);
  const lines = [
    `host: ${normalized}`,
    `provider: ${providers.length > 0 ? providers.join(", ") : "(unknown — no model uses this host)"}`,
    `extension: ${context.config.enabled ? "enabled" : "disabled"}`,
    `route: ${formatRoute(route)}`,
    `reason: ${route.reason}`,
    `default: ${describeRule(context.config.default)}`,
  ];
  for (const provider of providers) {
    const rule = context.config.providers[provider];
    lines.push(`provider rule [${provider}]: ${rule ? describeRule(rule) : "(none)"}`);
  }
  if (route.kind === "inherit") {
    lines.push(
      "inherit delegates to pi's own dispatcher: settings.httpProxy / HTTP_PROXY / HTTPS_PROXY / NO_PROXY still apply",
    );
  }
  return lines;
}

export function describeRule(rule: RouteRule): string {
  return rule.proxy === undefined ? rule.mode : `${rule.mode} via ${rule.proxy}`;
}

export function formatRoute(route: Route): string {
  switch (route.kind) {
    case "direct":
      return "direct";
    case "proxy":
      return `proxy ${route.url}`;
    case "inherit":
      return "inherit (pi global settings)";
    default: {
      const exhaustive: never = route;
      return String(exhaustive);
    }
  }
}
