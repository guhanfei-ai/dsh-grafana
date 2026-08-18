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

On Windows, use an absolute `link:C:/path/to/dsh-grafana` path. The plugin itself is cross-platform; `deploy.sh` requires Git Bash, WSL, macOS, or Linux.

## Configuration

In DSH Web, open **Settings → Plugins → Grafana dashboard editor**.

> Note: the settings page dispatches plugin cards by the settings namespace registered on the Host (`grafana`). The served-namespace list is re-read only on settings-document commits or connection resets, so if the card does not appear right after upgrading the plugin, refresh the page (or reconnect the Web UI).

Configure:

- **Service Account Token**: a Grafana service-account token such as `glsa_...`.
- **Grafana URL**: the absolute base URL, for example `https://grafana.example.com` or `https://example.com/grafana`.

Both values use DSH's privileged loopback credential RPC. Stored values are never read back or displayed. The UI supports replacing and removing each value.

HTTP and HTTPS both work out of the box — internal deployments without TLS certificates can use an `http://` URL with no extra setup. Note that plain HTTP sends the service-account token in cleartext; always use HTTPS over untrusted networks. To enforce HTTPS only, disable it in plugin configuration:

```yaml
allowInsecureHttp: false
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

Ordinary manual pushes do not trigger versioning or releases. Publishing is an explicit three-step flow from a clean, already committed `main` branch:

```bash
./deploy.sh release   # lock the version: bump, commit, tag, push (patch/minor/major or x.y.z)
./deploy.sh build     # verify and pack the tarball into dist/
./deploy.sh publish   # publish the tarball to npm, then create the GitHub Release with it
```

Run `./deploy.sh` with no arguments for the built-in help. Run `gh auth login` and `npm login` once before the first release. Each step guards itself: `release` requires a clean synced `main`, `build` requires the tag to sit on `HEAD`, and `publish` requires the packed tarball plus GitHub and npm credentials. Every remote-mutating step asks for confirmation first.

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
