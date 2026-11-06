import { describe, expect, it, vi } from "vitest";

import { DispatcherInstaller } from "../src/core/install.js";
import type { Route } from "../src/core/resolve.js";
import { ProxyStats } from "../src/core/stats.js";
import { UndiciResolutionError, type UndiciResolution } from "../src/types.js";
import { createFakeDispatcher, createFakeUndici } from "./fixtures/fake-undici.js";

const route: Route = { kind: "direct", reason: "test" };

function resolutionFor(fake: ReturnType<typeof createFakeUndici>, affectsPi = true): UndiciResolution {
  return { module: fake.module, path: "/fake/undici/index.js", affectsPi };
}

function createInstaller(options: {
  fake: ReturnType<typeof createFakeUndici>;
  env?: Record<string, string>;
  onReinstalled?: () => void;
  reject?: Error;
}) {
  const stats = new ProxyStats();
  const resolveUndici = (): Promise<UndiciResolution> => {
    const failure = options.reject;
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(resolutionFor(options.fake));
  };
  const installer = new DispatcherInstaller({
    resolveRoute: () => route,
    stats,
    resolveUndici,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onReinstalled === undefined ? {} : { onReinstalled: options.onReinstalled }),
  });
  return { installer, stats };
}

describe("DispatcherInstaller", () => {
  it("installs its router as the global dispatcher", async () => {
    const fake = createFakeUndici();
    const { installer } = createInstaller({ fake });

    const state = await installer.ensure();

    expect(state.status).toBe("installed");
    expect(installer.isActive()).toBe(true);
    expect(fake.globalDispatcher()).not.toBe(fake.inherit);
  });

  it("is idempotent on repeated ensure() calls", async () => {
    const fake = createFakeUndici();
    const { installer } = createInstaller({ fake });

    await installer.ensure();
    const first = fake.globalDispatcher();
    await installer.ensure();
    await installer.ensure();

    expect(fake.globalDispatcher()).toBe(first);
  });

  it("reinstalls when someone else replaces the dispatcher", async () => {
    const fake = createFakeUndici();
    const onReinstalled = vi.fn();
    const { installer } = createInstaller({ fake, onReinstalled });

    await installer.ensure();
    const ours = fake.globalDispatcher();

    const squatter = createFakeDispatcher("squatter");
    fake.module.setGlobalDispatcher(squatter);
    expect(installer.isActive()).toBe(false);

    await installer.ensure();
    expect(onReinstalled).toHaveBeenCalledTimes(1);
    expect(fake.globalDispatcher()).not.toBe(ours);
    expect(fake.globalDispatcher()).not.toBe(squatter);
    expect(installer.isActive()).toBe(true);
  });

  it("stays disabled when PI_PROVIDER_PROXY_DISABLE is set", async () => {
    const fake = createFakeUndici();
    const { installer } = createInstaller({ fake, env: { PI_PROVIDER_PROXY_DISABLE: "1" } });

    const state = await installer.ensure();
    expect(state).toEqual({ status: "disabled", reason: "PI_PROVIDER_PROXY_DISABLE is set" });
    expect(fake.globalDispatcher()).toBe(fake.inherit);
  });

  it("reports a failure with the attempted locations", async () => {
    const fake = createFakeUndici();
    const failure = new UndiciResolutionError("no undici", ["/a: nope", "/b: nope"]);
    const { installer } = createInstaller({ fake, reject: failure });

    const state = await installer.ensure();
    expect(state.status).toBe("failed");
    if (state.status === "failed") {
      expect(state.reason).toContain("no undici");
      expect(state.attempts).toEqual(["/a: nope", "/b: nope"]);
    }
    expect(fake.globalDispatcher()).toBe(fake.inherit);
  });

  it("restores pi's dispatcher on uninstall", async () => {
    const fake = createFakeUndici();
    const { installer } = createInstaller({ fake });

    await installer.ensure();
    expect(installer.isActive()).toBe(true);

    await installer.uninstall();
    expect(fake.globalDispatcher()).toBe(fake.inherit);
    expect(installer.getState().status).toBe("disabled");
  });

  it("uninstall is safe when nothing was installed", async () => {
    const fake = createFakeUndici();
    const { installer } = createInstaller({ fake });
    await expect(installer.uninstall()).resolves.toBeUndefined();
    expect(fake.globalDispatcher()).toBe(fake.inherit);
  });
});
