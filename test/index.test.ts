import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import piProviderProxy from "../src/index.js";
import { createFakeApi, createFakeContext, modelsFor } from "./fixtures/fake-pi.js";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "ppp-index-"));
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["PI_PROVIDER_PROXY_DISABLE"] = "1";
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  delete process.env["PI_CODING_AGENT_DIR"];
  delete process.env["PI_PROVIDER_PROXY_DISABLE"];
});

const MODELS = modelsFor({
  "provider-a": "https://api.example.com",
  "provider-b": "https://api.example.net/v1",
});

async function fire(
  handlers: Map<string, ((event: never, ctx: ExtensionContext) => unknown)[]>,
  name: string,
  ctx: ExtensionContext,
): Promise<void> {
  for (const handler of handlers.get(name) ?? []) {
    await handler(undefined as never, ctx);
  }
}

describe("extension entry point", () => {
  it("registers the /proxy command and lifecycle handlers", () => {
    const fake = createFakeApi();
    piProviderProxy(fake.api);

    expect(fake.registeredCommands).toContain("proxy");
    expect([...fake.handlers.keys()].sort()).toEqual([
      "agent_start",
      "model_select",
      "session_shutdown",
      "session_start",
    ]);
  });

  it("installs nothing when disabled by env, and survives session_start", async () => {
    const fake = createFakeApi();
    piProviderProxy(fake.api);
    const { ctx, ui } = createFakeContext({ models: MODELS, cwd: agentDir });

    await fire(fake.handlers, "session_start", ctx);
    expect(ui.notifications).toEqual([]);

    await fire(fake.handlers, "agent_start", ctx);
    await fire(fake.handlers, "model_select", ctx);
    await fire(fake.handlers, "session_shutdown", ctx);
    expect(ui.notifications).toEqual([]);
  });

  it("summarises explicit rules in the footer status", async () => {
    writeFileSync(
      join(agentDir, "pi-provider-proxy.json"),
      JSON.stringify({ providers: { "provider-a": "proxy", "provider-b": "direct" } }),
    );

    const fake = createFakeApi();
    piProviderProxy(fake.api);
    const { ctx, ui } = createFakeContext({ models: MODELS, cwd: agentDir });

    await fire(fake.handlers, "session_start", ctx);
    // direct rules are hidden by default: only the proxied provider is advertised
    expect(ui.statuses.get("provider-proxy")).toBe("proxy · provider-a→p:?");
  });

  it("warns once about config problems", async () => {
    writeFileSync(
      join(agentDir, "pi-provider-proxy.json"),
      JSON.stringify({ providers: { a: "sideways" }, huh: 1 }),
    );

    const fake = createFakeApi();
    piProviderProxy(fake.api);
    const { ctx, ui } = createFakeContext({ models: MODELS, cwd: agentDir });

    await fire(fake.handlers, "session_start", ctx);
    expect(ui.notifications).toHaveLength(1);
    expect(ui.notifications[0]?.type).toBe("warning");
    expect(ui.notifications[0]?.message).toContain("config problems");
    expect(ui.notifications[0]?.message).toContain("providers.a");
  });

  it("does not register a status line when statusLine is off", async () => {
    writeFileSync(
      join(agentDir, "pi-provider-proxy.json"),
      JSON.stringify({ statusLine: "off", providers: { "provider-a": "direct" } }),
    );

    const fake = createFakeApi();
    piProviderProxy(fake.api);
    const { ctx, ui } = createFakeContext({ models: MODELS, cwd: agentDir });

    await fire(fake.handlers, "session_start", ctx);
    expect(ui.statuses.get("provider-proxy")).toBeUndefined();
  });
});
