import { describe, expect, it } from "vitest";

import {
  buildConfig,
  DEFAULT_CONFIG,
  mergeRawConfig,
  parseConfigLayer,
  proxyUrlFor,
  serializeConfig,
  validateProxyUrl,
  type Config,
} from "../src/core/config.js";

describe("validateProxyUrl", () => {
  it("accepts http and https proxies", () => {
    expect(validateProxyUrl("http://127.0.0.1:7890")).toBeUndefined();
    expect(validateProxyUrl("https://proxy.example:8443")).toBeUndefined();
  });

  it("rejects socks and pac with an actionable message", () => {
    expect(validateProxyUrl("socks5://127.0.0.1:7898")).toMatch(/unsupported protocol socks5:/);
    expect(validateProxyUrl("socks5://127.0.0.1:7898")).toMatch(/mixed\/HTTP port/);
  });

  it("rejects garbage", () => {
    expect(validateProxyUrl("not a url")).toMatch(/invalid URL/);
    expect(validateProxyUrl("http://")).toMatch(/invalid URL|no host/);
  });
});

describe("parseConfigLayer", () => {
  it("accepts shorthand string rules", () => {
    const { value, issues } = parseConfigLayer({
      providers: { "provider-a": "proxy", "provider-b": "direct" },
      default: "inherit",
    });
    expect(issues).toEqual([]);
    expect(value.providers).toEqual({ "provider-a": { mode: "proxy" }, "provider-b": { mode: "direct" } });
    expect(value.default).toEqual({ mode: "inherit" });
  });

  it("accepts object rules with a proxy URL", () => {
    const { value, issues } = parseConfigLayer({
      providers: { relay: { mode: "proxy", proxy: "http://127.0.0.1:7890" } },
    });
    expect(issues).toEqual([]);
    expect(value.providers?.["relay"]).toEqual({ mode: "proxy", proxy: "http://127.0.0.1:7890" });
  });

  it("reports unknown keys with their JSON path", () => {
    const { issues } = parseConfigLayer({ providers: { a: { mode: "direct", extra: 1 } } });
    expect(issues).toEqual([{ path: "providers.a.extra", message: "unknown key" }]);
  });

  it("reports unknown modes and keeps parsing the rest", () => {
    const { value, issues } = parseConfigLayer({
      default: "nope",
      providers: { ok: "direct", bad: 42 },
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]?.path).toBe("default");
    expect(issues[1]?.path).toBe("providers.bad");
    expect(value.providers).toEqual({ ok: { mode: "direct" } });
    expect(value.default).toBeUndefined();
  });

  it("rejects non-object layers without throwing", () => {
    expect(parseConfigLayer([]).issues[0]?.message).toMatch(/must contain a JSON object/);
    expect(parseConfigLayer(undefined).issues).toEqual([]);
  });

  it("validates proxy URLs inside rules", () => {
    const { issues, value } = parseConfigLayer({ default: { mode: "proxy", proxy: "socks5://127.0.0.1:1" } });
    expect(issues[0]?.path).toBe("default.proxy");
    expect(value.default).toEqual({ mode: "proxy" });
  });

  it("validates statusLine and booleans", () => {
    const { issues } = parseConfigLayer({ statusLine: "sometimes", enabled: "yes", loopbackAlwaysDirect: 1 });
    expect(issues.map((issue) => issue.path).sort()).toEqual([
      "enabled",
      "loopbackAlwaysDirect",
      "statusLine",
    ]);
  });
});

describe("buildConfig", () => {
  it("applies defaults for an empty config", () => {
    const { config } = buildConfig([{ label: "global", raw: {} }]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("lets the project layer win per provider key", () => {
    const { config, layers } = buildConfig([
      { label: "global", raw: { providers: { a: "proxy", b: "direct" }, enabled: true } },
      { label: "project", raw: { providers: { b: "inherit" }, enabled: false } },
    ]);
    expect(config.providers).toEqual({ a: { mode: "proxy" }, b: { mode: "inherit" } });
    expect(config.enabled).toBe(false);
    expect(layers).toEqual(["global", "project"]);
  });

  it("prefixes issues with the layer label", () => {
    const { issues } = buildConfig([{ label: "~/.pi/agent/pi-provider-proxy.json", raw: { nope: true } }]);
    expect(issues[0]?.message).toContain("~/.pi/agent/pi-provider-proxy.json: unknown key");
  });
});

describe("mergeRawConfig", () => {
  it("keeps base keys that the override does not mention", () => {
    const merged = mergeRawConfig(
      { providers: { a: { mode: "direct" } } },
      { hosts: { "x.test": { mode: "proxy" } } },
    );
    expect(merged.providers).toEqual({ a: { mode: "direct" } });
    expect(merged.hosts).toEqual({ "x.test": { mode: "proxy" } });
  });
});

describe("proxyUrlFor", () => {
  const config: Config = { ...DEFAULT_CONFIG, default: { mode: "proxy", proxy: "http://127.0.0.1:7890" } };

  it("prefers the rule proxy", () => {
    expect(proxyUrlFor({ mode: "proxy", proxy: "http://127.0.0.1:1" }, config)).toBe("http://127.0.0.1:1");
  });

  it("falls back to the default proxy", () => {
    expect(proxyUrlFor({ mode: "proxy" }, config)).toBe("http://127.0.0.1:7890");
  });
});

describe("serializeConfig", () => {
  it("round-trips through parseConfigLayer", () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      providers: { b: { mode: "direct" }, a: { mode: "proxy", proxy: "http://127.0.0.1:7890" } },
      hosts: { "*.internal.test": { mode: "direct" } },
    };

    const body = serializeConfig(config);
    expect(body).toContain('"$schema"');
    // providers are sorted for stable diffs
    expect(body.indexOf('"a"')).toBeLessThan(body.indexOf('"b"'));

    const { value, issues } = parseConfigLayer(JSON.parse(body));
    expect(issues).toEqual([]);
    expect(value.providers).toEqual({
      a: { mode: "proxy", proxy: "http://127.0.0.1:7890" },
      b: { mode: "direct" },
    });
    expect(value.default).toEqual({ mode: "inherit" });
    expect(value.hosts).toEqual({ "*.internal.test": { mode: "direct" } });
  });

  it("omits empty maps", () => {
    expect(serializeConfig(DEFAULT_CONFIG)).not.toContain('"providers"');
  });
});
