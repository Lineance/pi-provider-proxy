import type { Route } from "./resolve.js";

export type RouteKind = Route["kind"];

export interface LastRouteEntry {
  host: string;
  kind: RouteKind;
  detail: string;
  at: number;
}

const MAX_TRACKED_HOSTS = 128;

/** Counters + a bounded "last seen route per host" table. */
export class ProxyStats {
  direct = 0;
  proxy = 0;
  inherit = 0;
  errors = 0;

  readonly lastRoutes = new Map<string, LastRouteEntry>();

  record(host: string, route: Route): void {
    this[route.kind] += 1;
    const detail = route.kind === "proxy" ? route.url : route.reason;
    this.lastRoutes.delete(host);
    this.lastRoutes.set(host, { host, kind: route.kind, detail, at: Date.now() });
    if (this.lastRoutes.size > MAX_TRACKED_HOSTS) {
      const oldest = this.lastRoutes.keys().next();
      if (!oldest.done) this.lastRoutes.delete(oldest.value);
    }
  }

  recordError(): void {
    this.errors += 1;
  }

  reset(): void {
    this.direct = 0;
    this.proxy = 0;
    this.inherit = 0;
    this.errors = 0;
    this.lastRoutes.clear();
  }

  total(): number {
    return this.direct + this.proxy + this.inherit;
  }

  summary(): string {
    const parts = [
      `direct ${String(this.direct)}`,
      `proxy ${String(this.proxy)}`,
      `inherit ${String(this.inherit)}`,
    ];
    if (this.errors > 0) parts.push(`errors ${String(this.errors)}`);
    return parts.join(" · ");
  }
}
