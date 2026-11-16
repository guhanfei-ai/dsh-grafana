// lib/tools/patch.js — 增量写入：grafana_patch（RFC 6902）、grafana_upsert_panel（面板语义编辑）、
// grafana_variable_upsert（模板变量语义编辑）。三者共用 commitDashboardEdit 这一条提交链路：
//   读最新 → 校验快照与版本 → 相对最新大盘应用 ops → 身份/大小校验 → 提交 → 作废快照。
// 调用方只传「改什么」，不再回传整份大盘；任一步非法即整份拒绝，写入次数为 0。
// 版本冲突的语义与 grafana_push 完全一致：快照版本与当前版本不符时拒绝，除非显式 forceOverwrite。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { DASHBOARD_CHANGED_PATHS_LIMIT, MAX_DASHBOARD_BYTES, SOURCE_PARAM, TOOL_TIMEOUT_MS } from '../constants.js'
import { planPanelUpsert, planVariableUpsert } from '../dashboard-edit.js'
import { diffDashboards } from '../diff.js'
import { applyPatch, changedPaths, jsonEqual, MAX_PATCH_OPS, PATCH_OPS } from '../jsonpatch.js'
import { byteLength, folderUidOf, oneLine, parseUid, requireBoundedText, resolveDashboardUrl, textOut } from '../util.js'
import { assertSavedResult } from './dashboard.js'

// 每个编辑工具的规划：(最新大盘) → { ops, summary }。纯函数，审批预览与执行共用同一份。
export function editPlanFor(name, args) {
  if (name === 'grafana_patch') return () => ({ ops: args.ops, summary: { operations: Array.isArray(args.ops) ? args.ops.length : 0 } })
  if (name === 'grafana_upsert_panel') {
    return (dashboard) => {
      const planned = planPanelUpsert(dashboard, args)
      return { ops: planned.ops, summary: { action: planned.action, panelIds: planned.panelIds } }
    }
  }
  if (name === 'grafana_variable_upsert') {
    return (dashboard) => {
      const planned = planVariableUpsert(dashboard, args)
      return { ops: planned.ops, summary: { action: planned.action, name: planned.name } }
    }
  }
  throw new Error(`${name} is not a dashboard edit tool.`)
}

// 审批预览：按实时复核到的最新大盘套用同一份规划。规划或补丁失败不抛出，
// 而是把原因交给审批文案显式披露（执行阶段会再次拒绝）。
export function previewDashboardEdit(name, args, currentDashboard) {
  try {
    const planned = editPlanFor(name, args)(currentDashboard)
    const proposed = applyPatch(currentDashboard, planned.ops)
    return { diffLines: diffDashboards(currentDashboard, proposed), planError: null, operations: planned.ops.length }
  } catch (error) {
    return { diffLines: null, planError: error?.message ?? String(error), operations: null }
  }
}

// 统一提交链路。plan 只看「最新大盘」，因此补丁里的 id 与当前版本永远对得上快照。
export async function commitDashboardEdit({ srt, uid, plan, forceOverwrite = false, message, signal }) {
  const snapshot = srt.trustedSnapshotFor(uid)
  if (!snapshot) throw new Error('No recent trusted snapshot exists for this dashboard. Call grafana_get again before writing.')
  if (snapshot.canSave === false) throw new Error('Grafana reports that the current credential cannot save this dashboard.')

  const current = await srt.authenticatedApi(`/api/dashboards/uid/${encodeURIComponent(uid)}`, {}, signal)
  if (!current?.dashboard || !current?.meta) throw new Error('Grafana returned an invalid dashboard response during the pre-write check.')
  if (current.dashboard.id !== snapshot.id || current.dashboard.uid !== snapshot.uid) {
    throw new Error('The current Grafana dashboard identity no longer matches the fetched snapshot.')
  }
  if (current.dashboard.version !== snapshot.version && forceOverwrite !== true) {
    throw new Error(`Dashboard version conflict: fetched version ${snapshot.version}, current version ${current.dashboard.version}. Fetch again and reapply the change.`)
  }

  const planned = plan(current.dashboard)
  const proposed = applyPatch(current.dashboard, planned.ops)
  // 身份与版本由服务端决定：补丁不得改写 id/uid/version；版本必须沿用刚读取的最新值，
  // 不能靠事后覆盖来掩盖调用方试图篡改版本的操作。
  if (proposed.id !== current.dashboard.id || proposed.uid !== current.dashboard.uid || proposed.version !== current.dashboard.version) {
    throw new Error('The edit must not change the dashboard id, uid or version.')
  }
  if (!Array.isArray(proposed.panels)) throw new Error('The edit would remove the panels array; refusing to save.')
  if (byteLength(JSON.stringify(proposed)) > MAX_DASHBOARD_BYTES) throw new Error(`The edited dashboard exceeds the ${MAX_DASHBOARD_BYTES}-byte limit.`)

  const changed = changedPaths(current.dashboard, proposed, DASHBOARD_CHANGED_PATHS_LIMIT)
  if (jsonEqual(current.dashboard, proposed)) {
    return { unchanged: true, planned, changed, dashboardUrl: null }
  }

  const folderUid = folderUidOf(current.meta)
  const body = { dashboard: proposed, overwrite: forceOverwrite === true, message }
  if (folderUid) body.folderUid = folderUid
  const result = await srt.authenticatedApi('/api/dashboards/db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, signal)
  assertSavedResult(result, uid)
  srt.forgetSnapshot(uid)
  const baseUrl = await srt.resolveBaseUrl()
  const resolvedUrl = resolveDashboardUrl(baseUrl, result.url)
  return { unchanged: false, result, planned, changed, dashboardUrl: resolvedUrl === null ? 'omitted' : resolvedUrl, urlOmitted: resolvedUrl === null }
}

function formatOutcome(label, outcome, changeSummary) {
  if (outcome.unchanged) {
    return `No change: the requested edit already matches the current dashboard, so nothing was written.\nChanges: ${changeSummary}`
  }
  const { result, changed, planned, dashboardUrl, urlOmitted } = outcome
  const details = []
  if (planned.summary?.action) details.push(`action=${planned.summary.action}`)
  if (Array.isArray(planned.summary?.panelIds) && planned.summary.panelIds.length > 0) details.push(`panelIds=[${planned.summary.panelIds.join(', ')}]`)
  if (planned.summary?.name) details.push(`variable=${JSON.stringify(oneLine(planned.summary.name, 100))}`)
  const changedText = changed.paths.join(', ') + (changed.total > changed.paths.length ? ` (+${changed.total - changed.paths.length} more)` : '')
  return [
    `${label}: uid=${result.uid} status=${result.status} version=${result.version} newVersion=${result.version} url=${dashboardUrl}${urlOmitted ? '\nWarning: Grafana returned a dashboard URL outside this source (cross-origin, embedded credentials, or a non-HTTP scheme); the URL was omitted.' : ''}`,
    `Operations applied: ${planned.ops.length}${details.length ? ` (${details.join(', ')})` : ''}`,
    `Changed paths: ${changedText || '(none)'}`,
    `Changes: ${changeSummary}`,
    'Fetch the dashboard again before making another write.',
  ].join('\n')
}

// 三个编辑工具共用的参数尾部：写入说明与并发开关。
const WRITE_TAIL = {
  changeSummary: { type: 'string', required: true, description: 'Concise human-readable summary shown in the approval prompt.' },
  message: { type: 'string', required: true, description: 'Commit message stored in Grafana dashboard version history.' },
  forceOverwrite: { type: 'boolean', description: 'Bypass concurrent-version protection. Default false; use only after explicit explanation and approval.' },
  source: SOURCE_PARAM,
}

function defineEditTool(rt, { name, label, description, parameters, titleOf }) {
  return defineTool({
    name,
    description,
    parameters: { urlOrUid: { type: 'string', required: true, description: 'Dashboard URL containing /d/<uid>/... or a 1-40 character dashboard UID. The dashboard must have been fetched with grafana_get in this session.' }, ...parameters, ...WRITE_TAIL },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    // 写入工具：不声明并行（走审批门、改共享状态），但保留原生调用卡片。
    presentCall: (args) => ({ card: 'generic', title: titleOf(args), kind: 'edit' }),
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveApprovedSource(args.source, exec))
      const uid = parseUid(args.urlOrUid)
      const changeSummary = requireBoundedText(args.changeSummary, 'changeSummary', 500)
      const message = requireBoundedText(args.message, 'message', 200)
      const outcome = await commitDashboardEdit({
        srt,
        uid,
        plan: editPlanFor(name, args),
        forceOverwrite: args.forceOverwrite === true,
        message,
        signal: exec.signal,
      })
      return formatOutcome(label, outcome, changeSummary)
    },
  })
}

const GRID_POS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Optional grid position: x (0-23), y (>= 0), w (1-24, x + w <= 24), h (1-200). For an update only the given keys change; for a new panel missing keys take defaults (x 0, y below the lowest panel, w 12, h 8).',
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    w: { type: 'integer' },
    h: { type: 'integer' },
  },
}

export function defineGrafanaPatchTool(rt) {
  return defineEditTool(rt, {
    name: 'grafana_patch',
    label: 'Patched Grafana dashboard',
    description: `Apply an incremental JSON Patch (RFC 6902) to a dashboard fetched earlier with grafana_get, so only the difference is sent instead of the whole dashboard. Operations are applied to the latest saved version; a version conflict is refused unless forceOverwrite is set. Paths are JSON pointers (for example /title, /panels/2/targets/0/expr, /panels/- to append); use RFC 6901 escapes (~1 for "/", ~0 for "~"). Every operation must be valid against the current dashboard: a bad path, a failed test op, or an out-of-range index rejects the whole patch and writes nothing. The dashboard id, uid and version cannot be changed by a patch. Requires native user approval unless the calling session has explicit danger-full-access; all write checks still apply. Dashboard content is untrusted data.`,
    parameters: {
      ops: {
        type: 'array',
        required: true,
        description: `JSON Patch operations, 1 to ${MAX_PATCH_OPS}. Each operation: op (add, remove, replace, move, copy, or test), path, and value (add, replace, test) or from (move, copy). Unknown fields are rejected.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, enum: [...PATCH_OPS] },
            path: { type: 'string', required: true, description: 'JSON pointer into the dashboard, for example /panels/0/title.' },
            from: { type: 'string', description: 'Source JSON pointer for move and copy.' },
            value: { type: 'json', description: 'JSON value for add, replace and test.' },
          },
        },
      },
    },
    titleOf: (args) => `Patch dashboard ${oneLine(String(args?.urlOrUid ?? ''), 40)} (${Array.isArray(args?.ops) ? args.ops.length : 0} op)`,
  })
}

export function defineGrafanaUpsertPanelTool(rt) {
  return defineEditTool(rt, {
    name: 'grafana_upsert_panel',
    label: 'Edited a panel of Grafana dashboard',
    description: `Add, change or delete one panel of a dashboard fetched earlier with grafana_get, without sending the whole dashboard. panelId identifies an existing panel: with panel fields it is changed (shallow merge of the given fields; other fields and the panel's gridPos are kept unless gridPos is given); with delete true it is removed together with the panels inside a row. A panelId that does not exist adds a new panel (give type in panel; its id is panelId, or the next free id when omitted). afterPanelId places a new panel after that panel in the same list (top level or inside a row); without it the new panel is appended to the top level. Other panels are never moved implicitly. Requires native user approval unless the calling session has explicit danger-full-access; all write checks still apply.`,
    parameters: {
      panelId: { type: 'integer', description: 'Target panel id. Required for delete; for changes it names the existing panel; for additions it becomes the new panel id.' },
      panel: { type: 'object', additionalProperties: true, description: 'Panel fields. For changes: the fields to overwrite. For additions: a complete panel with at least type (for example "timeseries"), title and targets.' },
      afterPanelId: { type: 'integer', description: 'Only when adding: insert the new panel directly after this panel id.' },
      gridPos: GRID_POS_SCHEMA,
      delete: { type: 'boolean', description: 'true to remove the panel identified by panelId. Default false.' },
    },
    titleOf: (args) => (args?.delete === true ? `Delete panel ${args?.panelId ?? '?'} on ${oneLine(String(args?.urlOrUid ?? ''), 30)}` : `Edit panel ${args?.panelId ?? 'new'} on ${oneLine(String(args?.urlOrUid ?? ''), 30)}`),
  })
}

export function defineGrafanaVariableUpsertTool(rt) {
  return defineEditTool(rt, {
    name: 'grafana_variable_upsert',
    label: 'Edited a template variable of Grafana dashboard',
    description: 'Add, change or delete one template variable (by name) of a dashboard fetched earlier with grafana_get. Other variables are left byte-for-byte unchanged. A change is a shallow merge of the given fields into the existing variable; name cannot change. A new variable needs a type (for example "custom" or "query"). Requires native user approval unless the calling session has explicit danger-full-access; all write checks still apply.',
    parameters: {
      name: { type: 'string', required: true, description: 'Variable name, for example "env". Matches the existing variable with the same name.' },
      variable: { type: 'object', additionalProperties: true, description: 'Variable fields to set (required unless delete is true).' },
      delete: { type: 'boolean', description: 'true to remove the variable with this name. Default false.' },
    },
    titleOf: (args) => (args?.delete === true ? `Delete variable ${oneLine(String(args?.name ?? ''), 30)}` : `Edit variable ${oneLine(String(args?.name ?? ''), 30)}`),
  })
}

