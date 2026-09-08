# Changelog

All notable changes to this project are documented here. Release-specific notes are also published on GitHub Releases.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Up to and including `0.11.0` the entries accumulated under a single `[Unreleased]` heading; they have been retro-fitted into per-release sections using the release tags as the attribution evidence, and their wording is unchanged.

## [Unreleased]

### Added

- The pre-0.12.0 tool names stay registered as error-only stubs: calling `grafana_query` or `grafana_health` fails immediately with a message naming the new tool (`grafana_panel_query` / `grafana_status`), so an existing conversation recovers in one step instead of hitting an unregistered-tool error that does not point anywhere. The stubs issue no requests, never enter the approval gate, and record no write snapshot. Per-agent tool allowlists and saved workflows should still be updated to the new names.

### Fixed

- Sources are saved in one atomic settings transaction. The client previously wrote them in two steps — `mutate(unset ['sources'])` followed by `update(...)` — so a failure of the second step left the sources array cleared with the new value never written, losing every configured source at once. Both fields are now sent as two `set` ops inside a single `mutate` call, which the host applies and persists as one unit: a rejected write leaves the stored list untouched. Verified against the host-side `@deepseek-ai/dsh-settings` implementation (op arrays apply in one write-queue transaction; `set` replaces a path value wholesale, arrays included).
- The startup legacy migration now refuses to overwrite a configuration that was saved while the migration was in flight. It reads the settings namespace together with its revision and carries that revision into the write, so a concurrent user save — which advances the revision — makes the host reject the migration with a conflict instead of materializing a default source over the just-saved list. When the revision is unavailable (older hosts), the write degrades to the previous unconditional behavior.
- Timeout budgets were aligned with each tool's worst-case request chain. A single `api()` GET can cost `2 × REQUEST_TIMEOUT_MS + retry delay ≈ 30.2s` (one retry on network errors and 502/503/504), but the tool-level timeouts only budgeted one round: `grafana_status` (two sequential GETs, worst 60.4s) ran with 35s, and `grafana_metric` (datasources GET + query POST, worst 60.2s) and `grafana_alerts` (two sequential GETs) ran with 45s — the host's tool abort fired first, so the model saw `timed out or was cancelled: POST /api/ds/query` and blamed the wrong request. `TOOL_TIMEOUT_MS` / `METRIC_TOOL_TIMEOUT_MS` / `ALERT_TOOL_TIMEOUT_MS` are now 75s, covering the worst chains with headroom (`grafana_push`/`grafana_clone` at worst 45.2s are covered by the same raise). `grafana_panel_query` keeps its 90s and `grafana_trend` its 120s tool budget: the trend fallback chain has no inherent cap (up to 50 panels), which the next entry addresses.
- The per-panel fallback in `grafana_panel_query` and `grafana_trend` now stops cleanly when the tool time budget is exhausted. Previously the host aborted `exec.signal` at the timeout while the fallback kept issuing one request per panel — every one failed instantly with `timed out or was cancelled`, producing a wall of misleading `failed:` rows that read like "every datasource is down". Panels not retried after the abort are now marked `failed: tool time budget exhausted before this panel could be retried`, distinguishing the tool's own deadline from datasource faults.
- An abort while reading a response body (server returned headers, then the body stream stalled past the timeout) no longer escapes the error translation layer: it used to surface as the platform's bare `This operation was aborted`, and now reports the same `Grafana API request timed out or was cancelled: <METHOD> <path>` as a fetch abort. A non-`Error` abort reason from the host no longer propagates raw out of the retry delay, either.
- `grafana_metric` no longer swallows an in-band query error. `/api/ds/query` can answer HTTP 200 with `results.<refId>.error` (datasource disabled, query refused); the tool used to render that as `series=0`, which reads as "no data". The error is now thrown with its upstream reason (sanitized, bounded), matching the panel pipeline's handling of the same shape.
- Truncation disclosure now covers the two remaining silent caps: `grafana_search` reports dropped rows past its 50-row cap on a final `budget:` line, and `grafana_get`'s `summary: true` mode does the same for lines past its 150-line cap, both matching the budget-line convention every other truncating tool already follows.

## [0.12.0]

### Added

- Read-only observability coverage beyond dashboards, as four new tools. `grafana_datasources` lists the datasources provisioned on a source (uid, plugin type, display name, default flag, access mode) with exact-type and case-insensitive name filtering. `grafana_metric` runs a single bare-text query (PromQL or a LogQL stream selector) directly against a Prometheus or Loki datasource — addressed by uid or exact display name — in instant or range mode, without needing a dashboard. `grafana_trend` re-runs a dashboard's visible query targets as coarse range queries and reports each series with bucket count, first/last/min/max/avg, a rising/falling/flat verdict, and a sparkline. `grafana_alerts` lists the alerts currently firing on a source from the built-in Alertmanager (firing by default; silenced and inhibited on request), filterable by folder, label/annotation substring, or dashboard, and can append the provisioned alert rule definitions in a second, independently-failing request.
- Bounded-output disclosure: every tool that can truncate its result (series caps, row caps, line caps) now ends with a single `budget:` line stating how much was shown and how much was hidden, instead of scattering per-item ellipsis notes.
- Actionable API failure diagnostics: upstream HTTP errors are translated by status code — 401/403 name the source and the exact Grafana permission the token is missing, 400 surfaces the upstream's structured query error (PromQL/LogQL parse position), and 404 distinguishes a wrong dashboard uid from an endpoint the instance does not expose. Credential-shaped strings in upstream error bodies are redacted before they reach the model.
- Per-source save buttons in the browser settings card. Previously every source shared a single Save button at the bottom of the card, so editing one source forced a whole-list save and there was no way to tell which source had unsaved changes. Each source card now has its own **Save this source** button (enabled only while that source has unsaved edits, with an “Unsaved” badge marking dirty cards), and the bottom button is now **Save all sources** for committing every draft at once. “Save this source” commits only that card's name/URL/token draft — every other source is written back with its stored value, leaving their in-progress drafts untouched — while a brand-new source is appended. Removing a source and setting the default now write immediately (removal also clears the source's stored token) instead of waiting for a save. The client keeps a `stored` baseline (the last `describe` result) alongside the editable drafts so per-card merge and dirty-checking are possible; the merge logic distinguishes a card that was removed from the store elsewhere (its stale draft is dropped) from a never-saved new card (its draft is kept), using the fact that a configured token can only ever belong to a persisted source. The new logic lives in three pure helpers exported for tests (`nextSourcesFor`, `rowDirty`, `mergeDrafts`); the remote contract is unchanged.

### Changed (breaking)

- **Breaking:** two tools were renamed to remove ambiguity inside the `grafana_` tool namespace. `grafana_query` is now `grafana_panel_query` — the tool has always been dashboard-driven (paste a dashboard or panel-view URL and it runs that dashboard's panel queries), and the new name says so instead of reading like a general-purpose query entry point. `grafana_health` is now `grafana_status`, which describes what it actually reports: the instance's own health plus whether the configured service-account credential works.

  | Before | After |
  | --- | --- |
  | `grafana_query` | `grafana_panel_query` |
  | `grafana_health` | `grafana_status` |

  Nothing else changed: parameters, outputs, timeouts, limits, approval behavior, and read/write semantics are identical, and the only edited error text is the tool name inside the adhoc-related messages. The matching internal exports were renamed too (`defineGrafanaQueryTool` → `defineGrafanaPanelQueryTool`, `defineGrafanaHealthTool` → `defineGrafanaStatusTool`); the frozen `internals` surface is unchanged. Per-agent tool allowlists, saved workflows, and any prompt or script that calls the old names must be updated.

### Fixed

- The browser settings card could neither read nor write anything on DeepSeek Harness `0.1.2` and later, and it failed **silently**: the card rendered as “No sources yet” with an empty list, the token badge always read “Not configured”, the saved language preference was ignored, saving never reached the settings document, and the browser console stayed completely clean. The client bundle resolved its remote facade as `ctx.get("connection").api`, but the `connection` handle published by `dsh-client-connection@0.1.2-rc.1` has no `api` key at all (its full key set is `isLoopback`/`generation`/`state`/`rpc`/`reconnect`/`registerGenerationSource`/`start`), so every card interaction threw `TypeError: Cannot destructure property 'api' of 'ctx.get(...)' as it is undefined` — which the card's `.catch(() => {})` swallowed and turned into a legitimate-looking empty state. Since `0.1.2` the real facade is `ctx.remote.<namespace>`, mounted as a cordis service named `remote.<ns>` by `dsh-api-gateway` and populated by `dsh-api-remotes`. Beyond the facade, all seven remote call sites also had the wrong argument shape and the wrong reply-unwrapping path: the real contract is positional arguments (`settings.describe()`, `credentials.describe(refs)`, `credentials.set(ref, value)`, `credentials.unset(ref)`, `settings.mutate(ns, ops, expectedRevision?)`, `settings.update(ns, patch, revision?)`) inside a `{ ok, value }` / `{ ok: false, error: { message } }` envelope, where `settings.describe()`'s `value` is the aggregate `{ writable, hasDocument, namespaces[] }`. Every one of those is now followed verbatim (the two-step `unset`-then-`update` write is unchanged — its `{ op: "unset", path: ["sources"] }` operation shape was already correct, it was merely wrapped in an object argument), and a rejected reply now raises its `error.message` instead of degrading to empty data. A follow-on defect in the same write path was fixed in a second round the same day: the gateway validates the **argument count** against the declared parameter list (`dsh-api-gateway` `prepareInvocation` throws `client api: <endpoint> expected N argument(s), got M` when `values.length` differs), so the optional-by-type third parameter of `settings.mutate` / `settings.update` (`expectedRevision`, typed `union([undefined, number()])`) still has to be passed explicitly — both calls now pass `void 0`, matching the official `dsh-client-ui-agent-preset` call site; before that, saving failed with `client api: settings/mutate expected 3 argument(s), got 2`.

  Two deliberate design points. First, the client `inject` list is now `["slots"]` rather than the `["remote", "remote.settings", "remote.credentials"]` used by the official settings UI packages: in cordis `4.0.2` any inject entry whose service is missing parks the fiber in `INACTIVE` forever, so the plugin never loads and the card disappears from the settings page entirely — strictly worse than the bug being fixed. The facade is therefore resolved at call time via `ctx.get("remote.settings")`, which returns `undefined` for an absent service instead of throwing (dot access `ctx.remote` would throw `cannot get property "remote" without inject`). There is no mount race: the settings page itself injects `["remote", "remote.settings"]`, so it cannot render at all until `dsh-api-remotes` has finished `$mount`. Second, a host that genuinely lacks the facade now shows an explicit “this DSH host is too old, please upgrade to `0.1.2` or newer” notice with Add/Save disabled, instead of an empty source list that reads like lost configuration. The `peerDependencies` range is unchanged and the legacy `connection.api` shape is no longer supported. The card's read path no longer swallows errors either — a failed `describe` surfaces its message in the card body; only `localePreference` still falls back to the browser language quietly, because a wrong caption is cosmetic and not worth interrupting the card for.

  This defect survived for two releases because `test/client.test.js` mocked the same wrong contract the implementation assumed, including a `connection.api` facade that does not exist on any real host, so the suite was green (`63/63`, later `76/76`) while the card was completely broken. The mock is now derived from a recorded real-host reply and from the official packages' call sites, deliberately provides no `connection` service, and can simulate an old host plus per-method `{ ok: false }` rejections. The rewrite was done red-first: before `client.js` was touched, 16 of the 17 client tests failed with the exact production `TypeError`; afterwards the client suite passes, and a second red-green round added a per-call-site argument-count assertion (the mock now records the arguments actually passed, via rest parameters, because the gateway counts them). The host-side `test/index.test.js` stays green, so nothing outside the client bundle regressed. No whole-suite figure is quoted here on purpose: an unrelated `0.12.0` change set was in flight in the same working tree while this fix landed, which makes any repo-wide count a moving target that is not attributable to this entry. The card's render path still has no DOM test harness in this repository, so the localized “host too old” copy is asserted through `client.js` `internals.STRINGS` rather than through a rendered tree.

- Compatibility with DeepSeek Harness `0.1.3` prereleases: the `@deepseek-ai/dsh-tools` peer range is now `^0.1.0-rc.6 || ^0.1.1-rc.0 || ^0.1.2-alpha.0 || ^0.1.3-alpha.0`, and devDependencies develop against `dsh-tools@0.1.3-alpha.2` (superseding the `0.1.2-rc.1` pin recorded under `0.10.0`). Under node-semver's prerelease matching rules a prerelease is only matched by comparators carrying the same `[major, minor, patch]` tuple, so the previous range — whose only prerelease comparator was `^0.1.2-alpha.0`, tuple `[0,1,2]` — did not match `0.1.3-alpha.2` despite it falling inside `>=0.1.2-alpha.0 <0.2.0`: installing this plugin into a host carrying dsh `0.1.3-alpha.2` (now on npm as the `alpha` dist-tag of both `@deepseek-ai/dsh` and `@deepseek-ai/dsh-tools`; `latest`/`next` remain `0.1.2-rc.1`) was blocked with npm ERESOLVE / pnpm strict peer errors, and the pinned devDependency could not exercise the suite against it. No **host** code needed changing, and the surfaces this plugin consumes were re-verified against the installed `0.1.3-alpha.2` packages rather than against an upstream source snapshot: `defineTool` still requires `output` and keeps the `execute(args, exec)` shape, the `tools/pre-execute` waterfall still yields `PreToolDecision`, `exec.signal` is still an `AbortSignal`, and `@deepseek-ai/dsh-settings`, `dsh-client-connection`, and `dsh-api-remotes` are all published at the same version; the full suite passes against them. `@deepseek-ai/dsh-client-runtime` stays in the client-inject list on purpose: upstream has published nothing beyond `0.1.1-rc.2`, hosts up to `0.1.1-rc.2` still need it, and `0.1.2`/`0.1.3` loaders skip the absent graph row without error.

  **Correction (2026-09-08).** This entry originally claimed that no *client* code needed changing either, on the grounds that the `0.1.2` settings-envelope work recorded under `0.10.1` already covered `0.1.3`. That claim is retracted: the client bundle was broken on `0.1.2` **and** `0.1.3` hosts, for a more basic reason that the `0.10.1` work never addressed — it read a `connection.api` facade that stopped existing in the `0.1.2` refactor. See the client-facade entry above. The `76/76` figure quoted here is likewise superseded (as of the client-facade fix, both the client and the host suites pass), and only its host-side half ever exercised real installed packages: `test/index.test.js` imports the real `dsh-tools`, whereas `test/client.test.js` is a `vm` sandbox whose mock, until that fix, encoded the same wrong contract as the implementation and so proved nothing.

## [0.11.0] - 2026-09-08

### Added

- Multiple named Grafana sources: the `grafana` settings namespace now holds a `sources` array (`{ id, name, baseUrl, tokenRef }`) plus a `defaultSource` id, and the browser settings card manages a list of sources instead of a single URL/token pair. Each source has a required, unique name (any language), an auto-generated read-only globally-unique UID shown in faint text under the name (the stable internal key — renaming a source never changes its UID or its stored token, and the UID can never be edited), and its own base URL and service-account token (stored write-only in the credential store under `GRAFANA_TOKEN_<uid>`). Every tool accepts an optional `source` argument (the source name; omit it to use the default source), and a new read-only `grafana_sources` tool lists the configured names, UIDs, base URLs, which token is configured, and which source is the default. Write snapshots are keyed by (source id, dashboard uid) so the same uid on two sources never collides, and `grafana_push`/`grafana_clone` approval prompts now state the target source name and URL on the first line so the approver can see which instance is modified. A single-source configuration from earlier versions is migrated on startup into one source named `default` that keeps the legacy `GRAFANA_TOKEN` reference; `allowInsecureHttp` remains a global setting applying to all sources, and the legacy `baseUrl`/`tokenRef` fields are retained only for migration and as an implicit single-source fallback.

## [0.10.1] - 2026-09-04

### Fixed

- The browser settings card now parses both shapes of the `settings.describe` reply, completing the `0.1.2-rc.1` compatibility on the client side: hosts from `0.1.2-rc.1` return the namespace descriptor array directly, while hosts up to `0.1.1` aggregate it under `result.value.namespaces`. Previously, on a `0.1.2-rc.1` host the array reply made the aggregate lookup yield `undefined` and the card silently fell back to showing the saved Grafana URL as unconfigured (descriptor fields `ns`/`value` are identical across both shapes, so no other consumption changed). The shared parser is exported as `client.js` `internals.settingsNamespacesOf` and covered by tests for both envelopes plus the malformed-reply fallback.

  **Correction (2026-09-08).** The premise of this entry was wrong and the fix it describes never worked. Hosts from `0.1.2-rc.1` do **not** return the namespace descriptor array directly *to the client*: `describe(): SettingsDescriptor[]` is the signature of the host-side `@deepseek-ai/dsh-settings` service, while the client remote always returned `{ ok, value }` with `value = { writable, hasDocument, namespaces[] }` — the same aggregate as `0.1.1`. The `Array.isArray(value)` branch added here could therefore never be taken (`res.result` is always `undefined` on a real host), and the card stayed broken; the symptom was also far wider than “the saved Grafana URL shows as unconfigured”. The parser has since been rewritten to the single real envelope — see the client-facade entry under `0.12.0`. The `63/63` green run quoted here only proved that the test mock and the implementation agreed with each other.

## [0.10.0] - 2026-09-04

### Fixed

- Compatibility with DeepSeek Harness `0.1.2-rc.1`: the `@deepseek-ai/dsh-tools` peer range is now `^0.1.0-rc.6 || ^0.1.1-rc.0 || ^0.1.2-alpha.0`. Under node-semver's prerelease matching rules the previous `^0.1.0-rc.6` matched only `0.1.0-rc.6/7/8` — installing this plugin into a host carrying dsh-tools `0.1.1-rc.2` or `0.1.2-rc.1` was blocked (npm ERESOLVE / pnpm strict peer errors). The plugin's own dsh-tools usage (`defineTool` only) is byte-identical across those versions, and the host services it consumes (`tools`, `systemPrompt`, `credentials`, `settings`, the `tools/pre-execute` waterfall, and the `slots`/`connection` client seeds) all survive the 0.1.2 refactor; the `@deepseek-ai/dsh-client-runtime` client-inject entry is intentionally kept because hosts up to `0.1.1-rc.2` still need it, while on `0.1.2` hosts the loader skips absent graph rows without error.
- `@deepseek-ai/schemastery` dependency relaxed from the exact `3.18.1` to `^3.18.1` so it dedupes onto the host's copy (dsh `0.1.2-rc.1` ships `3.18.2`; the two releases are code-identical apart from a cosmokit range bump). devDependencies now develop against `dsh-tools@0.1.2-rc.1`, and the full test suite passes against it.

## [0.9.0] - 2026-08-31

### Fixed

- `grafana_query` adhoc variables carrying a saved `OR` condition now throw an explicit error instead of being silently rewritten to `AND`: `OR` cannot be mapped safely into every supported datasource syntax, so the filter is reported rather than quietly changed into something else. The message names the variable, the offending condition, and its index, and points at the two ways out (override the variable with `AND` filters, or clear it with `[]`).
- `grafana_query` adhoc label-matcher injection now reaches Prometheus recording rules whose name starts with a colon (`:node_memory_utilisation:` and friends). A leading `:` is not an identifier start character, so such names used to be emitted first and the following name was then skipped as "attached to the previous token", leaving those selectors without matchers.
- `grafana_query` resolves an adhoc variable's datasource binding through the same `GET /api/datasources` index used for panel datasource references, so legacy bindings — a plain datasource name string, the `"default"` pseudo uid, or a reference to a datasource-type template variable — scope the filters to the datasource they were saved against instead of being treated as unbound and applied to every non-expression target.

## [0.8.1] - 2026-08-29

### Fixed

- `grafana_query`: row-panel leftover targets (a `{datasource, refId}` shape with no query text that Grafana saves on layout rows and never executes) are no longer sent to `/api/ds/query` — previously they reached Prometheus as empty-`expr` requests that failed with 400 `no expression found in input` and dragged the whole batch into the per-panel fallback. Such targets are now skipped up front with an explicit reason; dashboards like the Alertmanager template now run as a single clean batch.
- `grafana_query`: skip reasons are deduplicated per panel — the same message from every target of a panel collapses into one entry listing the affected target refIds (previously a 12-target panel repeated the identical reason 12 times in the all-skipped error).

## [0.8.0] - 2026-08-29

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
- Internal refactor with no behavior change: the single 1130-line `index.js` is split into layered modules under `lib/` (constants, generic utilities, approval copy, dashboard diff, query summary, stateful runtime, and per-tool definitions), leaving `index.js` as a thin assembly entry. All exports (`name`/`inject`/`SETTINGS_NAMESPACE`/`Config`/`apply`/`internals`), tool schemas, error messages, timeouts, and limits are unchanged; the npm package now ships the `lib/` directory alongside `index.js` and `client.js`.

### Fixed

- `grafana_query`: when every selected panel is skipped (unresolved variables, empty targets, unresolved datasources), the error now lists each skipped panel's id, title, and skip reason instead of a bare `The selected panel(s) yielded no executable query.`
- `grafana_query`: applying adhoc filters to a passthrough (untyped) datasource now throws an explicit error instead of silently dropping the filters.
- `grafana_query`: variable values containing `\` or `"` (e.g. produced by the `:regex` or `:lucene` formats) no longer break query JSON round-trips — replacement values injected into serialized target JSON are now JSON-escaped, fixing `JSON.parse` "Bad escaped character" failures that had silently applied to any such value even before format modifiers existed.
- `grafana_query` adhoc label-matcher injection no longer treats `$__rate_interval`-style built-in variables inside range brackets as metric names (previously produced invalid expressions like `rate(x[$__rate_interval{...}])`), and no longer rewrites aggregation functions followed by `by`/`without` clauses (e.g. `sum by (instance) (...)`).
- `grafana_query` adhoc filters now actually reach Elasticsearch: earlier mechanisms (writing conditions into each query's `filters` array, or sending top-level request-level `adhocFilters`) were silently ignored by the ES backend on the `/api/ds/query` path. Filters are now expanded into each Elasticsearch target's Lucene query string (per target, honoring the adhoc variable's datasource binding): `=` → `field:"value"`, `!=` → `NOT field:"value"`, numeric `>`/`<` → `field:>N`; regex operators (`=~`/`!~`), non-numeric range values, and field names with Lucene-special characters throw explicit errors. Requests are again a single batch POST for the whole selection — restoring reliable `__expr__` panels whose `$A`-style references broke when queries were split into per-datasource-group requests — with the existing per-panel fallback intact.
- `grafana_query` table frames (for example Elasticsearch `terms` top-N panels) now show the real bucket keys in the recent-points section instead of `?=…`, which made ranking panels unusable; such frames are also summarized as `table by <field>: N rows; top: bucket=value, …` with the head (largest) buckets instead of degrading to `(unnamed series) N pts` — including results returned through the per-panel fallback path.

## [0.7.1] - 2026-08-26

### Added

- `grafana_get` accepts `summary: true` for a compact structural overview of large dashboards (panel title/type/datasource, queries, thresholds, overrides, and template variables) instead of the full JSON. Summary mode is read-only and records no write snapshot.
- `grafana_query`: paste the dashboard or panel-view browser URL (or a UID) and the tool executes the panel datasource queries via `POST /api/ds/query`, returning a bounded statistical summary of the live data (per series: min/max/avg/last plus recent points). A `?viewPanel=` URL parameter limits the query to that single panel, and the URL `from`/`to` time range is honored. Template variables are interpolated from the dashboard's current values or an explicit `variables` override; global built-ins (`$__interval`, `$__rate_interval`, …) pass through to the datasource. Read-only: no approval gate, no write snapshot recorded, and all returned text is sanitized and capped.

### Fixed

- `grafana_query` no longer aborts the whole dashboard on an Expression panel: `$A`-style refId references inside `__expr__` targets are server-side expression references, not template variables, and are now passed through untouched; panels whose variable interpolation still fails are skipped and reported in the summary instead of failing the entire query.
- `grafana_query` no longer fails the whole dashboard when the batched `POST /api/ds/query` times out or errors: it automatically falls back to per-panel requests (each panel's failure is recorded individually) and reports whatever succeeded. Datasource queries get a dedicated 30s per-request timeout and the tool itself a 90s ceiling to leave room for the fallback.

## [0.7.0] - 2026-08-25

### Security

- When the live check succeeds, the `grafana_push` approval prompt now shows a bounded, sanitized content diff between the current Grafana-side dashboard and the proposed JSON (panels, template variables, and top-level fields added/removed/changed, including row-nested panels), so the approver can verify the actual change instead of the model-supplied change summary alone. All diff text comes from untrusted data and is collapsed to single lines and truncated, so it cannot forge approval lines; the diff is preview-only and never relaxes the pre-write validation.

## [0.6.1] - 2026-08-24

### Changed

- `deploy.sh` now pre-checks GitHub CLI and npm credentials at the very start of `all` and before `release` commits, tags, and pushes (previously the npm login check only ran in the final `publish` step, so an expired or missing login was discovered only after the version was locked and the tarball built, forcing a full re-run). `publish` keeps its own check for direct invocations.

### Fixed

- `grafana_health` now reports the real `database` field from `GET /api/health` (e.g. `ok`/`failing`) instead of reading a nonexistent `status` field that made the output always read `health=ok`.
- The settings card now validates the Grafana URL before writing anything, so an invalid URL can no longer leave a half-saved state where the token was already stored; malformed URLs also show the localized error message instead of the native `new URL` exception.
- Release the response body when rejecting an oversized response early via its `Content-Length` header, so the connection no longer lingers until the request timeout.

## [0.6.0] - 2026-08-23

### Added

- `grafana_clone`: duplicate an existing dashboard into a brand-new dashboard (fresh UID, version 1) with panels, variables, and layout unchanged. It keeps the source folder by default (an explicit `folderUid` or empty-string General target is honored), defaults the title to `<source> (copy)`, returns the full new dashboard URL, requires `grafana_get` before a follow-up write, and goes through the same native approval gate as every other write.

### Changed

- Record `title`, `folderTitle`, and `folderUid` in the trusted snapshot written by `grafana_get` (title and folder title sanitized and truncated to 100 characters; `folderTitle` falls back to `folderUid` when Grafana does not provide one). The approval prompt now shows the snapshot age ("fetched X minutes ago") and the trusted folder name instead of a bare UID. Tool names, parameters, and result semantics are unchanged.

### Security

- Build the `grafana_push` approval reason only from the server-trusted `grafana_get` snapshot (uid, title, version, folder) instead of parsing the model-supplied `dashboardJson`, so a hallucinated or tampered title cannot mislead the approver. The only value read from the arguments is the uid, used purely as the snapshot lookup key. Without a recent trusted snapshot the approval prompt states that the write will be rejected and asks for `grafana_get` first.
- Before showing the `grafana_push` approval prompt, re-check the dashboard live on the Grafana side (independent ~5s timeout) and surface version conflicts and folder changes as prominent warnings with both version numbers. A failed live check never blocks approval and never weakens the pre-write validation in `execute()`.
- Show the requested destination folder in every write approval prompt, including explicit moves to General, so approving a write cannot silently authorize a folder change.

## [0.5.1] - 2026-08-19

### Changed

- Localize the settings card (Simplified Chinese and English, following the GUI locale preference with browser-language fallback) and move the remove buttons next to their inputs.

### Fixed

- Show the configured Grafana URL in the settings card. The URL no longer lives in the write-only credential store (whose `describe` never returns the plaintext, so the card could only show "Configured" once the local mirror was lost); it is now stored in the `grafana` settings namespace as a non-secret field, read back in plaintext, and reliably displayed after saving. On startup the Host migrates any legacy `GRAFANA_BASE_URL` credential into settings and clears the credential entry; the credential value then serves only as a fallback. Token storage is unchanged (still write-only in the credential store).

## [0.5.0] - 2026-08-18

### Changed

- Make the settings card collapsible: it renders collapsed by default (title, description, and a chevron) and expands on click, matching the official plugin cards in Settings → Plugins.

### Fixed

- Restore the settings card after the DSH marketplace update: the `settings.plugin.item` slot is now keyed by Host-side settings namespace, so the plugin registers a `grafana` settings namespace on the Host (configuration now also honors the user settings layer, resolved above the composition entry) and the browser card registers with the matching `key` instead of the removed `id`/`order` list options.

## [0.4.0] - 2026-08-18

### Added

- Explicit three-step `deploy.sh` release workflow (`release` → `build` → `publish`).
- npm publication in `./deploy.sh publish`: the packed tarball is uploaded to npm before the GitHub Release is created, and versions already on npm are skipped so failed runs can be retried safely.

### Changed

- Allow plain HTTP for non-loopback Grafana hosts by default so internal deployments without TLS work without extra configuration; HTTPS-only enforcement remains available via `allowInsecureHttp: false`.
- Declare `@deepseek-ai/dsh-tools` as a host-provided peer dependency instead of a bundled dependency, avoiding a duplicate copy that could shadow the host version at runtime.

### Security

- Support HTTP and HTTPS out of the box, with an `allowInsecureHttp: false` opt-out for HTTPS-only enforcement.

## [0.3.2] - 2026-08-18

### Added

- Automated tests and a Node 20/22/24 CI matrix.
- English default documentation and a Simplified Chinese translation.
- Security, contributing, conduct, and dependency-update policies.

### Changed

- Default dashboard writes to `overwrite: false`.
- Add Grafana version-history messages, title/tag search limits, and Grafana-compatible UID validation.
- Pin the current DSH RC dependencies and declare the Node.js runtime baseline.

### Security

- Route browser configuration through DSH's privileged credential RPC instead of a custom unauthenticated HTTP route.
- Require native DSH approval for every dashboard write.
- Validate dashboard identity and version immediately before writing.
- Preserve the current folder by default and require explicit confirmation for folder moves.
- Add request timeouts, cancellation, redirect rejection, bounded bodies, and sanitized API errors.
- Treat Grafana content as untrusted model data and document model-provider data boundaries.

[Unreleased]: https://github.com/guhanfei-ai/dsh-grafana/commits/main
[0.11.0]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/guhanfei-ai/dsh-grafana/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/guhanfei-ai/dsh-grafana/releases/tag/v0.3.2
