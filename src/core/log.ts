/**
 * Opt-in debug logging.
 *
 * pi owns the terminal (alternate screen + inline rendering), so diagnostics go
 * to stderr only when explicitly enabled and never from a hot path otherwise.
 */

const PREFIX = "[pi-provider-proxy]";

export function debugEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env["PI_PROVIDER_PROXY_DEBUG"]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function debug(message: string, ...details: unknown[]): void {
  if (!debugEnabled()) return;
  const suffix = details.length > 0 ? ` ${details.map(format).join(" ")}` : "";
  process.stderr.write(`${PREFIX} ${message}${suffix}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${PREFIX} ${message}\n`);
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json: unknown = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}
