/**
 * Build the host → provider index used by the router.
 *
 * pi exposes the effective model catalogue through `ctx.modelRegistry`; each
 * model carries its provider id and resolved `baseUrl`. Two providers sharing a
 * host is legal but ambiguous for routing, so conflicts are reported to the user
 * instead of being silently resolved.
 */
import { normalizeHost } from "./resolve.js";

export interface ProviderModelLike {
  provider?: string | undefined;
  baseUrl?: string | undefined;
}

export interface ProviderIndex {
  /** host → every provider that uses it, in registry order. */
  hostToProviders: Map<string, string[]>;
  providerHosts: Map<string, string[]>;
  /** host → all providers that claim it (length > 1 means a real conflict). */
  conflicts: Map<string, string[]>;
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const host = new URL(baseUrl).hostname;
    return host ? normalizeHost(host) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param models models from `ctx.modelRegistry.getAll()`
 */
export function buildProviderIndex(models: readonly ProviderModelLike[]): ProviderIndex {
  const hostToProviders = new Map<string, string[]>();
  const providerHosts = new Map<string, string[]>();

  const claim = (host: string, provider: string): void => {
    const owners = hostToProviders.get(host);
    if (owners === undefined) {
      hostToProviders.set(host, [provider]);
    } else if (!owners.includes(provider)) {
      owners.push(provider);
    }

    const hosts = providerHosts.get(provider);
    if (hosts === undefined) {
      providerHosts.set(provider, [host]);
    } else if (!hosts.includes(host)) {
      hosts.push(host);
    }
  };

  for (const model of models) {
    const host = hostOf(model.baseUrl);
    const provider = model.provider;
    if (host === undefined || provider === undefined || provider === "") continue;
    claim(host, provider);
  }

  const conflicts = new Map<string, string[]>();
  for (const [host, owners] of hostToProviders) {
    if (owners.length > 1) conflicts.set(host, [...owners]);
  }

  return { hostToProviders, providerHosts, conflicts };
}

/** List known provider ids, sorted, for `/proxy` output and completions. */
export function knownProviders(index: ProviderIndex): string[] {
  return [...index.providerHosts.keys()].sort((a, b) => a.localeCompare(b));
}
