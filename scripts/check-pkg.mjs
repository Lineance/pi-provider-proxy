/**
 * Package hygiene check: `publint` + `arethetypeswrong` against exactly what
 * would be published.
 *
 * A script (instead of `publint && attw --pack .` in package.json) for two
 * reasons: the tools are invoked through node so no `.cmd` shims are needed on
 * Windows, and the inherited `npm_config_dry_run` from `npm publish --dry-run`
 * is stripped so the inner `npm pack` really writes a tarball.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

const env = { ...process.env };
delete env["npm_config_dry_run"];
delete env["npm_config_pack_destination"];

/** Resolve a dependency's bin script without going through shell shims. */
function binScript(packageName) {
  const packageDir = join(root, "node_modules", packageName);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const bin = manifest.bin;
  if (typeof bin === "string") return join(packageDir, bin);
  const first = Object.values(bin ?? {})[0];
  if (typeof first !== "string") throw new Error(`${packageName} has no bin entry`);
  return join(packageDir, first);
}

function run(packageName, args) {
  process.stdout.write(`\n> ${packageName} ${args.join(" ")}\n`);
  execFileSync(process.execPath, [binScript(packageName), ...args], {
    cwd: root,
    env,
    stdio: "inherit",
  });
}

run("publint", []);
// ESM-only by design: pi loads extension code with a dynamic import.
run("@arethetypeswrong/cli", ["--pack", ".", "--profile", "esm-only"]);
