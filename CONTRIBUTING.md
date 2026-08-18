# Contributing

Thank you for helping improve dsh-grafana.

## Development setup

Requirements: Node.js 20.11 or newer and a compatible DeepSeek Harness installation.

```bash
npm ci
npm run verify
```

Use a local plugin link for manual testing:

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-grafana
```

## Pull requests

- Keep changes focused and preserve the existing no-build runtime format.
- Add or update tests for behavioral changes.
- Never include Grafana tokens, dashboard exports, internal URLs, or production API responses.
- Treat every write-path change as safety-sensitive: preserve approval, identity, version, and folder checks.
- Update both `README.md` and `README.zh-CN.md` when user-facing behavior changes.
- Run `npm run verify` and `npm pack --dry-run --ignore-scripts` before opening a pull request.

Use clear commit messages. Releases are created only through `publish.sh`; ordinary pushes must not create tags or Releases.

