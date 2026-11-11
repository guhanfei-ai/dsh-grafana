// Generic optional approval adapter for DSH plugins; no Grafana dependencies.
// Copy this module when a plugin's extra write confirmation should follow the
// caller's standing file policy. It does NOT enforce file or business rules.
function callingSession(ctx, exec) {
  try {
    const direct = exec?.agent?.session
    if (direct != null) return typeof direct === 'object' && !Array.isArray(direct) ? direct : null
    // Compatibility with hosts exposing an agent id instead of agent.session.
    const id = exec?.agent?.id
    const sessions = id ? (ctx.get?.('sessions') ?? ctx.sessions) : null
    const session = sessions?.get?.(id)
    return session && typeof session === 'object' && !Array.isArray(session) ? session : null
  } catch {
    return null
  }
}

/**
 * Return the next decision for this plugin's additional write confirmation.
 * Call after next() AND plugin-specific hard denials/target binding, but before
 * building an expensive approval preview. For `ask`, the caller supplies reason.
 * Preserve every upstream non-allow verbatim; never resolve it here.
 */
export function writeApprovalDecision(ctx, exec, decision) {
  if (decision?.kind !== 'allow') return decision
  // Cancellation may happen while next() is pending. Do not misclassify it as
  // a disabled-approval denial (the host preserves an existing error result).
  if (exec?.signal?.aborted) return { kind: 'cancel' }
  const session = callingSession(ctx, exec)
  if (session) {
    try {
      // Resolve afresh for the actual calling session. No mode override, cached
      // grant, deployment-default guess or tool argument may widen this policy.
      const policy = ctx.get?.('sandboxPolicy')?.resolve?.({ session })
      if (policy?.mode === 'danger-full-access') return decision
    } catch { /* Missing/broken optional capabilities never add permission. */ }

    try {
      const approval = ctx.get?.('approval')
      // Public overrideOf + config reproduce the host's policy precedence. A
      // missing override reader is unknown, not proof the default applies.
      if (typeof approval?.overrideOf === 'function') {
        const override = approval.overrideOf(session)
        const policy = override === undefined ? approval.config?.policy : override
        if (policy === 'never') {
          return {
            kind: 'deny',
            reason: 'Write approval is required, but approval prompts are disabled in this session (approval policy: never). Nothing was written. This is an automatic policy denial, not a user rejection. Enable approval prompts before retrying an action that requires confirmation.',
          }
        }
      }
    } catch { /* Unknown approval policy stays on the native fail-closed path. */ }
  }
  return { kind: 'ask' }
}
