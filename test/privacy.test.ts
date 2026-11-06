/**
 * Leak guard.
 *
 * This package ships to npm and lives in a public repo, so documentation,
 * comments and fixtures may only mention example/reserved domains. A real
 * provider hostname or an internal gateway in a README is a privacy leak that is
 * hard to take back once published, so it is a test failure here.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Reserved TLDs: always fine to use in examples. */
const RESERVED_TLDS = new Set(["test", "local", "localhost", "internal", "invalid", "example"]);

/**
 * TLDs that make a dotted token look like a real hostname. Without this the
 * scanner would flag member expressions such as `date.now` or `types.js`.
 */
const REAL_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "ai",
  "cn",
  "co",
  "app",
  "cloud",
  "xyz",
  "top",
  "vip",
  "site",
  "info",
  "biz",
  "me",
  "tv",
  "cc",
  "shop",
  "link",
  "online",
  "store",
  "tech",
  "live",
  "fun",
  "work",
  "club",
  "asia",
  "mobi",
  "pw",
  "su",
  "la",
  "tk",
  "ml",
  "ga",
  "cf",
  "gq",
  "jp",
  "kr",
  "hk",
  "tw",
  "sg",
  "uk",
  "de",
  "fr",
  "nl",
  "ru",
  "in",
  "us",
]);

/** Documentation domains that are allowed to appear. */
const ALLOWED_HOSTS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "npmjs.org",
  "www.npmjs.com",
  "unpkg.com",
  "img.shields.io",
  "nodejs.org",
  "undici.nodejs.org",
  "pi.dev",
  "json-schema.org",
  "typescriptlang.org",
  "keepachangelog.com",
]);

const HOST_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,24})\b/gi;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "coverage" || entry.name === ".notes") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|js|md|json|mjs|yml)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Files that are published or public: docs, sources, schema and build output. */
function auditedFiles(): string[] {
  const files = [
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "schema.json",
    "package.json",
    ...walk(join(ROOT, "docs")),
    ...walk(join(ROOT, "src")),
    ...walk(join(ROOT, "test")),
    ...walk(join(ROOT, ".github")),
    ...walk(join(ROOT, "scripts")),
  ];
  return files.filter((file) => existsSync(file));
}

function offendersIn(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const offenders = new Set<string>();
  for (const match of text.matchAll(HOST_PATTERN)) {
    const host = match[0].toLowerCase();
    const tld = host.slice(host.lastIndexOf(".") + 1);
    if (RESERVED_TLDS.has(tld)) continue;
    if (!REAL_TLDS.has(tld)) continue; // member expressions like `date.now`, `types.js`
    if (ALLOWED_HOSTS.has(host)) continue;
    if (/^(?:[a-z-]+\.)*(?:example|test|local|internal)\.[a-z]+$/.test(host)) continue;
    offenders.add(host);
  }
  return [...offenders];
}

describe("publication privacy", () => {
  it("mentions only example or documented hosts", () => {
    const report = auditedFiles()
      .map((file) => ({
        file: file.replace(`${ROOT}/`, "").replace(`${ROOT}\\`, ""),
        hosts: offendersIn(file),
      }))
      .filter((entry) => entry.hosts.length > 0)
      .map((entry) => `${entry.file}: ${entry.hosts.join(", ")}`);

    expect(report).toEqual([]);
  });

  it("keeps the published file list limited to distributable assets", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files?: string[] };
    expect(manifest.files).toEqual(["dist", "docs", "schema.json", "README.md", "CHANGELOG.md", "LICENSE"]);
  });
});
