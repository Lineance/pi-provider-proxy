/**
 * Smoke test: import the built extension the way pi does and check that the
 * default export wires the command and lifecycle hooks without touching the
 * network or the real dispatcher.
 */
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["PI_PROVIDER_PROXY_DISABLE"] = "1";
process.env["PI_CODING_AGENT_DIR"] = mkdtempSync(join(tmpdir(), "ppp-smoke-"));

const { default: extension } = await import("../dist/index.js");
if (typeof extension !== "function") {
  throw new Error("dist/index.js must default-export a function");
}

const registered = [];
const handlers = new Map();
const api = {
  getSettings: () => ({}),
  registerCommand: (name) => registered.push(name),
  on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
};

extension(api);

if (!registered.includes("proxy")) throw new Error("the /proxy command was not registered");
for (const event of ["session_start", "agent_start", "model_select", "session_shutdown"]) {
  if (!handlers.has(event)) throw new Error(`missing lifecycle handler: ${event}`);
}

rmSync(process.env["PI_CODING_AGENT_DIR"], { recursive: true, force: true });
process.stdout.write("smoke: extension loads and wires /proxy\n");
