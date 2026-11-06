/**
 * Package size guard.
 *
 * The published tarball must stay tiny: the extension resolves pi's own undici
 * at runtime, so there is nothing to bundle. A jump in size almost always means
 * something heavy (or a stray node_modules) leaked into `dist/`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MAX_TARBALL_BYTES = 200 * 1024;
const MAX_FILES = 90;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function packReport() {
  const npmCli = process.env["npm_execpath"];
  const args = ["pack", "--dry-run", "--json"];
  const output = npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], { encoding: "utf8" })
    : execFileSync("npm", args, { encoding: "utf8", shell: process.platform === "win32" });

  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1) fail(`unexpected npm pack output: ${output.slice(0, 400)}`);

  const [report] = JSON.parse(output.slice(start, end + 1));
  if (report === undefined) fail("npm pack --dry-run produced no report");
  return report;
}

const report = packReport();
const size = report.size;
const files = report.files.map((file) => file.path);

if (size > MAX_TARBALL_BYTES) fail(`tarball is ${size} bytes, budget is ${MAX_TARBALL_BYTES}`);
if (files.length > MAX_FILES) fail(`tarball has ${files.length} files, budget is ${MAX_FILES}`);

const forbidden = files.filter(
  (path) => path.startsWith("node_modules/") || path.startsWith("src/") || path.startsWith("test/"),
);
if (forbidden.length > 0) fail(`forbidden files in tarball: ${forbidden.join(", ")}`);

for (const required of [
  "dist/index.js",
  "dist/index.d.ts",
  "schema.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
]) {
  if (!files.includes(required)) fail(`${required} is missing from the tarball — run npm run build first`);
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
  fail("runtime dependencies are not allowed; the extension must be dependency-free");
}

const distFiles = readdirSync(join("dist")).length;
process.stdout.write(
  `tarball ${size} bytes, ${files.length} files (${distFiles} in dist/), budget ${MAX_TARBALL_BYTES}\n`,
);
