/**
 * Contract tests: guard the assumptions this extension makes about pi and keep
 * the published package honest (no bundled undici, correct pi manifest).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("dependency policy", () => {
  it("keeps runtime dependencies empty and pi as a peer", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
  });

  it("never imports undici from production code", () => {
    const offenders = walk(join(ROOT, "src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /from\s+["']undici["']/.test(text) || /require\(["']undici["']\)/.test(text);
    });
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it("only imports host-provided packages or relative modules/nodes builtins", () => {
    const allowedHost = new Set([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-tui",
      "typebox",
    ]);

    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        if (allowedHost.has(specifier)) continue;
        offenders.push(`${relative(ROOT, file)} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("pi package manifest", () => {
  it("points pi at the built entry point", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      pi?: { extensions?: string[]; changelogPath?: string };
      keywords?: string[];
      files?: string[];
      exports?: Record<string, unknown>;
    };
    expect(manifest.pi?.extensions).toEqual(["./dist/index.js"]);
    expect(manifest.pi?.changelogPath).toBe("./CHANGELOG.md");
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.files).toContain("dist");
    expect(manifest.exports?.["."]).toBeDefined();
    expect(existsSync(join(ROOT, "src", "index.ts"))).toBe(true);
  });
});

describe("config schema", () => {
  it("is valid JSON and describes rules", () => {
    const schema = JSON.parse(readFileSync(join(ROOT, "schema.json"), "utf8")) as {
      title?: string;
      properties?: Record<string, unknown>;
      definitions?: Record<string, unknown>;
    };
    expect(schema.title).toContain("pi-provider-proxy");
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["enabled", "default", "providers", "hosts", "statusLine"]),
    );
    expect(schema.definitions?.["rule"]).toBeDefined();
  });
});

describe("build output", () => {
  it("is self-contained when dist exists", () => {
    const dist = join(ROOT, "dist");
    if (!existsSync(dist)) return;

    const files = readdirSync(dist);
    expect(files).toContain("index.js");
    expect(files).toContain("index.d.ts");

    const totalBytes = files.reduce((sum, name) => sum + statSync(join(dist, name)).size, 0);
    expect(totalBytes).toBeGreaterThan(0);
    expect(totalBytes).toBeLessThan(300_000);

    const entry = readFileSync(join(dist, "index.js"), "utf8");
    expect(entry).not.toMatch(/from\s+["']undici["']/);
  });
});
