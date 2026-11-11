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
- Treat every write-path change as safety-sensitive: preserve the effective approval policy, identity, version, and folder checks.
- Update both `README.md` and `README.zh-CN.md` when user-facing behavior changes.
- Run `npm run verify` and `npm pack --dry-run --ignore-scripts` before opening a pull request.

Use clear commit messages. Releases are created by the maintainer; ordinary pushes must not create tags or Releases.

## Reusing the write-approval adapter

Copy [the dependency-free adapter](<./lib/write-approval.js>) into your plugin. It uses optional public host capabilities, has no Grafana imports, and does not require new injected services. Adopting it is an explicit plugin policy choice: the host's file-effect mode does not inherently authorize remote-service writes.

```js
import { writeApprovalDecision } from './lib/write-approval.js'

const writeTools = new Set(['example_update', 'example_clone'])
ctx.on('tools/pre-execute', async (exec, next) => {
  const decision = await next()
  if (decision.kind !== 'allow' || !writeTools.has(exec.name)) return decision

  // Implement these business-specific checks in your plugin, not the adapter.
  if (isReadOnly()) return { kind: 'deny', reason: 'Plugin read-only mode is enabled.' }
  bindWriteTarget(exec)

  const approval = writeApprovalDecision(ctx, exec, decision)
  if (approval.kind !== 'ask') return approval
  return { kind: 'ask', reason: await buildApprovalPreview(exec) }
})
```

The adapter's decision order is intentional:

1. Preserve upstream `ask`, `deny`, or `cancel` verbatim. Full access is not permission to replace another gate's decision. If the signal was aborted while `next()` was pending, return `cancel` before inspecting policy; cancellation is not an automatic policy denial.
2. Resolve the current session from `exec.agent.session`, with legacy agent-id lookup as a fallback. Only `sandboxPolicy.resolve({ session }).mode === 'danger-full-access'` exempts this plugin's extra prompt. Never pass a mode override, trust tool arguments, inspect private session logs, or cache a full-access grant.
3. Without that exemption, a known `approval=never` denies with an accurate automatic-policy reason. The public `approval.overrideOf(session)` takes precedence over `approval.config.policy`; missing, throwing, or unknown capabilities stay on the normal native-approval path. Disabled prompts are never a grant.
4. Return `ask` otherwise; let the host resolve real approval, rejection, cancellation, and unavailable answerers. Never retry a rejected write through a different route.

Keep business validation inside `execute`: target identity, credential scope, revisions, size limits, explicit destructive-operation flags, and actual success checks. Bind targets before the adapter even when no prompt will be shown. A known-disabled-policy denial occurs before an approval request, so it has a tool failure result but no `approval/asked` / `approval/decided` pair; do not fabricate approval audit events.

[Regression tests](<./test/write-approval.test.js>) cover both write tools, live policy changes and session isolation, old/missing/broken capabilities, policy precedence, non-allow preservation, target binding, and write-time validation. Copy these boundary cases along with the module, not just the full-access happy path.

