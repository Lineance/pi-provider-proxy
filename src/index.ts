/**
 * pi-provider-proxy — per-provider proxy routing for pi.
 *
 * Entry point only: all behaviour lives in `extension/runtime.ts` (state),
 * `extension/commands.ts` (`/proxy`) and `core/*` (routing + dispatcher).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { debug } from "./core/log.js";
import { registerProxyCommand } from "./extension/commands.js";
import { ProxyRuntime } from "./extension/runtime.js";
import { renderStatusLine } from "./extension/status.js";

const STATUS_KEY = "provider-proxy";

export default function piProviderProxy(api: ExtensionAPI): void {
  const runtime = new ProxyRuntime({ api });

  const setStatus = (ctx: ExtensionContext): void => {
    try {
      ctx.ui.setStatus(STATUS_KEY, renderStatusLine(runtime) || undefined);
    } catch {
      // Status is cosmetic; never let it break a session.
    }
  };

  registerProxyCommand(api, runtime);

  api.on("session_start", async (_event, ctx) => {
    await runtime.refresh(ctx);
    setStatus(ctx);
    reportConfigIssues(runtime, ctx);
    debug("session_start", runtime.installState().status);
  });

  // Cheap identity check: reinstalls the dispatcher if pi (or another
  // extension) replaced it after startup or after a settings change.
  api.on("agent_start", async (_event, ctx) => {
    await runtime.ensureInstalled(ctx);
  });

  api.on("model_select", (_event, ctx) => {
    setStatus(ctx);
  });

  api.on("session_shutdown", async () => {
    await runtime.uninstall();
  });
}

function reportConfigIssues(runtime: ProxyRuntime, ctx: ExtensionContext): void {
  if (runtime.issues.length === 0) return;
  const lines = [
    "pi-provider-proxy: config problems",
    ...runtime.issues.map((issue) => `  ${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`),
  ];
  ctx.ui.notify(lines.join("\n"), "warning");
}
