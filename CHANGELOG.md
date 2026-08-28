# Changelog

All notable changes to this project are documented here. Release-specific notes are also published on GitHub Releases.

## [Unreleased]

### Added

- `grafana_query` multi-value variable overrides: pass an array in the `variables` argument (e.g. `{"host":["www","m"]}`) and it expands according to the Grafana format modifier used in the query (`:csv`, `:raw`, `:pipe`, `:doublequote`, `:singlequote`, `:json`, `:sqlstring`, `:percent`, `:querystring`, `:regex`, `:lucene`). Unknown format modifiers throw an explicit error; the single-value default path is byte-for-byte unchanged.
- `grafana_query` adhoc filters now translate per datasource type instead of being Elasticsearch-only: Elasticsearch targets keep the Lucene expansion, Prometheus queries get label matchers injected into every vector selector (bare metric names get `{...}` added; functions, `by`/`without`/`on` clauses, `$__rate_interval`, string literals, and comments are correctly skipped), Loki queries get matchers injected into the stream selector (pipeline stages untouched), and SQL datasources (MySQL/Postgres/MSSQL/MariaDB/SQLite/ClickHouse) get the `${__adhoc}`/`$__adhoc` placeholder in `rawSql` replaced with a quote-escaped WHERE-style clause. Unsupported datasource types throw an error listing the support matrix; operator/datasource combinations that cannot be expressed (e.g. numeric range on label matchers) throw instead of being silently dropped. Pre-validation is binding-aware: only the datasource types actually used by the selected panels are checked.
- `grafana_query` now resolves legacy dashboard datasource references before querying: plain string uids (Grafana 8 and earlier), `{"uid":"$datasource"}` objects, and `{"type":"…","uid":"$datasource"}` references to datasource-type template variables are resolved via a lazily fetched `GET /api/datasources` index (by uid or name); the saved pseudo-uid `"default"` is mapped to the server's default datasource. When the index is unavailable or the uid is unknown, the raw uid is passed through so Grafana itself reports the problem. Previously such dashboards failed with an unexplained `The selected panel(s) yielded no executable query.`
- `grafana_query` supports overriding datasource-type template variables with a uid string (`{"datasource":"prom-prod"}`), re-pointing the panels that reference the variable; non-string values throw an explicit error.
- `grafana_query` Elasticsearch adhoc filters support the regex operators `=~`/`!~` as Lucene `field:/pattern/` clauses (`/` inside the pattern is escaped; `!~` renders as `NOT field:/pattern/`; an empty pattern throws).
- `grafana_query` renders a bare multi-value variable reference inside Prometheus/Loki targets as `(a|b)` — the alternation form that works inside `=~` label matchers, matching Grafana's own rendering. Values are intentionally not regex-escaped: inside a double-quoted PromQL string `\.` is an illegal escape sequence, so escaping would produce `unknown escape sequence` parse errors (exact matching remains available via the explicit `${var:regex}` modifier).
- INTEGRATION.md records the real-machine verification matrix: variable overrides × operators × datasource types on an Elasticsearch dashboard, plus the legacy-datasource dashboards (string-uid and `$datasource`-referencing) across default, single-value, multi-value, and datasource-override states.

### Changed

- The `grafana_query` tool description and both READMEs now document the full `variables` usage: single values, multi-values with the format-modifier expansion table, adhoc overrides with the per-datasource translation matrix, and the supported operators.

### Changed

- Internal refactor with no behavior change: the single 1130-line `index.js` is split into layered modules under `lib/` (constants, generic utilities, approval copy, dashboard diff, query summary, stateful runtime, and per-tool definitions), leaving `index.js` as a thin assembly entry. All exports (`name`/`inject`/`SETTINGS_NAMESPACE`/`Config`/`apply`/`internals`), tool schemas, error messages, timeouts, and limits are unchanged; the npm package now ships the `lib/` directory alongside `index.js` and `client.js`.
- `deploy.sh` now pre-checks GitHub CLI and npm credentials at the very start of `all` and before `release` commits, tags, and pushes (previously the npm login check only ran in the final `publish` step, so an expired or missing login was discovered only after the version was locked and the tarball built, forcing a full re-run). `publish` keeps its own check for direct invocations.

### Fixed

- `grafana_query`: when every selected panel is skipped (unresolved variables, empty targets, unresolved datasources), the error now lists each skipped panel's id, title, and skip reason instead of a bare `The selected panel(s) yielded no executable query.`
- `grafana_query`: applying adhoc filters to a passthrough (untyped) datasource now throws an explicit error instead of silently dropping the filters.
- `grafana_query`: variable values containing `\` or `"` (e.g. produced by the `:regex` or `:lucene` formats) no longer break query JSON round-trips — replacement values injected into serialized target JSON are now JSON-escaped, fixing `JSON.parse` "Bad escaped character" failures that had silently applied to any such value even before format modifiers existed.
- `grafana_query` adhoc label-matcher injection no longer treats `$__rate_interval`-style built-in variables inside range brackets as metric names (previously produced invalid expressions like `rate(x[$__rate_interval{...}])`), and no longer rewrites aggregation functions followed by `by`/`without` clauses (e.g. `sum by (instance) (...)`).

- `grafana_query` adhoc filters now actually reach Elasticsearch: earlier mechanisms (writing conditions into each query's `filters` array, or sending top-level request-level `adhocFilters`) were silently ignored by the ES backend on the `/api/ds/query` path. Filters are now expanded into each Elasticsearch target's Lucene query string (per target, honoring the adhoc variable's datasource binding): `=` → `field:"value"`, `!=` → `NOT field:"value"`, numeric `>`/`<` → `field:>N`; regex operators (`=~`/`!~`), non-numeric range values, and field names with Lucene-special characters throw explicit errors. Requests are again a single batch POST for the whole selection — restoring reliable `__expr__` panels whose `$A`-style references broke when queries were split into per-datasource-group requests — with the existing per-panel fallback intact.
- `grafana_query` no longer aborts the whole dashboard on an Expression panel: `$A`-style refId references inside `__expr__` targets are server-side expression references, not template variables, and are now passed through untouched; panels whose variable interpolation still fails are skipped and reported in the summary instead of failing the entire query.
- `grafana_query` no longer fails the whole dashboard when the batched `POST /api/ds/query` times out or errors: it automatically falls back to per-panel requests (each panel's failure is recorded individually) and reports whatever succeeded. Datasource queries get a dedicated 30s per-request timeout and the tool itself a 90s ceiling to leave room for the fallback.
- `grafana_query` table frames (for example Elasticsearch `terms` top-N panels) now show the real bucket keys in the recent-points section instead of `?=…`, which made ranking panels unusable; such frames are also summarized as `table by <field>: N rows; top: bucket=value, …` with the head (largest) buckets instead of degrading to `(unnamed series) N pts` — including results returned through the per-panel fallback path.
- `grafana_health` now reports the real `database` field from `GET /api/health` (e.g. `ok`/`failing`) instead of reading a nonexistent `status` field that made the output always read `health=ok`.
- The settings card now validates the Grafana URL before writing anything, so an invalid URL can no longer leave a half-saved state where the token was already stored; malformed URLs also show the localized error message instead of the native `new URL` exception.
- Release the response body when rejecting an oversized response early via its `Content-Length` header, so the connection no longer lingers until the request timeout.
- Show the configured Grafana URL in the settings card. The URL no longer lives in the write-only credential store (whose `describe` never returns the plaintext, so the card could only show "Configured" once the local mirror was lost); it is now stored in the `grafana` settings namespace as a non-secret field, read back in plaintext, and reliably displayed after saving. On startup the Host migrates any legacy `GRAFANA_BASE_URL` credential into settings and clears the credential entry; the credential value then serves only as a fallback. Token storage is unchanged (still write-only in the credential store).
- Restore the settings card after the DSH marketplace update: the `settings.plugin.item` slot is now keyed by Host-side settings namespace, so the plugin registers a `grafana` settings namespace on the Host (configuration now also honors the user settings layer, resolved above the composition entry) and the browser card registers with the matching `key` instead of the removed `id`/`order` list options.

### Security

- Route browser configuration through DSH's privileged credential RPC instead of a custom unauthenticated HTTP route.
- Require native DSH approval for every dashboard write.
- Build the `grafana_push` approval reason only from the server-trusted `grafana_get` snapshot (uid, title, version, folder) instead of parsing the model-supplied `dashboardJson`, so a hallucinated or tampered title cannot mislead the approver. The only value read from the arguments is the uid, used purely as the snapshot lookup key. Without a recent trusted snapshot the approval prompt states that the write will be rejected and asks for `grafana_get` first.
- Before showing the `grafana_push` approval prompt, re-check the dashboard live on the Grafana side (independent ~5s timeout) and surface version conflicts and folder changes as prominent warnings with both version numbers. A failed live check never blocks approval and never weakens the pre-write validation in `execute()`.
- When the live check succeeds, the `grafana_push` approval prompt now shows a bounded, sanitized content diff between the current Grafana-side dashboard and the proposed JSON (panels, template variables, and top-level fields added/removed/changed, including row-nested panels), so the approver can verify the actual change instead of the model-supplied change summary alone. All diff text comes from untrusted data and is collapsed to single lines and truncated, so it cannot forge approval lines; the diff is preview-only and never relaxes the pre-write validation.
- Show the requested destination folder in every write approval prompt, including explicit moves to General, so approving a write cannot silently authorize a folder change.
- Validate dashboard identity and version immediately before writing.
- Preserve the current folder by default and require explicit confirmation for folder moves.
- Support HTTP and HTTPS out of the box, with an `allowInsecureHttp: false` opt-out for HTTPS-only enforcement.
- Add request timeouts, cancellation, redirect rejection, bounded bodies, and sanitized API errors.
- Treat Grafana content as untrusted model data and document model-provider data boundaries.

### Added

- `grafana_get` accepts `summary: true` for a compact structural overview of large dashboards (panel title/type/datasource, queries, thresholds, overrides, and template variables) instead of the full JSON. Summary mode is read-only and records no write snapshot.
- `grafana_query`: paste the dashboard or panel-view browser URL (or a UID) and the tool executes the panel datasource queries via `POST /api/ds/query`, returning a bounded statistical summary of the live data (per series: min/max/avg/last plus recent points). A `?viewPanel=` URL parameter limits the query to that single panel, and the URL `from`/`to` time range is honored. Template variables are interpolated from the dashboard's current values or an explicit `variables` override; global built-ins (`$__interval`, `$__rate_interval`, …) pass through to the datasource. Read-only: no approval gate, no write snapshot recorded, and all returned text is sanitized and capped.
- `grafana_clone`: duplicate an existing dashboard into a brand-new dashboard (fresh UID, version 1) with panels, variables, and layout unchanged. It keeps the source folder by default (an explicit `folderUid` or empty-string General target is honored), defaults the title to `<source> (copy)`, returns the full new dashboard URL, requires `grafana_get` before a follow-up write, and goes through the same native approval gate as every other write.
- Automated tests and a Node 20/22/24 CI matrix.
- English default documentation and a Simplified Chinese translation.
- Explicit three-step `deploy.sh` release workflow (`release` → `build` → `publish`).
- npm publication in `./deploy.sh publish`: the packed tarball is uploaded to npm before the GitHub Release is created, and versions already on npm are skipped so failed runs can be retried safely.
- Security, contributing, conduct, and dependency-update policies.

### Changed

- Record `title`, `folderTitle`, and `folderUid` in the trusted snapshot written by `grafana_get` (title and folder title sanitized and truncated to 100 characters; `folderTitle` falls back to `folderUid` when Grafana does not provide one). The approval prompt now shows the snapshot age ("fetched X minutes ago") and the trusted folder name instead of a bare UID. Tool names, parameters, and result semantics are unchanged.
- Make the settings card collapsible: it renders collapsed by default (title, description, and a chevron) and expands on click, matching the official plugin cards in Settings → Plugins.
- Allow plain HTTP for non-loopback Grafana hosts by default so internal deployments without TLS work without extra configuration; HTTPS-only enforcement remains available via `allowInsecureHttp: false`.
- Localize the settings card (Simplified Chinese and English, following the GUI locale preference with browser-language fallback) and move the remove buttons next to their inputs.
- Default dashboard writes to `overwrite: false`.
- Add Grafana version-history messages, title/tag search limits, and Grafana-compatible UID validation.
- Pin the current DSH RC dependencies and declare the Node.js runtime baseline.
- Declare `@deepseek-ai/dsh-tools` as a host-provided peer dependency instead of a bundled dependency, avoiding a duplicate copy that could shadow the host version at runtime.

[Unreleased]: https://github.com/guhanfei-ai/dsh-grafana/commits/main
