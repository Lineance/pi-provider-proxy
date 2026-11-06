# pi-provider-proxy

[![CI](https://github.com/Lineance/pi-provider-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/Lineance/pi-provider-proxy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-provider-proxy.svg)](https://www.npmjs.com/package/pi-provider-proxy)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Per-provider HTTP proxy routing for [pi](https://github.com/earendil-works/pi).

Turn the proxy **on or off for each provider**, give a single provider its own proxy, and switch at
runtime with `/proxy` — no restart, no editing `settings.json`, no patching `fetch`.

```
proxy · provider-a→p:7890
```

The line is quiet by design: `direct` rules are **not** advertised (they are the "nothing special"
case), and `statusLine: "auto"` only renders when a provider is actually proxied, the extension is
switched off, or the dispatcher failed to install.

---

## Why

pi has one global proxy knob (`httpProxy` in `~/.pi/agent/settings.json`, or `HTTPS_PROXY` in the
environment) plus `NO_PROXY`. That is all-or-nothing, per host at best, and it is read once at
startup. Real setups need per-provider decisions:

- One provider's endpoint is only reachable through a local proxy (restricted network, geo block,
  or a gateway that terminates TLS itself).
- Another provider's endpoint is faster — or only reachable — **direct**.
- A corporate or self-hosted provider must go through a different, dedicated proxy.
- The decision differs per machine and changes during a session, so it should not require editing
  `settings.json` and restarting.

`pi-provider-proxy` adds exactly that layer. It installs a routing
[undici `Dispatcher`](https://undici.nodejs.org/#/docs/api/Dispatcher) as pi's global dispatcher and
decides **per request origin** whether the request goes direct, through a specific proxy, or
"inherit" (pi's own behaviour).

It does not replace pi's providers, models or credentials, and it does not bundle a second copy of
undici — it drives the instance pi already loaded.

## Install

```bash
pi install npm:pi-provider-proxy
```

From a local checkout (loaded from that path, nothing is copied):

```bash
git clone https://github.com/Lineance/pi-provider-proxy.git
cd pi-provider-proxy && npm install && npm run build
pi install ./pi-provider-proxy        # or: pi -e ./pi-provider-proxy   (one run only)
```

Requires pi with Node 22+ and an ESM loader (any current pi release).

Restart pi. Run `/proxy` to confirm the dispatcher is installed:

```
pi-provider-proxy — enabled
dispatcher: installed (undici …/pi-coding-agent/node_modules/undici/index.js)
default: inherit
config: ~/.pi/agent/pi-provider-proxy.json

providers:
  provider-a           proxy via http://127.0.0.1:7890 → proxy http://127.0.0.1:7890  [api.example.com]
status line: auto (direct rules hidden)
```

## Quick start

```text
/proxy provider-a proxy http://127.0.0.1:7890
/proxy provider-b direct
/proxy test provider-a
/proxy why api.example.com
```

Rules are written to `~/.pi/agent/pi-provider-proxy.json` and take effect on the next request.

## Commands

| Command                             | What it does                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/proxy`                            | Overview: install state, default rule, every provider with its effective route, config problems, counters |
| `/proxy on` · `/proxy off`          | Master switch. `off` makes everything inherit pi's settings (persisted)                                   |
| `/proxy <provider> direct`          | Force a provider to connect directly, even if a global proxy is configured                                |
| `/proxy <provider> proxy [url]`     | Route a provider through a proxy (defaults to `default.proxy`)                                            |
| `/proxy <provider> inherit`         | Remove the provider rule (back to `default`)                                                              |
| `/proxy default <mode> [url]`       | Rule for hosts that match no provider                                                                     |
| `/proxy host <host> <mode> [url]`   | Rule for a raw host (`api.x.test`, `*.x.test`, `*`) — escape hatch                                        |
| `/proxy host <host> clear`          | Remove a host rule                                                                                        |
| `/proxy test <provider>`            | Dial the provider's `baseUrl` through the active route and report status + latency                        |
| `/proxy why <host\|provider>`       | Explain which rule wins and why (includes provider, hosts, `NO_PROXY` interplay)                          |
| `/proxy stats`                      | Request counters (`direct` / `proxy` / `inherit` / `errors`)                                              |
| `/proxy status`                     | Show status-line settings and a live preview                                                              |
| `/proxy status auto`·`always`·`off` | When the footer line renders (`auto`: only when something is proxied, disabled or broken)                 |
| `/proxy status direct on`·`off`     | Whether `direct` rules are listed in the footer (default: hidden)                                         |
| `/proxy reload`                     | Re-read config and the session's provider catalogue                                                       |
| `/proxy help`                       | Usage                                                                                                     |

Add `--project` (`-p`) to any mutating command to write `<cwd>/.pi/pi-provider-proxy.json` instead of
the global file.

## Configuration

Two layers, later wins: `~/.pi/agent/pi-provider-proxy.json`, then `<cwd>/.pi/pi-provider-proxy.json`
(project layer only when the project is trusted).

```jsonc
{
  "$schema": "https://unpkg.com/pi-provider-proxy/schema.json",
  "enabled": true,
  "default": "inherit",
  "providers": {
    "provider-a": { "mode": "proxy" }, // use default.proxy
    "provider-b": "direct", // shorthand string form
    "corp-llm": { "mode": "proxy", "proxy": "http://10.0.0.9:3128" },
  },
  "hosts": {
    "*.internal.test": "direct",
  },
  "loopbackAlwaysDirect": true,
  "statusLine": "auto",
  "statusLineShowDirect": false,
}
```

### Modes

| Mode      | Meaning                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inherit` | Hand the request to pi's own dispatcher. `settings.httpProxy`, `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` behave exactly as they do without this extension. |
| `direct`  | Always connect directly. A dedicated agent is used, so a global `httpProxy` **cannot** leak in.                                                             |
| `proxy`   | Always use the rule's proxy URL (or `default.proxy` if the rule has none).                                                                                  |

Precedence: `enabled: false` → private/loopback guard → `hosts` rule (exact, then longest `*.` match,
then `*`) → `providers` rule → `default` → `inherit`.

### Fields

| Field                  | Type                        | Default     | Notes                                                                              |
| ---------------------- | --------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `enabled`              | boolean                     | `true`      | Master switch; `false` = installed but inert                                       |
| `default`              | rule                        | `"inherit"` | Applied when no provider/host rule matches                                         |
| `providers`            | map                         | `{}`        | Keyed by pi provider id (as shown by `/proxy` or `/model`)                         |
| `hosts`                | map                         | `{}`        | Raw host rules: `api.x.test`, `*.x.test`, `*`                                      |
| `loopbackAlwaysDirect` | boolean                     | `true`      | Keeps loopback / link-local / RFC1918 / `.local` off the proxy                     |
| `statusLine`           | `auto` \| `always` \| `off` | `auto`      | Footer summary; `auto` shows it only when something is proxied, disabled or broken |
| `statusLineShowDirect` | boolean                     | `false`     | Also list `direct` / `inherit` rules in the footer                                 |

Proxy URLs must be `http://` or `https://`. undici's `ProxyAgent` does not speak SOCKS; point the
rule at your client's mixed/HTTP port instead (Clash/mihomo `mixed-port` is HTTP, e.g. `7890`).

## Recipes

### Provider that needs a proxy, everything else direct

```jsonc
{ "default": "direct", "providers": { "provider-a": { "mode": "proxy", "proxy": "http://127.0.0.1:7890" } } }
```

### Proxy by default, but AI endpoints direct

```jsonc
{
  "default": { "mode": "proxy", "proxy": "http://127.0.0.1:7890" },
  "providers": { "provider-a": "direct", "provider-b": "direct" },
}
```

### Keep pi's `httpProxy` and only exempt one provider

Leave `default` at `inherit` and set the one exemption:

```text
/proxy provider-b direct
```

`inherit` keeps `NO_PROXY`/`httpProxy` semantics for everything else, so the two mechanisms compose
instead of conflict.

### Temporary bypass

```text
/proxy off      # everything inherits pi's settings again
/proxy on
```

## Interaction with pi's own proxy settings

- `settings.httpProxy` is applied by pi as `HTTP_PROXY`/`HTTPS_PROXY` for pi-managed HTTP clients.
  `inherit` routes use exactly that dispatcher, unchanged, including its idle/body timeouts.
- Timers for `direct` and `proxy` agents follow `httpIdleTimeoutMs` from pi's settings (default 5 min).
- `NO_PROXY` is not re-implemented here: `inherit` delegates, `direct` bypasses everything, `proxy`
  uses the given proxy unconditionally.
- WebSocket transports (`transport: "websocket"` providers such as Codex Responses) do **not** go
  through undici dispatchers. This extension cannot route them; `/proxy` prints a note when it sees
  such a provider.

## Safety and failure behaviour

| Situation                                            | Behaviour                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| undici cannot be resolved                            | Nothing is installed; one warning; `/proxy` shows the diagnostics and every attempted location |
| Invalid config                                       | Problems are listed with their JSON path; valid parts still apply                              |
| Proxy URL invalid / agent creation fails             | That request falls back to `inherit`, an error is counted, one warning                         |
| Another extension or pi replaces the dispatcher      | Re-installed on the next lifecycle event (self-healing)                                        |
| `PI_PROVIDER_PROXY_DISABLE=1`                        | Never installs (CI, bisecting)                                                                 |
| `PI_PROVIDER_PROXY_DEBUG=1`                          | Per-request `dispatch host route` lines on stderr                                              |
| `PI_PROVIDER_PROXY_UNDICI=/abs/path/undici/index.js` | Explicit undici instance (Nix, exotic layouts)                                                 |

The extension never bundles or imports its own `undici` copy — see
[docs/architecture.md](docs/architecture.md) for why that matters.

## Troubleshooting

**`dispatcher: FAILED — Could not resolve the undici instance pi uses`**
Set `PI_PROVIDER_PROXY_UNDICI` to the `undici/index.js` inside your pi installation, and include the
`/proxy` output when reporting.

**Provider still times out although the rule says `proxy`**
Run `/proxy test <provider>` and `/proxy why <host>`. If the host is loopback/private, the guard keeps
it direct — set `"loopbackAlwaysDirect": false` if you really want to proxy it.

**`inherit` goes through a proxy you did not configure**
That is pi's `httpProxy`/`HTTPS_PROXY`/`NO_PROXY` at work (or another extension's dispatcher). Use
`direct` for that provider to bypass it unconditionally.

**Everything is direct after `/proxy off`**
`off` means "stop making decisions" — pi's own settings then apply as before. Use
`/proxy <provider> direct` instead.

## Development

```bash
npm install
npm run verify   # typecheck → lint → format:check → coverage → build → publint/attw → size guard
npm test
```

See [docs/architecture.md](docs/architecture.md) for the routing model and the reason a
dispatcher-level implementation beats patching `fetch`.

Layout: `src/core/*` is the routing engine (pure functions + dispatcher, no pi imports),
`src/extension/*` is the pi integration (state, `/proxy`, footer), `test/fixtures/*` provides a fake
undici plus a real CONNECT proxy for the socket-level integration test.

## License

MIT
