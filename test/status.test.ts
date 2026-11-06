import { describe, expect, it } from "vitest";

import { renderStatusLine } from "../src/extension/status.js";
import type { ProxyRuntime } from "../src/extension/runtime.js";
import { DEFAULT_CONFIG, type Config, type RouteRule } from "../src/core/config.js";

interface FakeRuntime {
  config: Config;
  installState(): { status: "installed"; undiciPath: string; affectsPi: boolean };
}

function runtime(config: Partial<Config> = {}): ProxyRuntime {
  const fake: FakeRuntime = {
    config: { ...DEFAULT_CONFIG, ...config },
    installState: () => ({ status: "installed", undiciPath: "/x/undici/index.js", affectsPi: true }),
  };
  return fake as unknown as ProxyRuntime;
}

const PROXY = "http://127.0.0.1:7890";
const proxied: Record<string, RouteRule> = { "provider-a": { mode: "proxy", proxy: PROXY } };
const direct: Record<string, RouteRule> = { "provider-b": { mode: "direct" } };
const mixed: Record<string, RouteRule> = { ...direct, ...proxied };

describe("renderStatusLine", () => {
  it("stays silent in auto mode when nothing is proxied", () => {
    expect(renderStatusLine(runtime({ providers: direct }))).toBe("");
    expect(renderStatusLine(runtime())).toBe("");
  });

  it("hides direct rules by default", () => {
    expect(renderStatusLine(runtime({ providers: mixed }))).toBe("proxy · provider-a→p:7890");
  });

  it("shows direct rules when statusLineShowDirect is on", () => {
    const line = renderStatusLine(runtime({ providers: mixed, statusLineShowDirect: true }));
    expect(line).toContain("provider-a→p:7890");
    expect(line).toContain("provider-b→direct");
  });

  it("always mode renders even without proxy rules", () => {
    expect(renderStatusLine(runtime({ providers: direct, statusLine: "always" }))).toBe("proxy · inherit");
  });

  it("off mode renders nothing", () => {
    expect(renderStatusLine(runtime({ providers: mixed, statusLine: "off" }))).toBe("");
  });

  it("reports the master switch", () => {
    // turning the extension off is worth advertising, even in auto mode
    expect(renderStatusLine(runtime({ providers: proxied, enabled: false }))).toBe(
      "proxy off · provider-a→p:7890",
    );
  });

  it("reports an install failure", () => {
    const fake = runtime({ providers: proxied }) as unknown as { installState: () => unknown };
    fake.installState = () => ({ status: "failed", reason: "no undici", attempts: [] });
    expect(renderStatusLine(fake as unknown as ProxyRuntime)).toContain("install failed");
  });

  it("truncates long lines", () => {
    const providers: Record<string, RouteRule> = {};
    for (let index = 0; index < 12; index += 1) {
      providers[`provider-${String(index)}`] = { mode: "proxy", proxy: PROXY };
    }
    const line = renderStatusLine(runtime({ providers }), { maxLength: 40 });
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith("…")).toBe(true);
  });

  it("shows a placeholder port for a proxy rule without URL", () => {
    const line = renderStatusLine(runtime({ providers: { "provider-a": { mode: "proxy" } } }));
    expect(line).toBe("proxy · provider-a→p:?");
  });
});
