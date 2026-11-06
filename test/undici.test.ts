import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { peekGlobalDispatcher } from "../src/core/global-symbols.js";
import {
  resetUndiciCache,
  resolveUndici,
  resolveUndiciCached,
  undiciCandidates,
  type UndiciResolutionOptions,
} from "../src/core/undici.js";
import { UndiciResolutionError } from "../src/types.js";
import { createFakeDispatcher, createFakeUndici } from "./fixtures/fake-undici.js";

const tempDirs: string[] = [];

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway directory tree shaped like an installed pi package. */
function piTree(): { entry: string; mainEntry: string; packageDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ppp-pi-"));
  tempDirs.push(root);
  const packageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
  );
  writeFileSync(join(packageDir, "dist", "index.js"), "export {};");
  writeFileSync(join(packageDir, "dist", "main.js"), "export {};");
  return {
    entry: join(packageDir, "dist", "index.js"),
    mainEntry: join(packageDir, "dist", "main.js"),
    packageDir,
  };
}

let tree: ReturnType<typeof piTree>;
let PI_ENTRY: string;

beforeAll(() => {
  tree = piTree();
  PI_ENTRY = tree.mainEntry;
});

function resolutionOptions(overrides: Partial<UndiciResolutionOptions> = {}): UndiciResolutionOptions {
  return {
    argv1: PI_ENTRY,
    env: {},
    readPackageName: (packageJsonPath) =>
      packageJsonPath.includes("@earendil-works") ? "@earendil-works/pi-coding-agent" : "other",
    ...overrides,
  };
}

describe("undiciCandidates", () => {
  it("prefers the explicit env override", () => {
    const candidates = undiciCandidates(
      resolutionOptions({ env: { PI_PROVIDER_PROXY_UNDICI: "/custom/undici/index.js" } }),
    );
    const [first] = candidates;
    expect(first?.reason).toBe("PI_PROVIDER_PROXY_UNDICI");
    expect(first?.anchor).toContain("undici");
  });

  it("includes PI_PACKAGE_DIR, the pi entry script and the package directory", () => {
    const candidates = undiciCandidates(resolutionOptions({ env: { PI_PACKAGE_DIR: "/opt/pi-1.5.0" } }));
    const reasons = candidates.map((candidate) => candidate.reason);
    expect(reasons).toContain("PI_PACKAGE_DIR");
    expect(reasons).toContain("pi entry script");
    expect(reasons).toContain("pi package directory");
  });

  it("walks up from the entry script to the pi package", () => {
    const candidates = undiciCandidates({ argv1: tree.mainEntry, env: {} });
    expect(candidates.map((candidate) => candidate.anchor)).toEqual([
      tree.mainEntry,
      join(tree.packageDir, "dist", "index.js"),
    ]);
  });

  it("defaults to the running process entry script", () => {
    const candidates = undiciCandidates({ env: {} });
    expect(candidates[0]?.reason).toBe("pi entry script");
  });

  it("works without an entry script", () => {
    const candidates = undiciCandidates({ argv1: "", env: {} });
    expect(candidates).toEqual([]);
  });
});

describe("resolveUndici", () => {
  it("returns the first loadable undici module", async () => {
    const fake = createFakeUndici();
    const loadModule = vi.fn(() => Promise.resolve(fake.module));

    const resolution = await resolveUndici(
      resolutionOptions({
        loadModule,
        resolveFromAnchor: () => "/fake/undici/index.js",
      }),
    );

    expect(resolution.module).toBe(fake.module);
    expect(resolution.path).toBe("/fake/undici/index.js");
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it("skips anchors that do not resolve and keeps looking", async () => {
    const fake = createFakeUndici();
    const resolveFromAnchor = vi.fn((anchor: string) =>
      anchor.includes("pi-coding-agent") ? "/fake/undici/index.js" : undefined,
    );

    const resolution = await resolveUndici(
      resolutionOptions({ loadModule: () => Promise.resolve(fake.module), resolveFromAnchor }),
    );
    expect(resolution.path).toBe("/fake/undici/index.js");
  });

  it("skips modules that are not undici", async () => {
    const fake = createFakeUndici();
    let call = 0;
    const loadModule = vi.fn(() => {
      call += 1;
      return Promise.resolve(call === 1 ? { nope: true } : { default: fake.module });
    });

    const resolution = await resolveUndici(
      resolutionOptions({
        loadModule,
        resolveFromAnchor: (anchor) => `/fake/${String(anchor.length)}/undici/index.js`,
      }),
    );
    expect(resolution.module).toBe(fake.module);
    expect(loadModule).toHaveBeenCalledTimes(2);
  });

  it("throws with every attempt listed", async () => {
    await expect(
      resolveUndici(
        resolutionOptions({
          loadModule: () => Promise.reject(new Error("cannot import")),
          resolveFromAnchor: () => "/fake/undici/index.js",
        }),
      ),
    ).rejects.toBeInstanceOf(UndiciResolutionError);

    const failure: unknown = await resolveUndici(
      resolutionOptions({
        argv1: "",
        resolveFromAnchor: () => undefined,
      }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(UndiciResolutionError);
    expect((failure as UndiciResolutionError).message).toMatch(/Could not resolve/);
  });

  it("reports whether pi's dispatcher slot is already populated", async () => {
    const fake = createFakeUndici();
    const previous = peekGlobalDispatcher();
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] =
      createFakeDispatcher("pi");

    try {
      const resolution = await resolveUndici(
        resolutionOptions({
          loadModule: () => Promise.resolve(fake.module),
          resolveFromAnchor: () => "/fake/undici/index.js",
        }),
      );
      expect(resolution.affectsPi).toBe(true);
    } finally {
      (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] = previous;
    }
  });
});

describe("resolveUndiciCached", () => {
  it("loads once and can be reset", async () => {
    resetUndiciCache();
    const fake = createFakeUndici();
    const loadModule = vi.fn(() => Promise.resolve(fake.module));
    const options = resolutionOptions({ loadModule, resolveFromAnchor: () => "/fake/undici/index.js" });

    await resolveUndiciCached(options);
    await resolveUndiciCached(options);
    expect(loadModule).toHaveBeenCalledTimes(1);

    resetUndiciCache();
    await resolveUndiciCached(options);
    expect(loadModule).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    resetUndiciCache();
    const options = resolutionOptions({ argv1: "", resolveFromAnchor: () => undefined });
    await expect(resolveUndiciCached(options)).rejects.toBeInstanceOf(UndiciResolutionError);
    await expect(resolveUndiciCached(options)).rejects.toBeInstanceOf(UndiciResolutionError);
  });
});
