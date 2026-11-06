import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type Config, type RouteRule } from "../src/core/config.js";
import {
  describeRule,
  explainRoute,
  findRuleKey,
  formatRoute,
  isLocalHost,
  matchesPattern,
  normalizeHost,
  resolveRoute,
} from "../src/core/resolve.js";

function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function index(entries: Record<string, string> = {}): Map<string, string[]> {
  return new Map(Object.entries(entries).map(([host, provider]) => [host, [provider]]));
}

function sharedIndex(host: string, providers: readonly string[]): Map<string, string[]> {
  return new Map([[host, [...providers]]]);
}

const PROXY = "http://127.0.0.1:7890";

describe("normalizeHost", () => {
  it("lowercases, strips brackets and a trailing dot", () => {
    expect(normalizeHost("API.Example.COM.")).toBe("api.example.com");
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("  example.com  ")).toBe("example.com");
  });
});

describe("isLocalHost", () => {
  it.each([
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "127.9.9.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.1.1",
    "100.101.102.103",
    "::1",
    "fe80::1",
    "fd00::1",
    "printer.local",
    "service.internal",
  ])("treats %s as private", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(["172.15.0.1", "172.32.0.1", "8.8.8.8", "100.128.0.1", "api.example.com"])(
    "treats %s as public",
    (host) => {
      expect(isLocalHost(host)).toBe(false);
    },
  );
});

describe("matchesPattern", () => {
  it("matches exact, wildcard and catch-all patterns", () => {
    expect(matchesPattern("api.example.com", "api.example.com")).toBe(true);
    expect(matchesPattern("API.Example.com", "api.example.com")).toBe(true);
    expect(matchesPattern("a.b.example.com", "*.example.com")).toBe(true);
    expect(matchesPattern("example.com", "*.example.com")).toBe(true);
    expect(matchesPattern("anything.test", "*")).toBe(true);
    expect(matchesPattern("nope.test", "*.example.com")).toBe(false);
  });
});

describe("findRuleKey", () => {
  it("prefers exact keys, then the longest wildcard, then *", () => {
    const rules: Record<string, RouteRule> = {
      "*": { mode: "proxy" },
      "*.example.com": { mode: "direct" },
      "api.example.com": { mode: "inherit" },
    };
    expect(findRuleKey("api.example.com", rules)).toBe("api.example.com");
    expect(findRuleKey("cdn.example.com", rules)).toBe("*.example.com");
    expect(findRuleKey("other.test", rules)).toBe("*");
  });

  it("returns undefined when nothing matches", () => {
    expect(findRuleKey("a.test", { "b.test": { mode: "direct" } })).toBeUndefined();
  });
});

describe("resolveRoute precedence", () => {
  it("inherits when the extension is disabled", () => {
    const route = resolveRoute("api.example.com", {
      config: config({ enabled: false, providers: { "provider-a": { mode: "proxy", proxy: PROXY } } }),
      hostToProviders: index({ "api.example.com": "provider-a" }),
    });
    expect(route).toEqual({ kind: "inherit", reason: "extension disabled" });
  });

  it("always sends loopback traffic direct", () => {
    const route = resolveRoute("localhost", {
      config: config({ providers: { local: { mode: "proxy", proxy: PROXY } } }),
      hostToProviders: index({ localhost: "local" }),
    });
    expect(route).toEqual({ kind: "direct", reason: "private/loopback host" });
  });

  it("honours loopbackAlwaysDirect: false", () => {
    const route = resolveRoute("127.0.0.1", {
      config: config({
        loopbackAlwaysDirect: false,
        hosts: { "127.0.0.1": { mode: "proxy", proxy: PROXY } },
      }),
      hostToProviders: index(),
    });
    expect(route).toEqual({ kind: "proxy", url: PROXY, reason: "hosts[127.0.0.1]" });
  });

  it("lets a host rule beat a provider rule", () => {
    const route = resolveRoute("api.example.com", {
      config: config({
        hosts: { "api.example.com": { mode: "direct" } },
        providers: { "provider-a": { mode: "proxy", proxy: PROXY } },
      }),
      hostToProviders: index({ "api.example.com": "provider-a" }),
    });
    expect(route.kind).toBe("direct");
    expect(route.reason).toBe("hosts[api.example.com]");
  });

  it("applies a rule from a secondary claimant of a shared host", () => {
    const route = resolveRoute("api.example.net", {
      config: config({ providers: { "provider-b": { mode: "direct" } } }),
      hostToProviders: sharedIndex("api.example.net", ["provider-c", "provider-b"]),
    });
    expect(route).toEqual({ kind: "direct", reason: "providers[provider-b]" });
  });

  it("prefers the first claimant when several have rules", () => {
    const route = resolveRoute("shared.test", {
      config: config({
        providers: { a: { mode: "direct" }, b: { mode: "proxy", proxy: PROXY } },
      }),
      hostToProviders: sharedIndex("shared.test", ["a", "b"]),
    });
    expect(route.reason).toBe("providers[a]");
  });

  it("applies the provider rule via the model catalogue", () => {
    const route = resolveRoute("api.example.com", {
      config: config({ providers: { "provider-a": { mode: "proxy", proxy: PROXY } } }),
      hostToProviders: index({ "api.example.com": "provider-a" }),
    });
    expect(route).toEqual({ kind: "proxy", url: PROXY, reason: "providers[provider-a]" });
  });

  it("falls back to the default rule for unknown hosts", () => {
    const route = resolveRoute("example.test", {
      config: config({ default: { mode: "proxy", proxy: PROXY } }),
      hostToProviders: index(),
    });
    expect(route).toEqual({ kind: "proxy", url: PROXY, reason: "default" });
  });

  it("uses the default proxy URL for a proxy rule without one", () => {
    const route = resolveRoute("api.test", {
      config: config({ default: { mode: "proxy", proxy: PROXY }, providers: { p: { mode: "proxy" } } }),
      hostToProviders: index({ "api.test": "p" }),
    });
    expect(route).toEqual({ kind: "proxy", url: PROXY, reason: "providers[p]" });
  });

  it("degrades to inherit when a proxy rule has no URL anywhere", () => {
    const route = resolveRoute("api.test", {
      config: config({ providers: { p: { mode: "proxy" } } }),
      hostToProviders: index({ "api.test": "p" }),
    });
    expect(route.kind).toBe("inherit");
    expect(route.reason).toMatch(/no proxy URL is configured/);
  });

  it("normalizes the host before matching", () => {
    const route = resolveRoute("API.Example.COM.", {
      config: config({ providers: { "provider-a": { mode: "direct" } } }),
      hostToProviders: index({ "api.example.com": "provider-a" }),
    });
    expect(route.kind).toBe("direct");
  });
});

describe("formatting helpers", () => {
  it("describes rules and routes", () => {
    expect(describeRule({ mode: "proxy", proxy: PROXY })).toBe(`proxy via ${PROXY}`);
    expect(describeRule({ mode: "direct" })).toBe("direct");
    expect(formatRoute({ kind: "inherit", reason: "default" })).toMatch(/inherit/);
    expect(formatRoute({ kind: "proxy", url: PROXY, reason: "x" })).toBe(`proxy ${PROXY}`);
    expect(formatRoute({ kind: "direct", reason: "x" })).toBe("direct");
  });

  it("explains a host decision", () => {
    const lines = explainRoute("api.example.com", {
      config: config({ providers: { "provider-a": { mode: "proxy", proxy: PROXY } } }),
      hostToProviders: index({ "api.example.com": "provider-a" }),
    });
    expect(lines.join("\n")).toContain("provider: provider-a");
    expect(lines.join("\n")).toContain(`route: proxy ${PROXY}`);
  });

  it("explains inherit semantics", () => {
    const lines = explainRoute("api.unknown.test", { config: config(), hostToProviders: index() }).join("\n");
    expect(lines).toContain("no model uses this host");
    expect(lines).toContain("inherit delegates to pi");
  });
});
