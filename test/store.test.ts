import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  agentConfigDir,
  CONFIG_FILE_NAME,
  globalConfigPath,
  loadConfig,
  projectConfigPath,
  readConfigFile,
  stripJsonComments,
  writeConfigFile,
} from "../src/core/store.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppp-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("paths", () => {
  it("honours PI_CODING_AGENT_DIR", () => {
    expect(agentConfigDir({ PI_CODING_AGENT_DIR: "C:/custom/agent" })).toMatch(/custom[\\/]agent$/);
    expect(globalConfigPath({ PI_CODING_AGENT_DIR: "C:/custom/agent" })).toMatch(
      new RegExp(`${CONFIG_FILE_NAME}$`),
    );
  });

  it("defaults to ~/.pi/agent", () => {
    expect(agentConfigDir({})).toMatch(/[\\/]\.pi[\\/]agent$/);
  });

  it("puts the project layer under <cwd>/.pi", () => {
    expect(projectConfigPath("C:/work/repo")).toMatch(/work[\\/]repo[\\/]\.pi[\\/]pi-provider-proxy\.json$/);
  });
});

describe("stripJsonComments", () => {
  it("removes line and block comments plus trailing commas", () => {
    const input = `{
      // line comment
      "a": 1, /* block */
      "b": "http://keep//this", // trailing
      "c": [1, 2,],
    }`;
    const parsed = JSON.parse(stripJsonComments(input)) as Record<string, unknown>;
    expect(parsed).toEqual({ a: 1, b: "http://keep//this", c: [1, 2] });
  });
});

describe("read/write config file", () => {
  it("round-trips JSON with comments", () => {
    const dir = tempDir();
    const file = join(dir, "pi-provider-proxy.json");
    writeConfigFile(file, '{\n  // hello\n  "enabled": true\n}\n');
    expect(readConfigFile(file)).toEqual({ raw: { enabled: true } });
  });

  it("writes atomically and leaves no temp files", () => {
    const dir = tempDir();
    const file = join(dir, "nested", CONFIG_FILE_NAME);
    writeConfigFile(file, '{"ok":true}\n');
    writeConfigFile(file, '{"ok":false}\n');
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: false });
    expect(readdirSync(join(dir, "nested"))).toEqual([CONFIG_FILE_NAME]);
  });

  it("reports missing files as empty", () => {
    expect(readConfigFile(join(tempDir(), "nope.json"))).toEqual({});
  });

  it("reports invalid JSON with the path", () => {
    const dir = tempDir();
    const file = join(dir, "bad.json");
    writeFileSync(file, "{oops");
    const result = readConfigFile(file);
    expect(result.error).toContain("is not valid JSON");
  });
});

describe("loadConfig", () => {
  it("returns defaults when nothing exists", () => {
    const dir = tempDir();
    const loaded = loadConfig({ cwd: dir, env: { PI_CODING_AGENT_DIR: join(dir, "agent") } });
    expect(loaded.config.enabled).toBe(true);
    expect(loaded.config.default.mode).toBe("inherit");
    expect(loaded.issues).toEqual([]);
    expect(loaded.layers).toEqual([]);
    expect(loaded.projectLoaded).toBe(false);
  });

  it("merges global then project, project winning per key", () => {
    const dir = tempDir();
    const agentDir = join(dir, "agent");
    writeConfigFile(
      join(agentDir, CONFIG_FILE_NAME),
      JSON.stringify({ providers: { "provider-a": "proxy", "provider-b": "direct" } }),
    );
    const project = join(dir, "repo");
    writeConfigFile(
      join(project, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ providers: { "provider-b": "inherit" }, enabled: false }),
    );

    const loaded = loadConfig({
      cwd: project,
      env: { PI_CODING_AGENT_DIR: agentDir },
      projectTrusted: true,
    });

    expect(loaded.config.providers).toEqual({
      "provider-a": { mode: "proxy" },
      "provider-b": { mode: "inherit" },
    });
    expect(loaded.config.enabled).toBe(false);
    expect(loaded.projectLoaded).toBe(true);
    expect(loaded.layers).toHaveLength(2);
  });

  it("ignores the project layer when the project is not trusted", () => {
    const dir = tempDir();
    const project = join(dir, "repo");
    writeConfigFile(join(project, ".pi", CONFIG_FILE_NAME), JSON.stringify({ enabled: false }));

    const loaded = loadConfig({
      cwd: project,
      env: { PI_CODING_AGENT_DIR: join(dir, "agent") },
      projectTrusted: false,
    });

    expect(loaded.config.enabled).toBe(true);
    expect(loaded.projectLoaded).toBe(false);
  });

  it("surfaces config problems without throwing", () => {
    const dir = tempDir();
    const agentDir = join(dir, "agent");
    writeConfigFile(join(agentDir, CONFIG_FILE_NAME), '{"providers": {"a": "sideways"}, "mystery": 1}');

    const loaded = loadConfig({ cwd: dir, env: { PI_CODING_AGENT_DIR: agentDir } });
    expect(loaded.issues.map((issue) => issue.path).sort()).toEqual(["mystery", "providers.a"]);
    expect(loaded.config.providers).toEqual({});
  });
});
