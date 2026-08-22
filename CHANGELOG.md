# Changelog

All notable changes to this project are documented here. Release-specific notes are also published on GitHub Releases.

## [Unreleased]

### Fixed

- Show the configured Grafana URL in the settings card. The URL no longer lives in the write-only credential store (whose `describe` never returns the plaintext, so the card could only show "Configured" once the local mirror was lost); it is now stored in the `grafana` settings namespace as a non-secret field, read back in plaintext, and reliably displayed after saving. On startup the Host migrates any legacy `GRAFANA_BASE_URL` credential into settings and clears the credential entry; the credential value then serves only as a fallback. Token storage is unchanged (still write-only in the credential store).
- Restore the settings card after the DSH marketplace update: the `settings.plugin.item` slot is now keyed by Host-side settings namespace, so the plugin registers a `grafana` settings namespace on the Host (configuration now also honors the user settings layer, resolved above the composition entry) and the browser card registers with the matching `key` instead of the removed `id`/`order` list options.

### Security

- Route browser configuration through DSH's privileged credential RPC instead of a custom unauthenticated HTTP route.
- Require native DSH approval for every dashboard write.
- Build the `grafana_push` approval reason only from the server-trusted `grafana_get` snapshot (uid, title, version, folder) instead of parsing the model-supplied `dashboardJson`, so a hallucinated or tampered title cannot mislead the approver. The only value read from the arguments is the uid, used purely as the snapshot lookup key. Without a recent trusted snapshot the approval prompt states that the write will be rejected and asks for `grafana_get` first.
- Before showing the `grafana_push` approval prompt, re-check the dashboard live on the Grafana side (independent ~5s timeout) and surface version conflicts and folder changes as prominent warnings with both version numbers. A failed live check never blocks approval and never weakens the pre-write validation in `execute()`.
- Show the requested destination folder in every write approval prompt, including explicit moves to General, so approving a write cannot silently authorize a folder change.
- Validate dashboard identity and version immediately before writing.
- Preserve the current folder by default and require explicit confirmation for folder moves.
- Support HTTP and HTTPS out of the box, with an `allowInsecureHttp: false` opt-out for HTTPS-only enforcement.
- Add request timeouts, cancellation, redirect rejection, bounded bodies, and sanitized API errors.
- Treat Grafana content as untrusted model data and document model-provider data boundaries.

### Added

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
