// lib/time-audit.js — 大盘时间口径的只读审计（启发式，不是证明）。
// 时间错位是最难靠肉眼发现的一类问题：库里存的是裸 DATETIME（无时区语义），面板时区、
// 大盘时区与 $__timeFilter 的边界各自按不同口径解释，显示与过滤就会对不上。这里只做三件事：
// 1) 逐面板列出生效时区（面板 → 大盘 → 浏览器）；
// 2) 归纳每个 SQL target 的时间列用法（宏过滤 / UNIX 时间戳换算 / 裸 DATETIME 投影）；
// 3) 对两类已知的矛盾组合给出「需人工核对」的提示。它只指出可疑之处，不判定对错——
//    真正的答案取决于数据库存储的时区，而这份大盘 JSON 里看不到它。
import { SQL_DATASOURCE_TYPES } from './constants.js'
import { flattenPanels, oneLine } from './util.js'

const UTC_ALIASES = new Set(['utc', 'etc/utc', 'gmt', 'etc/gmt'])
const MAX_AUDIT_LINES = 60

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// 时区归一：空串视为未设；UTC 的常见写法统一成 "utc"；其余原样保留（IANA 名或 browser）。
export function normalizeZone(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  return UTC_ALIASES.has(text.toLowerCase()) ? 'utc' : text
}

// 生效时区：面板显式设置优先，其次大盘，最后浏览器。返回 { zone, source }。
export function effectiveZone(panel, dashboard) {
  const own = normalizeZone(panel?.timezone)
  if (own) return { zone: own, source: 'panel' }
  const inherited = normalizeZone(dashboard?.timezone)
  if (inherited) return { zone: inherited, source: 'dashboard' }
  return { zone: 'browser', source: 'default' }
}

// 单个 SQL target 的时间列特征。
const EPOCH_CONVERSION = /UNIX_TIMESTAMP\s*\(|EXTRACT\s*\(\s*EPOCH|toUnixTimestamp|to_unixtime|\bepoch\b/i
const TIME_FILTER_MACRO = /\$__timeFilter\s*\(|\$__timeFrom\s*\(|\$__timeTo\s*\(/i
const TIME_GROUP_MACRO = /\$__timeGroup\s*\(/i
const TIME_ALIAS = /\bAS\s+["'`]?(?:time|timestamp|ts)["'`]?\b/i

export function sqlTimeTraits(sql) {
  const text = String(sql ?? '')
  const epoch = EPOCH_CONVERSION.test(text)
  const filter = TIME_FILTER_MACRO.test(text)
  const group = TIME_GROUP_MACRO.test(text)
  const alias = TIME_ALIAS.test(text)
  // 裸 DATETIME：时间列以原始形式参与过滤、分组或投影，且没有任何 epoch 换算。
  const naive = !epoch && (filter || group || alias)
  return { epoch, filter, group, alias, naive }
}

function timeUnitOf(panel) {
  const unit = panel?.fieldConfig?.defaults?.unit
  if (typeof unit !== 'string') return null
  const trimmed = unit.trim()
  return trimmed.startsWith('time:') || trimmed.startsWith('dateTime') ? trimmed : null
}

function sqlTargets(panel) {
  const targets = Array.isArray(panel?.targets) ? panel.targets : []
  const panelType = typeof panel?.datasource?.type === 'string' ? panel.datasource.type : ''
  return targets.filter((target) => {
    if (!isPlainObject(target) || target.hide === true) return false
    const type = typeof target.datasource?.type === 'string' ? target.datasource.type : panelType
    return SQL_DATASOURCE_TYPES.has(type) || typeof target.rawSql === 'string'
  })
}

// 纯函数：返回有界的审计行。panels 来自 flattenPanels（含 row 内嵌面板）。
export function auditDashboardTime(dashboard) {
  // row 只是分组容器，没有自己的查询，不参与审计。
  const panels = [...flattenPanels(dashboard).values()].filter((panel) => panel.type !== 'row')
  const dashboardZone = normalizeZone(dashboard?.timezone) ?? 'browser'
  const lines = []
  const findings = []
  for (const panel of panels) {
    const { zone, source } = effectiveZone(panel, dashboard)
    const unit = timeUnitOf(panel)
    const traits = sqlTargets(panel).map((target) => sqlTimeTraits(target.rawSql ?? target.query ?? ''))
    const head = `panel id=${panel.id} ${JSON.stringify(oneLine(panel.title ?? '', 40))}: timezone=${zone} (${source})`
    if (traits.length === 0) {
      lines.push(unit ? `${head}; unit=${unit}; no SQL time column to audit` : `${head}; no SQL time column to audit`)
      continue
    }
    const used = []
    if (traits.some((t) => t.filter)) used.push('$__timeFilter')
    if (traits.some((t) => t.group)) used.push('$__timeGroup')
    if (traits.some((t) => t.epoch)) used.push('epoch-conversion')
    if (traits.some((t) => t.naive)) used.push('naive-datetime')
    if (!traits.some((t) => t.filter || t.epoch)) used.push('no-time-filter')
    lines.push(`${head}; unit=${unit ?? 'none'}; time columns: ${used.join(', ')}`)

    // 类 A：UTC 面板把裸 DATETIME 当作带时间单位的时间展示——数值是库里的墙上时间，
    // 在 UTC 下被原样显示，若库存的是本地时间就整体偏移。
    if (zone === 'utc' && unit && traits.some((t) => t.naive)) {
      findings.push(`! panel id=${panel.id}: UTC panel renders a naive DATETIME column with unit=${unit}; confirm the database stores UTC, or convert with UNIX_TIMESTAMP.`)
    }
    // 类 B：$__timeFilter 作用在裸 DATETIME 上，而面板时区显式不同于大盘时区——过滤边界
    // 与显示口径可能分属两个时区，需要对照数据库时区核对。
    const explicitPanelZone = normalizeZone(panel?.timezone)
    if (traits.some((t) => t.filter && t.naive) && explicitPanelZone && explicitPanelZone !== dashboardZone) {
      findings.push(`! panel id=${panel.id}: $__timeFilter compares a naive DATETIME while the panel timezone (${explicitPanelZone}) differs from the dashboard timezone (${dashboardZone}); verify the window matches the displayed range.`)
    }
    if (traits.some((t) => !t.filter && !t.epoch && !t.group) && traits.length > 0) {
      findings.push(`~ panel id=${panel.id}: SQL target has no $__timeFilter and no epoch conversion; the panel may return rows outside the dashboard range.`)
    }
  }
  const out = [`time audit: ${panels.length} panel(s), dashboard timezone=${dashboardZone}`]
  // 面板清单与发现项各自封顶；超出时用计数披露，不静默丢弃。
  const shownLines = lines.slice(0, MAX_AUDIT_LINES - 1)
  out.push(...shownLines)
  if (lines.length > shownLines.length) out.push(`…${lines.length - shownLines.length} more panel(s) not listed.`)
  const shownFindings = findings.slice(0, Math.max(0, MAX_AUDIT_LINES - out.length - 1))
  out.push(...shownFindings)
  if (findings.length > shownFindings.length) out.push(`…${findings.length - shownFindings.length} more finding(s) not shown.`)
  out.push(findings.length === 0
    ? 'findings: none (heuristic; the database time zone is not visible in dashboard JSON).'
    : `findings: ${findings.length} (heuristic: check each against the database time zone; these are prompts to verify, not proof of error).`)
  return out
}
