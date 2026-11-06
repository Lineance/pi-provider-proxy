/**
 * Footer status line.
 *
 * Defaults are deliberately quiet:
 * - `direct` rules are not advertised (they are the "nothing special" case),
 *   unless `statusLineShowDirect` is enabled.
 * - `auto` only renders when at least one provider is actually routed through a
 *   proxy, so a machine without proxy rules keeps a clean footer.
 * - `off` removes the line entirely.
 */
import { describeRule } from "../core/resolve.js";
import type { Config, RouteRule } from "../core/config.js";
import type { ProxyRuntime } from "./runtime.js";

const MAX_LENGTH = 96;

export interface StatusLineOptions {
  maxLength?: number | undefined;
}

export function renderStatusLine(runtime: ProxyRuntime, options: StatusLineOptions = {}): string {
  const maxLength = options.maxLength ?? MAX_LENGTH;
  const config = runtime.config;
  const mode = config.statusLine;
  if (mode === "off") return "";

  const rules = Object.entries(config.providers)
    .filter(([, rule]) => shouldRender(rule, config))
    .sort(([a], [b]) => a.localeCompare(b));

  const install = runtime.installState();

  // `auto` stays silent unless something is actually proxied or broken.
  if (mode === "auto" && rules.length === 0 && install.status !== "failed" && config.enabled) return "";

  const parts: string[] = [config.enabled ? "proxy" : "proxy off"];
  for (const [provider, rule] of rules) {
    parts.push(`${provider}→${compactRule(rule)}`);
  }
  if (parts.length === 1) parts.push(describeRule(config.default));
  if (install.status === "failed") parts.push("install failed");

  return truncate(parts.join(" · "), maxLength);
}

/** `direct` rules only appear when explicitly requested via `statusLineShowDirect`. */
function shouldRender(rule: RouteRule, config: Config): boolean {
  if (rule.mode === "direct" && !config.statusLineShowDirect) return false;
  if (rule.mode === "inherit") return config.statusLineShowDirect;
  return true;
}

function compactRule(rule: RouteRule): string {
  if (rule.mode !== "proxy") return rule.mode;
  return `p${portOf(rule.proxy)}`;
}

function portOf(proxyUrl: string | undefined): string {
  if (proxyUrl === undefined) return ":?";
  try {
    const url = new URL(proxyUrl);
    return url.port === "" ? url.hostname : `:${url.port}`;
  } catch {
    return ":?";
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
