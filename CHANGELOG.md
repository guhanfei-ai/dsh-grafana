# Changelog

All notable changes to this project are documented here. Release-specific notes are also published on GitHub Releases.

## [Unreleased]

### Security

- Route browser configuration through DSH's privileged credential RPC instead of a custom unauthenticated HTTP route.
- Require native DSH approval for every dashboard write.
- Validate dashboard identity and version immediately before writing.
- Preserve the current folder by default and require explicit confirmation for folder moves.
- Require HTTPS for non-loopback Grafana hosts unless explicitly overridden.
- Add request timeouts, cancellation, redirect rejection, bounded bodies, and sanitized API errors.
- Treat Grafana content as untrusted model data and document model-provider data boundaries.

### Added

- Automated tests and a Node 20/22/24 CI matrix.
- English default documentation and a Simplified Chinese translation.
- Explicit three-step `deploy.sh` release workflow (`release` → `build` → `publish`).
- npm publication in `./deploy.sh publish`: the packed tarball is uploaded to npm before the GitHub Release is created, and versions already on npm are skipped so failed runs can be retried safely.
- Security, contributing, conduct, and dependency-update policies.

### Changed

- Default dashboard writes to `overwrite: false`.
- Add Grafana version-history messages, title/tag search limits, and Grafana-compatible UID validation.
- Pin the current DSH RC dependencies and declare the Node.js runtime baseline.

[Unreleased]: https://github.com/guhanfei-ai/dsh-grafana/commits/main
