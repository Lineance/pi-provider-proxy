/** Global key undici uses for the process-wide dispatcher. */
export const GLOBAL_DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");

/** True when a value looks like an undici dispatcher. */
export function isDispatcherLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["dispatch"] === "function" &&
    typeof candidate["close"] === "function" &&
    typeof candidate["destroy"] === "function"
  );
}

/** Read the process-wide dispatcher that pi installed, if any. */
export function peekGlobalDispatcher(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[GLOBAL_DISPATCHER_SYMBOL];
}
