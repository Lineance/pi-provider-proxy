import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { isDispatcherLike, peekGlobalDispatcher } from "./global-symbols.js";
import { UndiciResolutionError, type UndiciModule, type UndiciResolution } from "../types.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_WALK_UP = 8;

export interface UndiciResolutionOptions {
  /** Entry script of the running pi process (`process.argv[1]`). */
  argv1?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** Injectable loader; defaults to a dynamic `import()` of the file URL. */
  loadModule?: ((path: string) => Promise<unknown>) | undefined;
  /** Injectable resolver; defaults to `createRequire(anchor).resolve`. */
  resolveFromAnchor?: ((anchor: string, specifier: string) => string | undefined) | undefined;
  /** Injectable package-name reader used while walking up from `argv1`. */
  readPackageName?: ((packageJsonPath: string) => string | undefined) | undefined;
}

/** One place we try to resolve `undici` from. */
export interface UndiciCandidate {
  /** File or directory used as the `createRequire` anchor. */
  anchor: string;
  /** Human readable explanation, used in diagnostics. */
  reason: string;
}

function defaultReadPackageName(packageJsonPath: string): string | undefined {
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const name = (parsed as Record<string, unknown>)["name"];
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function defaultResolveFromAnchor(anchor: string, specifier: string): string | undefined {
  try {
    return createRequire(anchor).resolve(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Build the ordered list of places to resolve `undici` from.
 *
 * Order matters: pi's own tree first (same instance pi uses), then the pi
 * package directory overrides, then the entry script itself.
 */
export function undiciCandidates(options: UndiciResolutionOptions = {}): UndiciCandidate[] {
  const env = options.env ?? process.env;
  const readPackageName = options.readPackageName ?? defaultReadPackageName;
  const candidates: UndiciCandidate[] = [];
  const seen = new Set<string>();

  const push = (anchor: string, reason: string): void => {
    const normalized = resolvePath(anchor);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ anchor: normalized, reason });
  };

  const explicit = env["PI_PROVIDER_PROXY_UNDICI"]?.trim();
  if (explicit) push(explicit, "PI_PROVIDER_PROXY_UNDICI");

  const packageDir = env["PI_PACKAGE_DIR"]?.trim();
  if (packageDir) push(join(packageDir, "dist", "index.js"), "PI_PACKAGE_DIR");

  // Default to the running process: pi is launched as `node <pi>/dist/index.js`.
  const argv1 = (options.argv1 ?? process.argv[1])?.trim();
  if (argv1) {
    const entry = resolvePath(argv1);
    push(entry, "pi entry script");

    let dir = dirname(entry);
    for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
      const packageJsonPath = join(dir, "package.json");
      if (existsSync(packageJsonPath) && readPackageName(packageJsonPath) === PI_PACKAGE_NAME) {
        push(join(dir, "dist", "index.js"), "pi package directory");
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return candidates;
}

function isModuleLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asUndiciModule(loaded: unknown): UndiciModule | undefined {
  const candidates: unknown[] = [loaded];
  if (isModuleLike(loaded)) candidates.push(loaded["default"]);

  for (const candidate of candidates) {
    if (!isModuleLike(candidate)) continue;
    const { Dispatcher, Agent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } = candidate;
    if (
      typeof Dispatcher === "function" &&
      typeof Agent === "function" &&
      typeof ProxyAgent === "function" &&
      typeof getGlobalDispatcher === "function" &&
      typeof setGlobalDispatcher === "function"
    ) {
      return candidate as unknown as UndiciModule;
    }
  }
  return undefined;
}

/**
 * Resolve the undici instance pi itself uses.
 *
 * Never falls back to a bare `import("undici")` from this package: an
 * undeclared second copy is exactly what pi warns about.
 */
export async function resolveUndici(options: UndiciResolutionOptions = {}): Promise<UndiciResolution> {
  const resolveFromAnchor = options.resolveFromAnchor ?? defaultResolveFromAnchor;
  const loadModule = options.loadModule ?? ((path: string) => import(pathToFileURL(path).href));
  const candidates = undiciCandidates(options);
  const attempts: string[] = [];

  for (const candidate of candidates) {
    const resolved = resolveFromAnchor(candidate.anchor, "undici");
    if (!resolved) {
      attempts.push(`${candidate.reason} (${candidate.anchor}): undici not resolvable`);
      continue;
    }
    if (attempts.some((attempt) => attempt.includes(resolved))) continue;

    let loaded: unknown;
    try {
      loaded = await loadModule(resolved);
    } catch (error) {
      attempts.push(`${candidate.reason} (${resolved}): import failed: ${errorMessage(error)}`);
      continue;
    }

    const module = asUndiciModule(loaded);
    if (!module) {
      attempts.push(`${candidate.reason} (${resolved}): not an undici module`);
      continue;
    }

    return {
      module,
      path: resolved,
      affectsPi: isDispatcherLike(peekGlobalDispatcher()),
    };
  }

  throw new UndiciResolutionError(
    "Could not resolve the undici instance pi uses. Set PI_PROVIDER_PROXY_UNDICI to an absolute undici entry file, or run inside a pi process.",
    attempts,
  );
}

/** Human readable error message for logs and diagnostics. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

let cached: Promise<UndiciResolution> | undefined;

/** Resolve once per process; failures are not cached so `/proxy reload` can retry. */
export async function resolveUndiciCached(options: UndiciResolutionOptions = {}): Promise<UndiciResolution> {
  cached ??= resolveUndici(options).catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

/** Reset the process cache. Test-only. */
export function resetUndiciCache(): void {
  cached = undefined;
}
