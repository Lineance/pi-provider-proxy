/**
 * `/proxy` command: overview, switches, per-provider rules, probing, reload.
 *
 * Everything is text output through `ctx.ui.notify`, so the command works in the
 * TUI, in RPC mode, and in scripted runs without depending on dialogs.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { describeRule, formatRoute, matchesPattern, normalizeHost } from "../core/resolve.js";
import { validateProxyUrl, type RouteRule } from "../core/config.js";
import { formatProbeResult } from "../core/probe.js";
import { renderStatusLine } from "./status.js";
import type { ConfigTarget, ProxyRuntime } from "./runtime.js";

export const COMMAND_NAME = "proxy";

const USAGE = [
  "usage:",
  "  /proxy                        overview + effective routes",
  "  /proxy on | off               master switch (writes config)",
  "  /proxy reload                 re-read config and provider catalogue",
  "  /proxy default <mode> [url]   inherit | direct | proxy <url>",
  "  /proxy <provider> <mode> [url]",
  "  /proxy <provider> inherit    remove an explicit rule",
  "  /proxy host <host> <mode> [url]   rule for a raw host (escape hatch)",
  "  /proxy test <provider>        dial the provider baseUrl through the active route",
  "  /proxy why <host|provider>    explain which rule wins",
  "  /proxy stats                  counters since install",
  "  /proxy status                 show status-line settings + preview",
  "  /proxy status auto|always|off  when the footer line is rendered",
  "  /proxy status direct on|off   also list direct rules in the footer",
  "  append --project to write <cwd>/.pi/pi-provider-proxy.json instead of the global file",
].join("\n");

interface ParsedArgs {
  positional: string[];
  target: ConfigTarget;
}

export function parseArgs(raw: string): ParsedArgs {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  let target: ConfigTarget = "global";
  const positional: string[] = [];
  for (const token of tokens) {
    if (token === "--project" || token === "-p") {
      target = "project";
      continue;
    }
    if (token === "--global" || token === "-g") {
      target = "global";
      continue;
    }
    positional.push(token);
  }
  return { positional, target };
}

/** Parse `<mode> [url]` into a rule, or an error message. */
export function parseRuleArgs(args: readonly string[]): { rule?: RouteRule; error?: string } {
  const mode = args[0];
  if (mode === undefined) return { error: "missing mode (inherit | direct | proxy <url>)" };
  if (mode !== "inherit" && mode !== "direct" && mode !== "proxy") {
    return { error: `unknown mode "${mode}"; expected inherit, direct or proxy` };
  }
  if (mode !== "proxy") {
    if (args.length > 1) return { error: `mode "${mode}" takes no proxy URL` };
    return { rule: { mode } };
  }
  const url = args[1];
  if (url === undefined)
    return { error: "mode proxy needs a proxy URL, e.g. /proxy provider-a proxy http://127.0.0.1:7890" };
  const problem = validateProxyUrl(url);
  if (problem !== undefined) return { error: problem };
  return { rule: { mode: "proxy", proxy: url } };
}

export function registerProxyCommand(api: ExtensionAPI, runtime: ProxyRuntime): void {
  api.registerCommand(COMMAND_NAME, {
    description: "Per-provider proxy routing (show, switch, test)",
    getArgumentCompletions: (prefix: string) => {
      const suggestions = [
        "on",
        "off",
        "reload",
        "stats",
        "status",
        "default",
        "host",
        "test",
        "why",
        ...runtime.knownProviders.keys(),
      ];
      const filtered = suggestions
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      await handleCommand(runtime, args, ctx);
    },
  });
}

export async function handleCommand(
  runtime: ProxyRuntime,
  rawArgs: string,
  ctx: ExtensionContext,
): Promise<void> {
  const { positional, target } = parseArgs(rawArgs);
  const [first, ...rest] = positional;

  try {
    switch (first) {
      case undefined:
        ctx.ui.notify(renderOverview(runtime), "info");
        return;
      case "help":
        ctx.ui.notify(USAGE, "info");
        return;
      case "on":
      case "off": {
        runtime.setEnabled(first === "on", target);
        ctx.ui.notify(
          `pi-provider-proxy: ${first === "on" ? "enabled" : "disabled"} (saved to ${target} config)\n${renderStatusLine(runtime)}`,
          "info",
        );
        updateStatus(ctx, runtime);
        return;
      }
      case "reload": {
        await runtime.refresh(ctx);
        ctx.ui.notify(`pi-provider-proxy: reloaded\n${renderOverview(runtime)}`, "info");
        updateStatus(ctx, runtime);
        return;
      }
      case "stats": {
        ctx.ui.notify(`pi-provider-proxy: ${runtime.stats.summary()}`, "info");
        return;
      }
      case "status": {
        handleStatus(runtime, rest, target, ctx);
        return;
      }
      case "default": {
        const { rule, error } = parseRuleArgs(rest);
        if (rule === undefined) {
          ctx.ui.notify(`pi-provider-proxy: ${error ?? "invalid rule"}`, "error");
          return;
        }
        runtime.setDefaultRule(rule, target);
        ctx.ui.notify(`pi-provider-proxy: default → ${describeRule(rule)}`, "info");
        updateStatus(ctx, runtime);
        return;
      }
      case "host": {
        handleHostRule(runtime, rest, target, ctx);
        return;
      }
      case "test": {
        await handleTest(runtime, rest[0], ctx);
        return;
      }
      case "why": {
        handleWhy(runtime, rest[0], ctx);
        return;
      }
      default: {
        handleProviderRule(runtime, first, rest, target, ctx);
      }
    }
  } catch (error) {
    ctx.ui.notify(`pi-provider-proxy: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function handleProviderRule(
  runtime: ProxyRuntime,
  provider: string,
  rest: readonly string[],
  target: ConfigTarget,
  ctx: ExtensionContext,
): void {
  const mode = rest[0];
  if (mode === undefined) {
    ctx.ui.notify(renderProviderDetail(runtime, provider), "info");
    return;
  }

  if (mode === "inherit" && rest.length === 1) {
    runtime.setProviderRule(provider, undefined, target);
    ctx.ui.notify(`pi-provider-proxy: ${provider} → inherit (rule removed, saved to ${target})`, "info");
    updateStatus(ctx, runtime);
    return;
  }

  const { rule, error } = parseRuleArgs(rest);
  if (rule === undefined) {
    ctx.ui.notify(`pi-provider-proxy: ${error ?? "invalid rule"}`, "error");
    return;
  }
  if (mode === "inherit") {
    runtime.setProviderRule(provider, undefined, target);
    ctx.ui.notify(`pi-provider-proxy: ${provider} → inherit (rule removed, saved to ${target})`, "info");
    updateStatus(ctx, runtime);
    return;
  }

  runtime.setProviderRule(provider, rule, target);
  const route = runtime.routeForProvider(provider);
  ctx.ui.notify(
    `pi-provider-proxy: ${provider} → ${describeRule(rule)} (saved to ${target})` +
      (route === undefined
        ? "\nnote: no model in this session uses that provider"
        : `\neffective: ${formatRoute(route)}`),
    "info",
  );
  updateStatus(ctx, runtime);
}

function handleHostRule(
  runtime: ProxyRuntime,
  rest: readonly string[],
  target: ConfigTarget,
  ctx: ExtensionContext,
): void {
  const host = rest[0];
  if (host === undefined) {
    ctx.ui.notify("pi-provider-proxy: /proxy host <host> <mode> [url]", "error");
    return;
  }
  const normalized = normalizeHost(host);
  if (rest.length === 1) {
    ctx.ui.notify(`pi-provider-proxy: ${renderHostDetail(runtime, normalized)}`, "info");
    return;
  }
  if (rest[1] === "clear") {
    runtime.setHostRule(normalized, undefined, target);
    ctx.ui.notify(`pi-provider-proxy: hosts[${normalized}] removed`, "info");
    updateStatus(ctx, runtime);
    return;
  }
  const { rule, error } = parseRuleArgs(rest.slice(1));
  if (rule === undefined) {
    ctx.ui.notify(`pi-provider-proxy: ${error ?? "invalid rule"}`, "error");
    return;
  }
  runtime.setHostRule(normalized, rule, target);
  ctx.ui.notify(
    `pi-provider-proxy: hosts[${normalized}] → ${describeRule(rule)} (saved to ${target})\neffective: ${runtime.routeLabel(normalized)}`,
    "info",
  );
  updateStatus(ctx, runtime);
}

function handleStatus(
  runtime: ProxyRuntime,
  rest: readonly string[],
  target: ConfigTarget,
  ctx: ExtensionContext,
): void {
  const what = rest[0];
  const config = runtime.config;

  if (what === undefined) {
    const preview = renderStatusLine(runtime) || "(hidden)";
    ctx.ui.notify(
      [
        `pi-provider-proxy status line: ${config.statusLine}`,
        `direct rules shown: ${config.statusLineShowDirect ? "yes" : "no"}`,
        `preview: ${preview}`,
      ].join("\n"),
      "info",
    );
    return;
  }

  if (what === "direct") {
    const toggle = rest[1];
    if (toggle !== "on" && toggle !== "off") {
      ctx.ui.notify("pi-provider-proxy: /proxy status direct on|off", "error");
      return;
    }
    runtime.setStatusLine(config.statusLine, toggle === "on", target);
    ctx.ui.notify(
      `pi-provider-proxy: direct rules in footer → ${toggle === "on" ? "shown" : "hidden"}\n${renderStatusLine(runtime) || "(hidden)"}`,
      "info",
    );
    updateStatus(ctx, runtime);
    return;
  }

  if (what !== "auto" && what !== "always" && what !== "off") {
    ctx.ui.notify("pi-provider-proxy: /proxy status auto|always|off", "error");
    return;
  }

  runtime.setStatusLine(what, undefined, target);
  ctx.ui.notify(
    `pi-provider-proxy: status line → ${what}\n${renderStatusLine(runtime) || "(hidden)"}`,
    "info",
  );
  updateStatus(ctx, runtime);
}

async function handleTest(
  runtime: ProxyRuntime,
  provider: string | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  if (provider === undefined) {
    ctx.ui.notify("pi-provider-proxy: /proxy test <provider>", "error");
    return;
  }
  ctx.ui.setStatus("provider-proxy", `testing ${provider}…`);
  try {
    const result = await runtime.probe(provider);
    ctx.ui.notify(formatProbeResult(result), result.ok ? "info" : "warning");
  } finally {
    updateStatus(ctx, runtime);
  }
}

function handleWhy(runtime: ProxyRuntime, target: string | undefined, ctx: ExtensionContext): void {
  if (target === undefined) {
    ctx.ui.notify("pi-provider-proxy: /proxy why <host|provider>", "error");
    return;
  }
  const asProvider = runtime.providerHosts(target);
  if (asProvider.length > 0) {
    const lines = [`provider: ${target}`, `hosts: ${asProvider.join(", ")}`];
    for (const host of asProvider) lines.push("", ...runtime.explain(host));
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }
  ctx.ui.notify(runtime.explain(normalizeHost(target)).join("\n"), "info");
}

function renderOverview(runtime: ProxyRuntime): string {
  const paths = runtime.configPaths;
  const install = runtime.installState();
  const lines: string[] = [];

  lines.push(
    `pi-provider-proxy — ${runtime.config.enabled ? "enabled" : "disabled (all traffic inherits pi settings)"}`,
  );
  lines.push(
    install.status === "installed"
      ? `dispatcher: installed (undici ${shortenPath(install.undiciPath)})`
      : install.status === "failed"
        ? `dispatcher: FAILED — ${runtime.installStateText()}`
        : `dispatcher: ${install.reason}`,
  );
  lines.push(`default: ${describeRule(runtime.config.default)}`);
  lines.push(
    `status line: ${runtime.config.statusLine}${runtime.config.statusLineShowDirect ? " (direct rules shown)" : " (direct rules hidden)"}`,
  );
  lines.push(
    `config: ${shortenPath(paths.global)}${paths.projectLoaded ? ` + ${shortenPath(paths.project)}` : ""}`,
  );

  const providers = [...runtime.knownProviders.keys()].sort((a, b) => a.localeCompare(b));
  if (providers.length === 0) {
    lines.push("", "no providers known yet — run this inside a session with models configured");
  } else {
    lines.push("", "providers:");
    for (const provider of providers) {
      const rule = runtime.config.providers[provider];
      const route = runtime.routeForProvider(provider);
      const hosts = runtime.providerHosts(provider);
      const ruleText = rule === undefined ? "inherit" : describeRule(rule);
      lines.push(
        `  ${provider.padEnd(20)} ${ruleText.padEnd(28)} → ${route === undefined ? "?" : formatRoute(route)}  [${hosts.join(", ")}]`,
      );
    }
  }

  const hostKeys = Object.keys(runtime.config.hosts);
  if (hostKeys.length > 0) {
    lines.push("", "host rules:");
    for (const key of hostKeys.sort((a, b) => a.localeCompare(b))) {
      const rule = runtime.config.hosts[key];
      if (rule === undefined) continue;
      lines.push(`  ${key.padEnd(32)} ${describeRule(rule)}`);
    }
  }

  const conflicts = runtime.hostConflicts;
  if (conflicts.size > 0) {
    lines.push("", "warning: hosts claimed by several providers:");
    for (const [host, owners] of conflicts) {
      lines.push(`  ${host}: ${owners.join(", ")} — set an explicit host rule to disambiguate`);
    }
  }

  if (runtime.issues.length > 0) {
    lines.push("", "config problems:");
    for (const issue of runtime.issues) {
      lines.push(`  ${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`);
    }
  }

  lines.push("", `traffic: ${runtime.stats.summary()}`);
  return lines.join("\n");
}

function renderProviderDetail(runtime: ProxyRuntime, provider: string): string {
  const hosts = runtime.providerHosts(provider);
  if (hosts.length === 0) {
    return `pi-provider-proxy: unknown provider "${provider}"\nknown: ${[...runtime.knownProviders.keys()].join(", ") || "(none)"}`;
  }
  const lines = [`provider: ${provider}`, `hosts: ${hosts.join(", ")}`];
  for (const host of hosts) lines.push("", ...runtime.explain(host));
  return lines.join("\n");
}

function renderHostDetail(runtime: ProxyRuntime, host: string): string {
  const matched = Object.keys(runtime.config.hosts).filter((key) => matchesPattern(host, key));
  return [
    ...runtime.explain(host),
    `host rules matching: ${matched.length > 0 ? matched.join(", ") : "(none)"}`,
  ].join("\n");
}

function updateStatus(ctx: ExtensionContext, runtime: ProxyRuntime): void {
  try {
    ctx.ui.setStatus("provider-proxy", renderStatusLine(runtime) || undefined);
  } catch {
    // Status rendering must never break a command.
  }
}

function shortenPath(path: string): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  return home !== "" && path.startsWith(home) ? `~${path.slice(home.length).replace(/\\/g, "/")}` : path;
}
