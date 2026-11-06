/**
 * A fake pi `ExtensionContext` / `ExtensionAPI`.
 *
 * Only the members pi-provider-proxy actually touches are implemented, which
 * keeps command tests honest about the extension's real API surface.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RouteRule } from "../../src/core/config.js";

export interface NotifyRecord {
  message: string;
  type: string;
}

export interface FakeUi {
  notifications: NotifyRecord[];
  statuses: Map<string, string | undefined>;
}

export interface FakeContextOptions {
  cwd?: string;
  models?: readonly { provider: string; baseUrl: string }[];
  projectTrusted?: boolean;
}

export function createFakeContext(options: FakeContextOptions = {}): {
  ctx: ExtensionContext;
  ui: FakeUi;
} {
  const notifications: NotifyRecord[] = [];
  const statuses = new Map<string, string | undefined>();

  const ui = {
    notify: (message: string, type = "info") => {
      notifications.push({ message, type });
    },
    setStatus: (key: string, text: string | undefined) => {
      statuses.set(key, text);
    },
    select: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(false),
    input: () => Promise.resolve(undefined),
  };

  const context = {
    cwd: options.cwd ?? process.cwd(),
    ui,
    isProjectTrusted: () => options.projectTrusted ?? false,
    modelRegistry: {
      getAll: () => options.models ?? [],
      getProvider: () => undefined,
      getAvailable: () => options.models ?? [],
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
    },
  };

  return {
    ctx: context as unknown as ExtensionContext,
    ui: { notifications, statuses },
  };
}

export interface FakeApi {
  api: ExtensionAPI;
  settings: Record<string, unknown>;
  registeredCommands: string[];
  handlers: Map<string, ((event: never, ctx: ExtensionContext) => unknown)[]>;
}

export function createFakeApi(settings: Record<string, unknown> = {}): FakeApi {
  const registeredCommands: string[] = [];
  const handlers = new Map<string, ((event: never, ctx: ExtensionContext) => unknown)[]>();
  const state: FakeApi = {
    settings,
    registeredCommands,
    handlers,
    api: undefined as unknown as ExtensionAPI,
  };

  state.api = {
    getSettings: () => settings,
    registerCommand: (name: string) => {
      registeredCommands.push(name);
    },
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;

  return state;
}

/** Convenience: build the models array pi's registry would expose. */
export function modelsFor(
  providers: Record<string, string>,
): { provider: string; baseUrl: string; id: string }[] {
  return Object.entries(providers).map(([provider, baseUrl]) => ({
    provider,
    baseUrl,
    id: "test-model",
  }));
}

/** Convenience rule builders for config fixtures. */
export const direct: RouteRule = { mode: "direct" };
export const inherit: RouteRule = { mode: "inherit" };
export function via(proxy: string): RouteRule {
  return { mode: "proxy", proxy };
}
