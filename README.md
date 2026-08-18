# dsh-grafana

[简体中文](./README.zh-CN.md)

A DeepSeek Harness plugin for fetching, editing, and safely updating Grafana dashboards through conversation. It operates on dashboard JSON directly—no screenshots required.

> Project status: pre-1.0. The safety controls and automated tests cover the core update path, but Grafana 12+ compatibility is not yet certified.

## Why dsh-grafana

- Fetch a dashboard by browser URL or UID.
- Search dashboards by title and tag.
- Edit panels, queries, thresholds, variables, and layout through conversation.
- Preserve the dashboard folder automatically.
- Detect concurrent edits before writing.
- Require native DSH user approval for every write.
- Keep service-account credentials in the local DSH credential store.

## Requirements

| Component | Supported baseline |
| --- | --- |
| Node.js | 20.11 or newer |
| DeepSeek Harness | `0.1.0-rc.6` |
| Grafana | Legacy Dashboard HTTP API as documented for Grafana 10/11 |

Grafana 12 introduced a new dashboard API. The legacy endpoints used by this plugin may remain available, but Grafana 12+ is not part of the certified matrix yet.

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

On Windows, use an absolute `link:C:/path/to/dsh-grafana` path. The plugin itself is cross-platform; `publish.sh` requires Git Bash, WSL, macOS, or Linux.

## Configuration

In DSH Web, open **Settings → Plugins → Grafana dashboard editor**.

Configure:

- **Service Account Token**: a Grafana service-account token such as `glsa_...`.
- **Grafana URL**: the absolute base URL, for example `https://grafana.example.com` or `https://example.com/grafana`.

Both values use DSH's privileged loopback credential RPC. Stored values are never read back or displayed. The UI supports replacing and removing each value.

HTTPS is required for non-loopback hosts by default. Plain HTTP can be enabled explicitly in plugin configuration:

```yaml
baseUrl: http://grafana.internal:3000
allowInsecureHttp: true
```

An explicit `GRAFANA_BASE_URL` credential takes precedence over `baseUrl`. The token reference defaults to `GRAFANA_TOKEN` and can be changed with `tokenRef`.

### Grafana permissions

Prefer least-privilege RBAC with only the required dashboard and folder scopes:

- `dashboards:read`
- `dashboards:write`
- `folders:read` for the folders being edited

When fine-grained RBAC is unavailable, Grafana's Editor role is the fallback. Avoid Admin tokens.

## Tools

| Tool | Behavior |
| --- | --- |
| `grafana_get` | Fetches the complete dashboard and records a short-lived trusted version/folder snapshot. |
| `grafana_push` | Updates a recently fetched dashboard after approval, identity checks, version checks, and folder preservation. |
| `grafana_search` | Searches by optional title text and exact tag, returning at most 50 rows. |
| `grafana_health` | Checks connectivity and service-account validity. |

### Safe update workflow

1. Ask DSH to fetch a dashboard URL or UID.
2. Describe the requested changes.
3. Review the write approval prompt, including the dashboard identity and change summary.
4. Approve or reject the update.
5. Refresh Grafana and fetch again before another write.

`grafana_push` defaults to `overwrite: false`. It preserves the current folder, re-fetches the dashboard immediately before writing, and rejects stale versions. Folder moves require `allowFolderMove: true`. Forced overwrite requires `forceOverwrite: true` and still triggers approval.

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

Ordinary manual pushes do not trigger versioning or releases. To create an explicit release from a clean, already committed `main` branch:

```bash
bash ./publish.sh patch
# or: minor / major
```

Run `gh auth login` once before the first release. The script verifies the repository, increments the version, creates a release commit and tag, atomically pushes them, and creates GitHub Release notes. It asks for confirmation before mutating Git history or the remote.

npm publication is intentionally disabled until the package owner account and package name are configured.

### Reserving the npm name later

npm has no separate placeholder operation: the first valid publication reserves the package name. When ready:

1. Create an account at npmjs.com, verify the email address, and enable two-factor authentication for writes.
2. Run `npm login` and confirm with `npm whoami`.
3. Recheck availability with `npm view dsh-grafana`; a `404` means it is still unclaimed.
4. Decide between the current unscoped name `dsh-grafana` and an npm organization scope such as `@guhanfei-ai/dsh-grafana`. A scoped name requires changing `package.json` first.
5. From an immutable release commit, run `npm publish --access public`.

For provenance, configure npm Trusted Publishing with a dedicated CI workflow first, then add `--provenance` in that workflow. Local username/password or 2FA login does not provide the CI OIDC identity required for trusted provenance. npm publishing remains deliberately absent from `publish.sh` until that setup is complete.

Do not publish an empty placeholder package. Publish the verified plugin release so the reserved name has useful, auditable contents.

## License

[MIT](./LICENSE)
