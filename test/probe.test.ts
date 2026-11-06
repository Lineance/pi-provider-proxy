import { describe, expect, it, vi } from "vitest";

import { describeProbeError, formatProbeResult, probeProvider } from "../src/core/probe.js";
import type { Route } from "../src/core/resolve.js";

const ROUTE: Route = { kind: "proxy", url: "http://127.0.0.1:7890", reason: "providers[provider-a]" };

describe("probeProvider", () => {
  it("treats any HTTP status as a reachable route", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const fetchImpl = vi.fn(() => Promise.resolve({ status: 401, body: { cancel } } as unknown as Response));

    const result = await probeProvider({
      provider: "provider-a",
      baseUrl: "https://api.example.com",
      route: ROUTE,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(401);
    expect(result.route).toBe(ROUTE);
    expect(cancel).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("tolerates responses without a body", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ status: 204 } as unknown as Response));
    const result = await probeProvider({
      provider: "p",
      baseUrl: "https://p.test",
      route: ROUTE,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
  });

  it("reports transport failures with a description", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7890"), {
      name: "Error",
    });
    const fetchImpl = vi.fn(() => Promise.reject(failure));

    const result = await probeProvider({
      provider: "p",
      baseUrl: "https://p.test",
      route: ROUTE,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("describeProbeError", () => {
  it("explains timeouts", () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    expect(describeProbeError(timeout)).toMatch(/timeout — the route did not answer/);
  });

  it("explains refused connections", () => {
    const error = new Error("fetch failed");
    error.cause = new Error("connect ECONNREFUSED 127.0.0.1:7890");
    expect(describeProbeError(error)).toMatch(/is the proxy listening/);
  });

  it("explains DNS failures", () => {
    const error = new Error("fetch failed");
    error.cause = new Error("getaddrinfo ENOTFOUND api.example");
    expect(describeProbeError(error)).toMatch(/DNS failure/);
  });

  it("explains connect timeouts from undici", () => {
    expect(describeProbeError(new Error("Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)"))).toMatch(
      /nothing answered on TCP/,
    );
  });

  it("falls back to the plain message", () => {
    expect(describeProbeError(new Error("weird"))).toBe("Error: weird");
    expect(describeProbeError("just a string")).toBe("just a string");
  });
});

describe("formatProbeResult", () => {
  it("prints success with route and duration", () => {
    const text = formatProbeResult({
      provider: "provider-a",
      url: "https://api.example.com",
      route: ROUTE,
      ok: true,
      status: 200,
      durationMs: 42,
    });
    expect(text).toContain("✅ provider-a: HTTP 200");
    expect(text).toContain("via proxy http://127.0.0.1:7890");
    expect(text).toContain("42 ms");
  });

  it("prints failure with the error", () => {
    const text = formatProbeResult({
      provider: "p",
      url: "https://p.test",
      route: { kind: "direct", reason: "r" },
      ok: false,
      durationMs: 7,
      error: "boom",
    });
    expect(text).toContain("❌ p: boom via direct");
  });
});
