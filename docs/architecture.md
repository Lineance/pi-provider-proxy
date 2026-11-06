# Architecture

## The problem with patching `fetch`

The obvious implementation — wrap `globalThis.fetch` and pass a `dispatcher` when a rule says
"proxy" — fails in four ways:

1. **`direct` is not direct.** Omitting the dispatcher falls back to
   `undici.getGlobalDispatcher()`, which pi has already pointed at an `EnvHttpProxyAgent` when
   `httpProxy`/`HTTPS_PROXY` is set. The request still goes through the proxy.
2. **It misses whole transports.** Providers using WebSocket transports never call `fetch`; SDKs can
   also hold a reference to `fetch` captured at import time.
3. **It duplicates undici.** A second `undici` copy in a dispatcher passed to pi's fetch is exactly
   the pairing pi warns about (mismatched generations break response decoding).
4. **It loses pi's dispatcher tuning** (`httpIdleTimeoutMs`, `autoSelectFamilyAttemptTimeout`).

## What this extension does instead

pi installs one process-wide undici dispatcher:

```js
// pi: dist/core/http-dispatcher.js
undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ … }))
```

Every pi-managed HTTP request — OpenAI SDK, Anthropic SDK, Bedrock, plain `fetch` — dispatches
through it. undici tells a dispatcher exactly one routing-relevant thing: `opts.origin`. That maps
1:1 to the host of a provider's `baseUrl`, which is precisely the granularity we need.

```
pi provider request
  └─ pi's undici fetch
     └─ getGlobalDispatcher()                      ← replaced by this extension
        └─ ProviderProxyRouter.dispatch(opts)
           ├─ new URL(opts.origin).hostname        →  route decision (pure function)
           ├─ "direct"  → Agent                    ← ignores any global proxy
           ├─ "proxy"   → ProxyAgent(uri, proxyTunnel)
           └─ "inherit" → pi's original dispatcher ← httpProxy/NO_PROXY preserved
```

### Reusing pi's undici instance

`resolveUndici()` locates the module pi loaded, in this order:

1. `PI_PROVIDER_PROXY_UNDICI` (explicit override)
2. `PI_PACKAGE_DIR` → `<dir>/dist/index.js`
3. `process.argv[1]` (pi's entry script)
4. Walk up from that entry looking for `package.json` with `name: "@earendil-works/pi-coding-agent"`,
   then resolve `undici` from the package directory

Resolution uses `createRequire(anchor).resolve("undici")`, so the extension gets the _same_ module
instance pi uses (Node caches CommonJS modules per resolved file). There is deliberately no
`dependencies` entry for `undici`: a fallback to a private copy would reintroduce problem 3 above.
If resolution fails, the extension installs nothing and reports every attempted location.

### Installation timing

pi applies `settings.httpProxy` and calls `configureHttpDispatcher()` **after** the extension runtime
is created, so installing during module load would be overwritten. The extension therefore:

- installs on `session_start`,
- re-checks on `agent_start` (a single `getGlobalDispatcher() === ourDispatcher` comparison, then a
  no-op fast path),
- re-installs if the comparison fails (pi reload, another extension, settings change),
- restores pi's original dispatcher on `session_shutdown`.

### Routing decision

`resolveRoute()` is a pure, synchronous function of `(host, config, hostToProvider)`, so the entire
rule matrix is unit-testable without sockets. Precedence:

```
enabled: false                    → inherit
loopback / private / .local       → direct        (loopbackAlwaysDirect)
hosts[exact] → hosts[longest *.…] → hosts["*"]    → rule
hostToProvider[host]              → providers[id] → rule
default → rule
```

`hostToProvider` is rebuilt from `ctx.modelRegistry.getAll()` (`model.provider` + `model.baseUrl`)
on every refresh, so a new provider or a changed `baseUrl` is picked up without restarting. When two
providers claim one host, the ambiguity is reported in `/proxy` instead of being resolved silently.

### Agent lifecycle

Agents are created lazily and cached per route key (`direct`, `proxy:<url>`), with options derived
from pi's settings (`httpIdleTimeoutMs`, `allowH2: false`, `autoSelectFamilyAttemptTimeout: 2000`).
`close()`/`destroy()` are idempotent and never touch the inherited dispatcher (pi owns it).

### Failure containment

Each layer degrades independently:

| Layer             | Failure                         | Result                                               |
| ----------------- | ------------------------------- | ---------------------------------------------------- |
| undici resolution | cannot locate module            | not installed; one warning; diagnostics in `/proxy`  |
| installer         | `setGlobalDispatcher` throws    | reported; pi keeps its own dispatcher                |
| resolver          | throws                          | that request goes `inherit`, error counted           |
| agent             | `ProxyAgent` constructor throws | that request goes `inherit`, error counted           |
| config            | invalid JSON / bad fields       | problems listed with JSON paths; valid parts applied |

The extension never throws into pi's request path: `dispatch()` always returns a boolean and a
fallback exists for every branch.

## Testing strategy

- **Pure logic**: `resolve`, `config`, `providers`, `store` — table-driven unit tests.
- **Router**: a fake undici module (`test/fixtures/fake-undici.ts`) records agent creation and
  dispatch, covering selection, caching, error fallbacks, lifecycle, and stats.
- **Installer**: fake undici module with injectable resolution covers install, idempotency,
  re-install after a squatter, disable via env, uninstall restore, failure reporting.
- **Integration**: real undici + a local CONNECT proxy + a local target server. `localhost` and
  `127.0.0.1` stand in for two providers; the proxy's tunnel log proves which requests took which
  path — including "a global proxy is configured but this provider is still direct".
- **Contract**: production code may not import `undici` directly, may only import host-provided
  packages, and the published tarball must stay dependency-free, small, and contain `dist/index.js`.
