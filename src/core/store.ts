/**
 * Config file IO: paths, tolerant reads, atomic writes.
 *
 * Two layers, later wins:
 *   1. `<agent dir>/pi-provider-proxy.json`   (always)
 *   2. `<cwd>/.pi/pi-provider-proxy.json`     (only when the project is trusted)
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { buildConfig, type Config, type ConfigIssue } from "./config.js";

export const CONFIG_FILE_NAME = "pi-provider-proxy.json";

/** pi's agent/config directory (`PI_CODING_AGENT_DIR` overrides `~/.pi/agent`). */
export function agentConfigDir(env: Record<string, string | undefined> = process.env): string {
  const override = env["PI_CODING_AGENT_DIR"]?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".pi", "agent");
}

export function globalConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(agentConfigDir(env), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
  return join(resolve(cwd), ".pi", CONFIG_FILE_NAME);
}

export interface ReadFileResult {
  /** Parsed JSON body, `undefined` when the file does not exist. */
  raw?: unknown;
  /** Set when the file exists but cannot be read/parsed. */
  error?: string;
}

export function readConfigFile(path: string): ReadFileResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: `cannot read ${path}: ${String(error)}` };
  }

  const stripped = stripJsonComments(text);
  if (stripped.trim() === "") return { raw: {} };
  try {
    return { raw: JSON.parse(stripped) as unknown };
  } catch (error) {
    return { error: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Allow `//` and `/* *\/` comments plus trailing commas in config files. */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    const next = input[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    out += char;
  }

  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeConfigFile(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  writeFileSync(temp, body, "utf8");
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface LoadConfigOptions {
  cwd: string;
  env?: Record<string, string | undefined> | undefined;
  projectTrusted?: boolean | undefined;
}

export interface LoadedConfig {
  config: Config;
  issues: ConfigIssue[];
  layers: string[];
  globalPath: string;
  projectPath: string;
  projectLoaded: boolean;
}

/** Read both layers and produce the effective config. Never throws. */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const env = options.env ?? process.env;
  const globalPath = globalConfigPath(env);
  const projectPath = projectConfigPath(options.cwd);

  const globalFile = readConfigFile(globalPath);
  const layers: { label: string; raw: unknown }[] = [];
  const issues: ConfigIssue[] = [];

  if (globalFile.error !== undefined) {
    issues.push({ path: "", message: globalFile.error });
  } else if (globalFile.raw !== undefined) {
    layers.push({ label: globalPath, raw: globalFile.raw });
  }

  const projectAllowed = options.projectTrusted !== false;
  const projectFile = projectAllowed ? readConfigFile(projectPath) : {};
  if (projectFile.error !== undefined) {
    issues.push({ path: "", message: projectFile.error });
  } else if (projectFile.raw !== undefined) {
    layers.push({ label: projectPath, raw: projectFile.raw });
  }

  const built = buildConfig(layers);
  return {
    config: built.config,
    issues: [...issues, ...built.issues],
    layers: built.layers,
    globalPath,
    projectPath,
    projectLoaded: layers.some((layer) => layer.label === projectPath),
  };
}
