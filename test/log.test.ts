import { afterEach, describe, expect, it, vi } from "vitest";

import { debug, debugEnabled, warn } from "../src/core/log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("debugEnabled", () => {
  it.each(["1", "true", "YES", " yes "])("accepts %s", (value) => {
    expect(debugEnabled({ PI_PROVIDER_PROXY_DEBUG: value })).toBe(true);
  });

  it.each([undefined, "", "0", "false", "nope"])("rejects %s", (value) => {
    expect(debugEnabled(value === undefined ? {} : { PI_PROVIDER_PROXY_DEBUG: value })).toBe(false);
  });
});

describe("debug", () => {
  it("writes nothing unless enabled", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    delete process.env["PI_PROVIDER_PROXY_DEBUG"];
    debug("silent");
    expect(write).not.toHaveBeenCalled();
  });

  it("writes a prefixed line with string and structured details", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env["PI_PROVIDER_PROXY_DEBUG"] = "1";
    try {
      debug("route", "api.test", { mode: "direct" }, 3);
    } finally {
      delete process.env["PI_PROVIDER_PROXY_DEBUG"];
    }
    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0]?.[0];
    expect(String(line)).toContain("[pi-provider-proxy] route api.test");
    expect(String(line)).toContain('{"mode":"direct"}');
    expect(String(line)).toContain("3");
  });

  it("survives values that cannot be stringified", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env["PI_PROVIDER_PROXY_DEBUG"] = "1";
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    try {
      debug("circular", circular);
    } finally {
      delete process.env["PI_PROVIDER_PROXY_DEBUG"];
    }
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain("circular");
  });
});

describe("warn", () => {
  it("always writes", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    delete process.env["PI_PROVIDER_PROXY_DEBUG"];
    warn("careful");
    expect(String(write.mock.calls[0]?.[0])).toBe("[pi-provider-proxy] careful\n");
  });
});
