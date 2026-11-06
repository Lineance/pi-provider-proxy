import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleCommand, parseArgs, parseRuleArgs } from "../src/extension/commands.js";
import { ProxyRuntime } from "../src/extension/runtime.js";
import { createFakeApi, createFakeContext, modelsFor } from "./fixtures/fake-pi.js";

const PROXY = "http://127.0.0.1:7890";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "ppp-cmd-"));
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["PI_PROVIDER_PROXY_DISABLE"] = "1"; // keep the real dispatcher untouched
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  delete process.env["PI_CODING_AGENT_DIR"];
  delete process.env["PI_PROVIDER_PROXY_DISABLE"];
});

function runtimeWith(models: Record<string, string>): ProxyRuntime {
  const { api } = createFakeApi();
  const runtime = new ProxyRuntime({ api, env: process.env });
  const { ctx } = createFakeContext({ models: modelsFor(models), cwd: agentDir });
  // refresh() is async; tests await it explicitly where it matters.
  void runtime.refresh(ctx);
  return runtime;
}

async function freshRuntime(models: Record<string, string>): Promise<ProxyRuntime> {
  const { api } = createFakeApi();
  const runtime = new ProxyRuntime({ api, env: process.env });
  const { ctx } = createFakeContext({ models: modelsFor(models), cwd: agentDir });
  await runtime.refresh(ctx);
  return runtime;
}

describe("parseArgs", () => {
  it("splits positionals and targets", () => {
    expect(parseArgs("  provider-a proxy http://127.0.0.1:7890 --project ")).toEqual({
      positional: ["provider-a", "proxy", PROXY],
      target: "project",
    });
  });

  it("defaults to the global target", () => {
    expect(parseArgs("on").target).toBe("global");
  });
});

describe("parseRuleArgs", () => {
  it("parses the three modes", () => {
    expect(parseRuleArgs(["direct"])).toEqual({ rule: { mode: "direct" } });
    expect(parseRuleArgs(["inherit"])).toEqual({ rule: { mode: "inherit" } });
    expect(parseRuleArgs(["proxy", PROXY])).toEqual({ rule: { mode: "proxy", proxy: PROXY } });
  });

  it("rejects missing or invalid arguments", () => {
    expect(parseRuleArgs([]).error).toMatch(/missing mode/);
    expect(parseRuleArgs(["sideways"]).error).toMatch(/unknown mode/);
    expect(parseRuleArgs(["direct", PROXY]).error).toMatch(/takes no proxy URL/);
    expect(parseRuleArgs(["proxy"]).error).toMatch(/needs a proxy URL/);
    expect(parseRuleArgs(["proxy", "socks5://127.0.0.1:1"]).error).toMatch(/unsupported protocol/);
  });
});

describe("/proxy command", () => {
  it("prints an overview with providers and their effective routes", async () => {
    const runtime = await freshRuntime({
      "provider-a": "https://api.example.com",
      "provider-b": "https://api.example.net/v1",
    });
    const { ctx, ui } = createFakeContext({ models: modelsFor({ "provider-a": "https://api.example.com" }) });

    await handleCommand(runtime, "", ctx);

    const output = ui.notifications.map((entry) => entry.message).join("\n");
    expect(output).toContain("pi-provider-proxy");
    expect(output).toContain("provider-b");
    expect(output).toContain("default: inherit");
  });

  it("sets a provider rule and persists it to the global file", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const { ctx, ui } = createFakeContext({ models: modelsFor({ "provider-a": "https://api.example.com" }) });

    await handleCommand(runtime, `provider-a proxy ${PROXY}`, ctx);

    expect(ui.notifications.at(-1)?.message).toContain(`provider-a → proxy via ${PROXY}`);
    expect(runtime.config.providers["provider-a"]).toEqual({ mode: "proxy", proxy: PROXY });
    expect(existsSync(join(agentDir, "pi-provider-proxy.json"))).toBe(true);
  });

  it("removes a rule with inherit and updates the status line", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const { ctx, ui } = createFakeContext({ models: modelsFor({ "provider-a": "https://api.example.com" }) });

    await handleCommand(runtime, `provider-a proxy ${PROXY}`, ctx);
    await handleCommand(runtime, "provider-a inherit", ctx);

    expect(runtime.config.providers["provider-a"]).toBeUndefined();
    expect(ui.statuses.get("provider-proxy")).toBeUndefined();
  });

  it("switches the master flag", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const { ctx, ui } = createFakeContext({ models: modelsFor({ "provider-a": "https://api.example.com" }) });

    await handleCommand(runtime, "off", ctx);
    expect(runtime.config.enabled).toBe(false);
    expect(ui.statuses.get("provider-proxy")).toContain("proxy off");

    await handleCommand(runtime, "on", ctx);
    expect(runtime.config.enabled).toBe(true);
  });

  it("writes to the project layer on request", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const projectCwd = mkdtempSync(join(tmpdir(), "ppp-proj-"));
    try {
      const { ctx } = createFakeContext({
        models: modelsFor({ "provider-a": "https://api.example.com" }),
        cwd: projectCwd,
        projectTrusted: true,
      });
      await runtime.refresh(ctx);
      await handleCommand(runtime, "provider-b direct --project", ctx);
      expect(existsSync(join(projectCwd, ".pi", "pi-provider-proxy.json"))).toBe(true);
    } finally {
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it("reports invalid input without throwing", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const { ctx, ui } = createFakeContext({});

    await handleCommand(runtime, "provider-a sideways", ctx);
    expect(ui.notifications.at(-1)?.type).toBe("error");
    expect(ui.notifications.at(-1)?.message).toMatch(/unknown mode/);

    await handleCommand(runtime, "host", ctx);
    expect(ui.notifications.at(-1)?.message).toMatch(/\/proxy host/);

    await handleCommand(runtime, "test", ctx);
    expect(ui.notifications.at(-1)?.message).toMatch(/\/proxy test/);

    await handleCommand(runtime, "why", ctx);
    expect(ui.notifications.at(-1)?.message).toMatch(/\/proxy why/);
  });

  it("answers why/stats/detail queries", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const { ctx, ui } = createFakeContext({
      models: modelsFor({ "provider-a": "https://api.example.com" }),
    });

    await handleCommand(runtime, "why provider-a", ctx);
    expect(ui.notifications.at(-1)?.message).toContain("provider: provider-a");

    await handleCommand(runtime, "why api.example.com", ctx);
    expect(ui.notifications.at(-1)?.message).toContain("route: inherit");

    await handleCommand(runtime, "provider-a", ctx);
    expect(ui.notifications.at(-1)?.message).toContain("provider: provider-a");

    await handleCommand(runtime, "stats", ctx);
    expect(ui.notifications.at(-1)?.message).toContain("direct 0");

    await handleCommand(runtime, "help", ctx);
    expect(ui.notifications.at(-1)?.message).toContain("/proxy test <provider>");
  });

  it("handles host rules and conflicts", async () => {
    const runtime = runtimeWith({ a: "https://shared.test/v1", b: "https://shared.test/v2" });
    const { ctx, ui } = createFakeContext({
      models: modelsFor({ a: "https://shared.test/v1", b: "https://shared.test/v2" }),
    });

    await handleCommand(runtime, "", ctx);
    expect(ui.notifications.at(-1)?.message).toContain("claimed by several providers");

    await handleCommand(runtime, `host shared.test proxy ${PROXY}`, ctx);
    expect(runtime.config.hosts["shared.test"]).toEqual({ mode: "proxy", proxy: PROXY });
    expect(ui.notifications.at(-1)?.message).toContain("hosts[shared.test]");
  });

  it("reports and edits the status-line settings", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const models = modelsFor({ "provider-a": "https://api.example.com" });
    const { ctx, ui } = createFakeContext({ models });

    await handleCommand(runtime, "provider-a proxy " + PROXY, ctx);
    await handleCommand(runtime, "status", ctx);
    const preview = ui.notifications.at(-1)?.message ?? "";
    expect(preview).toContain("status line: auto");
    expect(preview).toContain("direct rules shown: no");
    expect(preview).toContain("provider-a→p:7890");

    await handleCommand(runtime, "status always", ctx);
    expect(runtime.config.statusLine).toBe("always");

    await handleCommand(runtime, "status direct on", ctx);
    expect(runtime.config.statusLineShowDirect).toBe(true);

    await handleCommand(runtime, "status off", ctx);
    expect(runtime.config.statusLine).toBe("off");
    expect(ui.statuses.get("provider-proxy")).toBeUndefined();

    await handleCommand(runtime, "status sideways", ctx);
    expect(ui.notifications.at(-1)?.type).toBe("error");

    await handleCommand(runtime, "status direct maybe", ctx);
    expect(ui.notifications.at(-1)?.type).toBe("error");
  });

  it("shows the status-line mode in the overview", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const { ctx, ui } = createFakeContext({ models: modelsFor({ "provider-a": "https://api.example.com" }) });
    await handleCommand(runtime, "", ctx);
    expect(ui.notifications.at(-1)?.message).toContain("status line: auto (direct rules hidden)");
  });

  it("sets the default rule", async () => {
    const runtime = await freshRuntime({ "provider-a": "https://api.example.com" });
    const { ctx } = createFakeContext({ models: modelsFor({ "provider-a": "https://api.example.com" }) });

    await handleCommand(runtime, `default proxy ${PROXY}`, ctx);
    expect(runtime.config.default).toEqual({ mode: "proxy", proxy: PROXY });

    await handleCommand(runtime, "default", ctx);
    expect(runtime.installState()).toBeDefined();
  });
});
