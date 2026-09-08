# dsh-grafana

[简体中文](./README.zh-CN.md)

A DeepSeek Harness plugin for fetching, editing, and safely updating Grafana dashboards through conversation. It operates on dashboard JSON directly—no screenshots required.

> Project status: pre-1.0. The safety controls and automated tests cover the core update path, but Grafana 12+ compatibility is not yet certified.

## Why dsh-grafana

- Fetch a dashboard by browser URL or UID, or request a compact structural summary for large dashboards.
- Search dashboards by title and tag.
- Query the live data behind panels by pasting the dashboard or panel-view URL.
- Duplicate a dashboard into a brand-new copy and get its URL back.
- Edit panels, queries, thresholds, variables, and layout through conversation.
- Preserve the dashboard folder automatically.
- Detect concurrent edits before writing.
- Require native DSH user approval for every write.
- Keep service-account credentials in the local DSH credential store.
- Configure several named Grafana sources and target one per tool call.

## Requirements

| Component | Supported baseline |
| --- | --- |
| Node.js | 20.11 or newer |
| DeepSeek Harness | `0.1.0-rc.6` through `0.1.3` prereleases (verified: `0.1.0-rc.6`, `0.1.1-rc.2`, `0.1.2-rc.1`, `0.1.3-alpha.2`) |
| Grafana | Legacy Dashboard HTTP API as documented for Grafana 10/11 |

Grafana 12 introduced a new dashboard API. The legacy endpoints used by this plugin may remain available, but Grafana 12+ is not part of the certified matrix yet.

There is no build step: the plugin is plain ESM JavaScript, so installing it is enough — nothing to compile or bundle before it loads.

## Installation

Install a released, immutable tag whenever possible:

```bash
dsh plugin --profile <profile> add github:guhanfei-ai/dsh-grafana#v<version>
```

Install the mutable development branch only for testing:

```bash
dsh plugin --profile <profile> add github:guhanfei-ai/dsh-grafana
```

For local development:

```bash
npm ci
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-grafana
```

Restart the selected DSH profile after installation.

On Windows, use an absolute `link:C:/path/to/dsh-grafana` path. The plugin itself is cross-platform; `deploy.sh` requires Git Bash, WSL, macOS, or Linux.

## Upgrading to 0.12.0

**Two tools were renamed.** `grafana_query` is now `grafana_panel_query`, and `grafana_health` is now `grafana_status`. Parameters, outputs, timeouts, and approval behavior are unchanged.

| Before | After |
| --- | --- |
| `grafana_query` | `grafana_panel_query` |
| `grafana_health` | `grafana_status` |

The old names stay registered as error-only stubs: calling `grafana_query` or `grafana_health` fails immediately with a message naming the new tool, so an ongoing conversation recovers in one step. Custom prompts and saved workflows that reference the old names should still be updated, and per-agent tool allowlists need the new names.

**The browser settings card requires DSH 0.1.2 or newer.** On older hosts (0.1.0–0.1.1) the card shows an explicit "host too old" notice instead of the source list — that is a version gate, not lost configuration. All host-side tools keep working on those hosts, and the plugin still installs on `0.1.0-rc.6` and newer.

**Configuration migrates automatically.** A single-source configuration from earlier versions is materialized into a named `default` source on startup (same base URL, same stored token). No manual step is required, and the migration never overwrites a configuration you saved while it was running.

## Configuration

In DSH Web, open **Settings → Plugins → Grafana dashboard editor**.

> Note: the settings page dispatches plugin cards by the settings namespace registered on the Host (`grafana`). The served-namespace list is re-read only on settings-document commits or connection resets, so if the card does not appear right after upgrading the plugin, refresh the page (or reconnect the Web UI).

Configure:

- **Service Account Token**: a Grafana service-account token such as `glsa_...`.
- **Grafana URL**: the absolute base URL, for example `https://grafana.example.com` or `https://example.com/grafana`.

The token uses DSH's privileged loopback credential RPC — write-only, the stored value is never read back or displayed. The URL is stored in the `grafana` settings namespace as a non-secret field, so it is read back in plaintext and shown in the card for verification. The UI supports replacing and removing each value.

HTTP and HTTPS both work out of the box — internal deployments without TLS certificates can use an `http://` URL with no extra setup. Note that plain HTTP sends the service-account token in cleartext; always use HTTPS over untrusted networks. To enforce HTTPS only, disable it in plugin configuration:

```yaml
allowInsecureHttp: false
```

The settings `baseUrl` is the authoritative source; a legacy `GRAFANA_BASE_URL` credential (from earlier versions) is migrated into settings on startup and then used only as a fallback. The token reference defaults to `GRAFANA_TOKEN` and can be changed with `tokenRef`.

### Multiple Grafana sources

The settings card manages a **list of named Grafana sources** rather than a single URL/token pair. Each source has:

- **Source name** (required, unique): any language. This is the value you pass as the `source` argument to target that instance.
- **UID** (read-only): an auto-generated, globally unique id shown in faint text right under the name. It is the stable internal key — renaming a source never changes its UID or its stored token, and it can never be edited.
- **Grafana URL** and **Service Account Token**: independent per source. Each token is stored write-only in the DSH credential store under its own reference (`GRAFANA_TOKEN_<uid>`); the migrated default source keeps the legacy `GRAFANA_TOKEN` reference.

Click **Add source** to create one, **Remove source** to delete it (its stored token is cleared too), and **Set as default** to choose which source is used when a tool call omits `source`. **Save** persists the whole list; every name and URL is validated before anything is written, so an invalid entry never leaves a half-saved state.

Every tool accepts an optional `source` argument (a configured source name); omit it to use the default source. Call `grafana_sources` to list the configured names, UIDs, base URLs, which token is configured, and which source is the default. Write approvals always show the target source name and URL on the first line so you can confirm which instance is modified. A single-source configuration from earlier versions is migrated on startup into one source named `default`. `allowInsecureHttp` remains a global setting that applies to all sources.

### Grafana permissions

Prefer least-privilege RBAC with only the required dashboard and folder scopes:

- `dashboards:read`
- `dashboards:write`
- `folders:read` for the folders being edited
- `datasources:query` plus access to the datasources queried by `grafana_panel_query`

When fine-grained RBAC is unavailable, Grafana's Editor role is the fallback. Avoid Admin tokens.

The exact scope each tool needs:

| Tool | Grafana permission |
| --- | --- |
| `grafana_get` | `dashboards:read` |
| `grafana_push` | `dashboards:read` + `dashboards:write` |
| `grafana_clone` | `dashboards:read` + `dashboards:write` |
| `grafana_panel_query` | `dashboards:read` + `datasources:query` |
| `grafana_datasources` | `datasources:read` |
| `grafana_metric` | `datasources:read` + `datasources:query` |
| `grafana_trend` | `dashboards:read` + `datasources:query` |
| `grafana_alerts` | `alert.instances:read`; `definitions: true` also needs `alert.provisioning:read` |
| `grafana_search` | `dashboards:read` |
| `grafana_status` | `dashboards:read` (see note) |
| `grafana_sources` | none (reads local plugin configuration only) |

A read-mostly setup is the Viewer basic role plus Grafana's fixed read-only Alerting role; add `dashboards:write` (or the Editor basic role) only for the token that runs `grafana_push` / `grafana_clone`. Note on `grafana_status`: `/api/health` needs no authentication, so the tool confirms the credential by calling `GET /api/search` and reading the instance health from the `database` field of `/api/health` (there is no `status` field).

## Coverage

What sets this plugin apart from a single-purpose Grafana bridge:

- **Multiple named sources** (up to 50): every tool takes an optional `source` argument and write approvals name the target instance, so one plugin serves a whole fleet of Grafanas.
- **Credentials never touch the settings document**: tokens live write-only in the DSH credential store and are reached through a privileged loopback RPC, so they are never read back, displayed, or synced.
- **A browser settings card**: sources are added, edited, and validated from a native settings UI — no hand-editing of config files.

The tool surface covers the full read-to-write loop:

| Capability | Tool |
| --- | --- |
| Read a dashboard (full JSON or structural summary) | `grafana_get` |
| Edit a dashboard | `grafana_push` |
| Write / create | `grafana_push`, `grafana_clone` |
| Clone a dashboard | `grafana_clone` |
| Search dashboards | `grafana_search` |
| Live panel values | `grafana_panel_query` |
| Trend of a dashboard's series | `grafana_trend` |
| Ad-hoc bare query (PromQL / LogQL) | `grafana_metric` |
| Datasource discovery | `grafana_datasources` |
| Active alerts & rule definitions | `grafana_alerts` |
| Source & credential health | `grafana_status`, `grafana_sources` |
| Multiple sources | every tool via `source` |

## Tools

Every tool accepts an optional `source` argument (a configured source name) to pick the target Grafana instance; omit it to use the default source. See [Multiple Grafana sources](#multiple-grafana-sources).

| Tool | Behavior |
| --- | --- |
| `grafana_get` | Fetches the complete dashboard and records a short-lived trusted version/folder snapshot. With `summary: true` it returns a compact structural overview (panels, queries, thresholds, variables) instead of the full JSON and records no write snapshot — preferred for large dashboards. |
| `grafana_push` | Updates a recently fetched dashboard after approval, identity checks, version checks, and folder preservation. |
| `grafana_clone` | Duplicates a dashboard into a brand-new dashboard (fresh UID, version 1), keeps the source folder by default, and returns the new dashboard URL. Requires approval and a subsequent `grafana_get` before further writes. |
| `grafana_panel_query` | Executes the panel datasource queries behind a pasted dashboard or panel-view URL (`?viewPanel=` limits the query to that single panel; the URL `from`/`to` range is honored) and returns a bounded summary of the live values. Template variables use saved dashboard state by default; override with the `variables` argument — single values (`{"env":"prod"}`), multi-values (`{"host":["www","m"]}`, expanded per the query's format modifier), or adhoc filters (see [Template variable overrides](#template-variable-overrides-grafana_panel_query)). Adhoc filters are translated per datasource type: Elasticsearch targets get Lucene clauses, Prometheus/Loki see label matchers injected into every vector/stream selector, and SQL datasources get the `${__adhoc}` placeholder replaced with a WHERE clause; other datasource types with active adhoc filters throw an explicit error listing the support matrix. Adhoc overrides replace saved filters entirely — `[]` clears them — and are applied per target datasource uid, so a variable bound to one datasource never touches another. Unsupported operator/datasource combinations throw instead of being silently dropped. Only `query`/`custom`/`interval`/`adhoc`/`textbox`/`constant`/`datasource` variable types can be overridden (datasource variables take a uid string); unsupported types throw an error. For Prometheus/Loki targets a bare multi-value variable renders as `(a|b)` so it works inside `=~` matchers. Legacy datasource references are resolved automatically: plain string uids and `{"uid":"$datasource"}` references to datasource-type variables are resolved via `GET /api/datasources` (the saved `"default"` maps to the default datasource). Server-side expressions (`$__expr__`, e.g. `$A / 60`) pass through untouched, panels that fail variable interpolation are skipped instead of aborting the whole dashboard — with each skipped panel's id, title, and reason listed when nothing remains — and a failed batch request automatically falls back to per-panel queries (the whole selection stays a single batch POST whenever possible, keeping `$A`-style expression references intact). Read-only; records no write snapshot. |
| `grafana_datasources` | Lists the datasources provisioned on a source (uid, plugin type, display name, whether it is the default, access mode). Filter by exact plugin type or a case-insensitive name substring; at most 40 rows, with any dropped rows disclosed on a final budget line. Call it before `grafana_metric` to learn which uid or name to query. Read-only. |
| `grafana_metric` | Runs one bare-text query (PromQL such as `up` or `rate(http_requests_total[5m])`, or a LogQL stream selector) directly against a Prometheus or Loki datasource, addressed by uid or exact display name — no dashboard needed. `mode: "instant"` (default) evaluates once at the range end; `mode: "range"` samples the series and reports per-series stats, a rising/falling/flat verdict, and a sparkline (a range query against loki returns log lines rather than numeric samples, so those series report a line count and the last line instead; on loki, instant mode accepts metric queries only — use range for log-stream selectors). Other plugin types and server-side expressions are rejected with a pointer to `grafana_panel_query`. Read-only; records no write snapshot. |
| `grafana_trend` | Answers "is it going up or down?" for a dashboard's panels in one call: every visible query target is re-run as a coarse range query and each series is reported with bucket count, first/last/min/max/avg, a direction verdict, and a sparkline. Table-shaped results report rows and stats with `trend=n/a` rather than a fabricated direction. Uses the same panel pipeline as `grafana_panel_query` (variables, adhoc filters, legacy datasource references, per-panel fallback). The range may span at most 90 days. Read-only; records no write snapshot. |
| `grafana_alerts` | Lists the alerts currently firing on a source from the built-in Alertmanager (default `state=firing`; `"suppressed"` for silenced/inhibited, `"all"` for both). Filter by folder, a case-insensitive substring across labels and annotations, or a dashboard URL/uid. Active alerts are capped at the `limit` argument (default 30, max 100) and rule definitions at 100 rows; anything dropped is disclosed on a final budget line. `definitions: true` appends the provisioned alert rule definitions in a second request (its own permission, its own failure isolation). Read-only; alert text is untrusted data. |
| `grafana_search` | Searches by optional title text and exact tag, returning at most 50 rows. |
| `grafana_status` | Checks connectivity and service-account validity. |
| `grafana_sources` | Lists the configured Grafana sources: each name, its read-only UID, base URL, whether its token is configured, and which one is the default. Read-only; never returns token values. Use it to discover valid source names before passing `source` to other tools. |

### Template variable overrides (`grafana_panel_query`)

The `variables` argument is a JSON object keyed by variable name. Every overrideable variable in the dashboard (`query`/`custom`/`interval`/`adhoc`/`textbox`/`constant`/`datasource` types) can be overridden; unsupported types throw an explicit error.

Single value — replaces the variable everywhere it appears (`$env`, `${env}`):

```json
{ "env": "prod" }
```

Multi-value — pass an array. The expansion follows the Grafana format modifier used in the query itself, so dashboards written for multi-select variables keep working:

```json
{ "host": ["www.example.com", "m.example.com"] }
```

For **Prometheus and Loki targets** a bare multi-value reference (`$host` with no modifier) renders as `(www.example.com|m.example.com)` — the alternation form that works inside `=~` label matchers, matching Grafana's own rendering. Values are not regex-escaped (Grafana does not escape them either; escaping a `.` as `\.` inside a double-quoted PromQL string is a syntax error). Use the explicit `${host:regex}` modifier when you need exact matching.

| Query placeholder | Expands to |
| --- | --- |
| `$host` / `${host}` | `www.example.com,m.example.com` (CSV, Grafana default) |
| `${host:csv}` | `www.example.com,m.example.com` |
| `${host:doublequote}` | `"www.example.com","m.example.com"` |
| `${host:singlequote}` | `'www.example.com','m.example.com'` |
| `${host:json}` | `["www.example.com","m.example.com"]` |
| `${host:raw}` | `www.example.com,m.example.com` |
| `${host:pipe}` | `www.example.com\|m.example.com` |
| `${host:percent}` | each value URL-encoded, comma-joined (`www.example.com,m.example.com`; `["a b"]` → `a%20b`) |
| `${host:querystring}` | `host=www.example.com&host=m.example.com` (keyed by the variable name) |
| `${host:regex}` | `www\.example\.com\|m\.example\.com` (each value regex-escaped, joined with `\|`) |
| `${host:lucene}` | each value Lucene-escaped, space-joined |
| `${host:sqlstring}` | `'www.example.com','m.example.com'` (single quotes doubled inside values) |

A single-value variable without a modifier expands to the bare value (byte-for-byte `String(value)`); modifiers apply to single values too (`${host:json}` → `"www.example.com"`, `${host:pipe}` → `www.example.com`). Unknown format modifiers throw an error. Built-in variables (`$__interval`, `$__rate_interval`, `${__from:date}`, …) always pass through untouched.

Adhoc filter override — replace the dashboard's saved adhoc filters entirely (`[]` clears them):

```json
{
  "adhoc": [
    { "key": "host.keyword", "operator": "=", "value": "www.example.com" },
    { "key": "status", "operator": "!=", "value": "404" }
  ]
}
```

An unbound adhoc entry applies to every datasource; add `"datasourceUid": "<uid>"` to bind it to one datasource. Translation depends on the datasource type:

| Datasource type | Translation | Supported operators |
| --- | --- | --- |
| Elasticsearch | Lucene clause merged into each target's query string (`host.keyword:"www.example.com"`; a non-empty panel query is wrapped in parentheses and combined with `AND`) | `=` `!=` always; `>` `<` numeric only; `=~` `!~` as Lucene regex `field:/pattern/` (`/` inside the pattern is escaped; an empty pattern throws) |
| Prometheus | Label matchers injected into every vector selector (`host="www.example.com"`; bare metric names get `{...}` added) | `=` `!=` `=~` `!~`; `>` `<` throw |
| Loki | Matchers injected into the stream selector (`{app="api", host="www.example.com"}`); pipeline stages are left untouched | `=` `!=` `=~` `!~`; `>` `<` throw |
| SQL (MySQL/Postgres/MSSQL/MariaDB/SQLite/ClickHouse) | `${__adhoc}` / `$__adhoc` placeholder in `rawSql` replaced with a `WHERE`-style clause (`host = 'www.example.com'`; values single-quote-escaped) | `=` `!=` `>` `<` (numeric) `=~` `!~` (mapped to `LIKE`/`NOT LIKE`) |
| Anything else | Explicit error listing the supported types | — |

Datasource-type variables — override with a datasource uid string:

```json
{ "datasource": "prom-prod" }
```

Panels whose datasource references the variable (`{"type":"prometheus","uid":"$datasource"}`) are re-pointed at the given uid. A non-string value (number, array) throws an explicit error.

### Legacy datasource references (`grafana_panel_query`)

Older dashboards reference datasources in shapes that `/api/ds/query` cannot use directly. `grafana_panel_query` resolves them transparently:

| Panel datasource shape | Resolution |
| --- | --- |
| Plain string uid (`"fixture-dash-0002"`-style, Grafana 8 and earlier) | Looked up via `GET /api/datasources`; the resolved `{type, uid}` is sent with each query |
| `{"uid":"$datasource"}` / `{"type":"prometheus","uid":"$datasource"}` (datasource-type template variable) | The variable's saved `current` value is interpolated into the uid |
| Saved value `"default"` | Mapped to the server's default datasource (`"default"` is a reserved pseudo-uid that `/api/ds/query` rejects) |
| Index unavailable (403) or uid unknown | The raw `{uid}` is passed through so Grafana itself reports the problem; if active adhoc filters cannot be translated for an untyped datasource, an explicit error is thrown instead |

The datasource index is fetched lazily — only when a dashboard actually contains references that need resolution. When every panel is skipped, the error lists each panel's id, title, and skip reason instead of a bare "no executable query".

A real-machine verification matrix (variable overrides × operators × datasource types, legacy dashboard shapes) is recorded in [INTEGRATION.md](INTEGRATION.md).

### Safe update workflow

1. Ask DSH to fetch a dashboard URL or UID.
2. Describe the requested changes.
3. Review the write approval prompt, including the dashboard identity and change summary.
4. Approve or reject the update.
5. Refresh Grafana and fetch again before another write.

`grafana_push` defaults to `overwrite: false`. It preserves the current folder, re-fetches the dashboard immediately before writing, and rejects stale versions. Folder moves require `allowFolderMove: true`. Forced overwrite requires `forceOverwrite: true` and still triggers approval.

The dashboard identity shown in the approval prompt (uid, title, version, folder) and the "fetched X minutes ago" label come entirely from the server-trusted snapshot recorded by `grafana_get`, never from the model-submitted dashboard JSON, so a hallucinated or tampered title cannot mislead the approver. Without a recent trusted snapshot the prompt states that the write will be rejected and asks for `grafana_get` first. Right before the prompt appears, the plugin also re-checks the live Grafana state: version or folder mismatches are surfaced as prominent warnings with both version numbers, and an unreachable Grafana is called out as "unable to confirm the current state". This live check only enriches the approval copy; the final validation always runs again at write time. When the live check succeeds, the prompt also includes a bounded, sanitized content diff between the current Grafana-side dashboard and the proposed JSON (panels, template variables, and top-level fields added, removed, or changed), so the approver can verify the actual change instead of relying on the model-supplied change summary alone.

## Security and data boundaries

- Tokens never enter tool arguments, model messages, logs, or Git.
- Authenticated requests reject HTTP redirects to avoid forwarding credentials to another origin.
- Non-loopback HTTP is disabled by default.
- Requests have cooperative cancellation, timeouts, bounded responses, and bounded dashboard input.
- Error responses expose only a bounded status/message description.
- Grafana content is treated as untrusted data, not model instructions.

Dashboard JSON can still contain sensitive SQL, internal hostnames, links, labels, and business metadata. Fetching a dashboard sends that JSON to the configured model provider as tool context. Review your model provider's data policy before using this plugin with confidential dashboards.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting and supported-version policy.

## Development

```bash
npm ci
npm run verify
npm pack --dry-run --ignore-scripts
```

Tests use Node's built-in test runner and mocked Grafana responses. CI verifies Node 20, 22, and 24.

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CHANGELOG.md](./CHANGELOG.md).

## Publishing

Ordinary manual pushes do not trigger versioning or releases. Publishing is an explicit three-step flow from a clean, already committed `main` branch:

```bash
./deploy.sh release   # lock the version: bump, commit, tag, push (patch/minor/major or x.y.z)
./deploy.sh build     # verify and pack the tarball into dist/
./deploy.sh publish   # publish the tarball to npm, then create the GitHub Release with it
```

Run `./deploy.sh` with no arguments for the built-in help. Run `gh auth login` and `npm login` once before the first release. Each step guards itself: `all` and `release` pre-check the GitHub CLI and npm login state up front (so an expired or missing credential fails before the version is locked, tagged, and pushed), `release` requires a clean synced `main`, `build` requires the tag to sit on `HEAD`, and `publish` requires the packed tarball plus GitHub and npm credentials. Every remote-mutating step asks for confirmation first.

`publish` uploads the exact tarball from `dist/` to npm first, then attaches the same file to the GitHub Release, so both channels serve byte-identical artifacts. npm versions are immutable: if `dsh-grafana@<version>` already exists on npm, the npm step is skipped and only the GitHub Release is created. The script never overwrites an existing GitHub Release.

### npm prerequisites

One-time setup before the first npm publish:

1. Use an npmjs.com account with a verified email and two-factor authentication enabled for writes.
2. Run `npm login` and confirm with `npm whoami`.
3. The unscoped name `dsh-grafana` is already reserved under the package owner account. Switching to an organization scope such as `@guhanfei-ai/dsh-grafana` requires changing `package.json` first; `deploy.sh` reads the package name from there.

With write 2FA enabled, `npm publish` prompts for a one-time password interactively. For non-interactive runs, pass it through the `NPM_OTP` environment variable.

For supply-chain provenance, prefer npm Trusted Publishing from a dedicated CI workflow with `--provenance` over local publishing: a local login cannot provide the CI OIDC identity that provenance requires.

## License

[MIT](./LICENSE)
