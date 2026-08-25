// lib/approval.js — 审批文案纯函数：只信任服务端快照与实时复核结果，绝不解析待写 JSON 的标题。
import { UID_PATTERN } from './constants.js'
import { folderLabel, folderUidOf, parseUid } from './util.js'

// 审批文案只信任服务端快照与实时复核结果（P1）：绝不从 args.dashboardJson 解析
// 标题，避免模型幻觉或被篡改的标题误导审批人。args 中唯一被解析的 uid 也只
// 用作快照查找键，解析失败按无快照处理。
export function approvalUid(args) {
  try {
    const dashboard = JSON.parse(String(args?.dashboardJson ?? ''))
    if (dashboard && typeof dashboard === 'object' && typeof dashboard.uid === 'string' && UID_PATTERN.test(dashboard.uid)) {
      return dashboard.uid
    }
  } catch {
    // 解析失败按无快照处理，写回会在审批后的工具执行阶段被拒绝。
  }
  return null
}

export function snapshotAgeLabel(fetchedAt, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000))
  if (minutes === 0) return 'less than a minute ago'
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
}

// folderUid 是实际执行阶段会采用的结构化参数，因此审批时必须明确展示；
// 显式空串代表 General，与「未提供、保持当前目录」是两种不同操作。
export function requestedFolderApprovalLine(args, snapshot, live) {
  if (typeof args?.folderUid !== 'string') return null
  const requestedFolderUid = args.folderUid.trim()
  if (requestedFolderUid && !UID_PATTERN.test(requestedFolderUid)) {
    return '⚠️ INVALID TARGET FOLDER UID: the write will be rejected.'
  }

  const currentMeta = live?.ok ? live.current?.meta : null
  const currentFolderUid = currentMeta ? folderUidOf(currentMeta) : snapshot.folderUid
  const currentFolderTitle = currentMeta?.folderTitle ?? snapshot.folderTitle
  const requestedLabel = folderLabel('', requestedFolderUid)
  if (requestedFolderUid === currentFolderUid) {
    return `Requested destination folder: ${requestedLabel} (unchanged).`
  }

  const confirmation = args?.allowFolderMove === true
    ? 'allowFolderMove=true.'
    : 'allowFolderMove is not true, so the write will be rejected.'
  return `⚠️ REQUESTED FOLDER MOVE: current folder ${folderLabel(currentFolderTitle, currentFolderUid)} → destination ${requestedLabel}. ${confirmation}`
}

// 纯函数：根据调用参数 + 可信快照 + 实时复核结果生成审批文案，便于单测。
// snapshot / live 为 null 表示对应信息缺失（无快照 / 未做实时复核）；
// diffLines 为实时复核成功时生成的内容 diff 行，仅用于展示预览。
export function approvalReason(args, snapshot, live = null, diffLines = null) {
  const summary = String(args?.changeSummary ?? 'No summary supplied').replace(/[\r\n\t]+/g, ' ').slice(0, 300)
  const force = args?.forceOverwrite === true ? ' FORCE OVERWRITE requested.' : ''
  const uid = approvalUid(args)
  if (!uid || !snapshot) {
    return [
      `Write Grafana dashboard uid=${uid ?? 'unknown'}: no recent trusted snapshot.`,
      'There is no recent trusted snapshot for this dashboard; the write will be rejected. Call grafana_get first.',
      `Changes: ${summary}.${force}`,
    ].join('\n')
  }
  const lines = [
    `Write Grafana dashboard uid=${snapshot.uid}, title=${JSON.stringify(snapshot.title || 'unknown')}, snapshot version ${snapshot.version} (fetched ${snapshotAgeLabel(snapshot.fetchedAt)}), folder ${folderLabel(snapshot.folderTitle, snapshot.folderUid)}.`,
    `Changes: ${summary}.${force}`,
  ]
  if (Array.isArray(diffLines)) {
    if (diffLines.length === 0) lines.push('Diff vs current Grafana dashboard: no content differences detected.')
    else lines.push('Diff vs current Grafana dashboard:', ...diffLines.map((line) => `  ${line}`))
  }
  const requestedFolder = requestedFolderApprovalLine(args, snapshot, live)
  if (requestedFolder) lines.push(requestedFolder)
  if (live?.ok) {
    const currentVersion = live.current?.dashboard?.version
    if (currentVersion === snapshot.version) {
      lines.push(`Live check: Grafana-side version matches (${snapshot.version}).`)
    } else {
      lines.push(`⚠️ VERSION CONFLICT: Grafana-side version ${String(currentVersion ?? 'unknown')} ≠ snapshot version ${snapshot.version}. The dashboard changed after grafana_get; fetch again and reapply the change.`)
    }
    const currentFolderUid = folderUidOf(live.current?.meta)
    if (currentFolderUid !== snapshot.folderUid) {
      lines.push(`⚠️ FOLDER CHANGED on the Grafana side: snapshot folder ${folderLabel(snapshot.folderTitle, snapshot.folderUid)} vs current folder ${folderLabel(live.current?.meta?.folderTitle, currentFolderUid)}.`)
    }
  } else if (live) {
    lines.push('Live check: ⚠️ unable to confirm the current Grafana-side state.')
  }
  return lines.join('\n')
}

export function cloneApprovalReason(args) {
  let sourceUid = 'unknown'
  try {
    sourceUid = parseUid(args?.sourceUrlOrUid)
  } catch {
    // 非法输入会在审批后的工具执行阶段被拒绝。
  }
  const title = String(args?.newTitle ?? '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 100)
  const target = title ? ` titled ${JSON.stringify(title)}` : ''
  let folder = ' in the source folder'
  if (typeof args?.folderUid === 'string') {
    const folderUid = args.folderUid.trim()
    if (!folderUid) folder = ' into General'
    else if (UID_PATTERN.test(folderUid)) folder = ` into folder ${JSON.stringify(folderUid)}`
    else folder = ' with an invalid destination folder UID (the write will be rejected)'
  }
  return `Create a new Grafana dashboard by cloning source uid=${sourceUid}${target}${folder}.`
}
