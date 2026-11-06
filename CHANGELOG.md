# Changelog

All notable changes to this project are documented here. pi reads this file and shows entries newer
than the installed version after an update, so keep headings in `## [version]` form.

## [0.1.0] - 2026-11-06

First public release.

### Added

- Dispatcher-level per-provider proxy routing: `direct`, `proxy <url>` and `inherit`, decided per
  request origin, without patching `globalThis.fetch`.
- `/proxy` command family: overview, `on`/`off`, per-provider and per-host rules, `test`, `why`,
  `stats`, `reload`, `help`, with `--project` to write the project layer.
- Two configuration layers (`~/.pi/agent/pi-provider-proxy.json`, then `<cwd>/.pi/…`) with
  path-addressed validation problems and atomic writes.
- Footer status line (`statusLine: auto | always | off`).
- Self-healing dispatcher installation: re-installs when pi or another extension replaces the global
  dispatcher, restores pi's dispatcher on shutdown.
- Runtime reuse of pi's own undici instance (no bundled copy) with explicit override
  (`PI_PROVIDER_PROXY_UNDICI`) and full diagnostics when resolution fails.
- Offline test suite (152 tests): rule matrix, config validation, atomic store, fake-undici router
  tests, and a real-socket integration test with a local CONNECT proxy.
- npm/package hygiene: zero runtime dependencies, `publint` + `attw`, tarball size guard, CI matrix.
