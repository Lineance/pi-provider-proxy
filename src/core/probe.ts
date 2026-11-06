/**
 * Connectivity probe used by `/proxy test <provider>`.
 *
 * It goes through `globalThis.fetch`, i.e. through the installed router, so a
 * success proves the *actual* route works — not just that the proxy port is open.
 */
import type { Route } from "./resolve.js";
import { formatRoute } from "./resolve.js";

export interface ProbeTarget {
  provider: string;
  baseUrl: string;
  route: Route;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface ProbeResult {
  provider: string;
  url: string;
  route: Route;
  ok: boolean;
  status?: number | undefined;
  durationMs: number;
  error?: string | undefined;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

export async function probeProvider(target: ProbeTarget): Promise<ProbeResult> {
  const fetchImpl = target.fetchImpl ?? globalThis.fetch;
  const timeoutMs = target.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(target.baseUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "*/*", "user-agent": "pi-provider-proxy/probe" },
    });
    // Any HTTP status proves the transport path works; auth is not probed.
    await response.body?.cancel().catch(() => undefined);
    return {
      provider: target.provider,
      url: target.baseUrl,
      route: target.route,
      ok: true,
      status: response.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      provider: target.provider,
      url: target.baseUrl,
      route: target.route,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: describeProbeError(error),
    };
  }
}

/** Map low level errors onto actionable advice. */
export function describeProbeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeText = cause instanceof Error ? `${cause.name}: ${cause.message}` : "";

  if (error instanceof Error && error.name === "TimeoutError") {
    return `timeout — the route did not answer in time (${message})`;
  }
  if (causeText.includes("ECONNREFUSED") || message.includes("ECONNREFUSED")) {
    return `connection refused — is the proxy listening? (${causeText || message})`;
  }
  if (hasAny(causeText, message, ["ENOTFOUND", "EAI_AGAIN"])) {
    return `DNS failure — the host does not resolve (${causeText || message})`;
  }
  if (hasAny(causeText, message, ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"])) {
    return `connect timeout — nothing answered on TCP (${causeText || message})`;
  }
  return causeText === "" ? message : `${message} (${causeText})`;
}

function hasAny(left: string, right: string, needles: readonly string[]): boolean {
  return needles.some((needle) => left.includes(needle) || right.includes(needle));
}

/** One-line human summary. */
export function formatProbeResult(result: ProbeResult): string {
  const route = formatRoute(result.route);
  const duration = `${String(result.durationMs)} ms`;
  if (result.ok) {
    return `✅ ${result.provider}: HTTP ${String(result.status ?? 0)} via ${route} in ${duration}`;
  }
  return `❌ ${result.provider}: ${result.error ?? "unknown error"} via ${route} after ${duration}`;
}
