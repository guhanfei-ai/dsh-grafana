// lib/query.js — 查询与摘要纯函数：URL/时间解析、模板变量插值、查询结果统计摘要、大盘结构摘要。
import {
  MAX_FRAMES_PER_QUERY,
  MAX_QUERY_SUMMARY_LINES,
  MAX_SUMMARY_LINES,
  RELATIVE_TIME_PATTERN,
  SUMMARY_QUERY_KEYS,
  TIMESTAMP_PATTERN,
  VARIABLE_PATTERN,
} from './constants.js'
import { flattenPanels, folderLabel, folderUidOf, oneLine, parseUid } from './util.js'

export function isValidTimeInput(value) {
  const text = String(value ?? '').trim()
  return RELATIVE_TIME_PATTERN.test(text) || TIMESTAMP_PATTERN.test(text)
}

// 在 parseUid 之外解析浏览器 URL 的查询参数：viewPanel（面板视图）与
// from/to 时间范围。解析不出的参数直接忽略，不报错。
export function parseDashboardUrl(input) {
  const value = String(input ?? '').trim()
  const result = { uid: parseUid(value), viewPanel: null, from: '', to: '' }
  let url
  try {
    url = new URL(value)
  } catch {
    // 裸 UID 或非法 URL：uid 已由 parseUid 校验，其余参数无从解析。
    return result
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return result
  const viewPanel = url.searchParams.get('viewPanel')
  if (viewPanel !== null) {
    // 新版 Grafana scenes 的面板视图地址用 panel-<id>，两种形态都兼容。
    const match = String(viewPanel).match(/^(?:panel-)?(\d+)$/)
    if (match) result.viewPanel = Number(match[1])
  }
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (from && isValidTimeInput(from)) result.from = from.trim()
  if (to && isValidTimeInput(to)) result.to = to.trim()
  return result
}

export function variableValuesOf(dashboard, overrides) {
  const values = new Map()
  const list = Array.isArray(dashboard?.templating?.list) ? dashboard.templating.list : []
  for (const variable of list) {
    if (!variable || typeof variable !== 'object' || typeof variable.name !== 'string' || !variable.name) continue
    if (variable.current?.value !== undefined && variable.current.value !== null) values.set(variable.name, variable.current.value)
  }
  // 参数覆盖优先于大盘里保存的 current 值。
  if (overrides && typeof overrides === 'object') {
    for (const [name, value] of Object.entries(overrides)) values.set(name, value)
  }
  return values
}

// 模板变量替换：只处理 ${var} / $var 两种形式；$__interval 等全局内建变量
// 原样透传，由 Grafana/数据源根据请求时间范围自行计算；${var:modifier}
// 高级格式明确报错，避免静默替换错。替换后残留非内建变量同样报错。
export function interpolateVariables(input, values) {
  const text = String(input ?? '')
  const modifier = text.match(/\$\{([A-Za-z_][A-Za-z0-9_]*):[^}]*\}/)
  if (modifier && !modifier[1].startsWith('__')) {
    throw new Error(`Unsupported Grafana variable format ${JSON.stringify(modifier[0])}. Pass a plain value via the variables argument instead.`)
  }
  const substituted = text.replace(VARIABLE_PATTERN, (match, braced, bare) => {
    const name = braced ?? bare
    if (name.startsWith('__')) return match
    const value = values.get(name)
    if (value === undefined) return match
    return Array.isArray(value) ? value.map(String).join(',') : String(value)
  })
  const leftover = substituted.match(/\$\{?(?!__)([A-Za-z_][A-Za-z0-9_]*)/)
  if (leftover) {
    throw new Error(`Unresolved Grafana template variable ${JSON.stringify(leftover[1])}. Pass it via the variables argument.`)
  }
  return substituted
}

function formatNumber(value) {
  return String(Number(value.toPrecision(4)))
}

function numericStats(values) {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let count = 0
  let last = null
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    min = Math.min(min, value)
    max = Math.max(max, value)
    sum += value
    last = value
    count += 1
  }
  if (count === 0) return null
  return { min, max, avg: sum / count, last }
}

function recentPoints(values, timeIndex, labelIndex, numberIndex, count) {
  const times = timeIndex >= 0 && Array.isArray(values[timeIndex]) ? values[timeIndex] : null
  const labels = labelIndex >= 0 && Array.isArray(values[labelIndex]) ? values[labelIndex] : null
  const numbers = values[numberIndex]
  const entries = []
  for (let index = numbers.length - 1; index >= 0 && entries.length < count; index -= 1) {
    const value = numbers[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    // 时序帧用时间做标签；表格帧（terms 聚合等）用键列做标签，
    // 桶名是排行榜类面板的核心数据，不能退化成 "?"。
    let key = '?'
    if (times && typeof times[index] === 'number') key = new Date(times[index]).toISOString().slice(11, 19)
    else if (labels && labels[index] !== undefined && labels[index] !== null) key = oneLine(String(labels[index]), 40)
    entries.push(`${key}=${formatNumber(value)}`)
  }
  return entries.join(' ')
}

function frameLabel(frame) {
  const fields = Array.isArray(frame?.schema?.fields) ? frame.schema.fields : []
  const withLabels = fields.find((field) => field?.labels && typeof field.labels === 'object')
  if (withLabels) {
    const pairs = Object.entries(withLabels.labels).map(([key, value]) => `${key}=${value}`)
    if (pairs.length > 0) return oneLine(pairs.join(', '), 80)
  }
  const name = typeof frame?.schema?.name === 'string' ? frame.schema.name.trim() : ''
  return name ? oneLine(name, 80) : '(unnamed series)'
}

function summarizeFrame(frame) {
  const fields = Array.isArray(frame?.schema?.fields) ? frame.schema.fields : []
  const values = Array.isArray(frame?.data?.values) ? frame.data.values : []
  const pointCount = Array.isArray(values[0]) ? values[0].length : 0
  const label = JSON.stringify(frameLabel(frame))
  const numberIndex = fields.findIndex((field) => field?.type === 'number')
  const timeIndex = fields.findIndex((field) => field?.type === 'time')
  // 表格帧的键列：第一个既非时间也非数值的字段列（如 terms 聚合的桶名列）。
  let labelIndex = -1
  for (let index = 0; index < fields.length; index += 1) {
    if (index === timeIndex || index === numberIndex) continue
    if (Array.isArray(values[index])) {
      labelIndex = index
      break
    }
  }
  if (numberIndex >= 0 && Array.isArray(values[numberIndex])) {
    const stats = numericStats(values[numberIndex])
    if (!stats) return `${label}: ${pointCount} points (no numeric values)`
    const recent = recentPoints(values, timeIndex, labelIndex, numberIndex, 3)
    return `${label}: ${pointCount} pts, min=${formatNumber(stats.min)} max=${formatNumber(stats.max)} avg=${formatNumber(stats.avg)} last=${formatNumber(stats.last)}${recent ? `; recent: ${recent}` : ''}`
  }
  // 非数值帧（日志、表格等）：行数 + 末值截断展示。
  const firstColumn = values.find(Array.isArray)
  const lastValue = firstColumn && firstColumn.length > 0 ? oneLine(firstColumn[firstColumn.length - 1], 60) : ''
  return `${label}: ${pointCount} rows${lastValue ? `, last=${JSON.stringify(lastValue)}` : ''}`
}

// 纯函数：按面板分组产出有界的数据摘要；单条查询报错不影响其余。
// records: [{ panel, refId, originalRefId }]；results 来自 /api/ds/query 响应。
export function summarizeFrames(records, results) {
  const lines = []
  let currentPanel = null
  for (const record of records) {
    if (record.panel !== currentPanel) {
      currentPanel = record.panel
      const title = oneLine(record.panel.title ?? '', 60)
      lines.push(title ? `panel id=${record.panel.id} ${JSON.stringify(title)}:` : `panel id=${record.panel.id}:`)
    }
    // 降级逐面板重试后仍失败的面板：逐条记录失败，不影响其余。
    if (record.failed) {
      lines.push(`  query ${record.originalRefId}: failed: ${record.failed}`)
      continue
    }
    const result = results && typeof results === 'object' ? results[record.refId] : null
    if (result?.error) {
      lines.push(`  query ${record.originalRefId}: failed: ${oneLine(result.error, 150)}`)
      continue
    }
    const frames = Array.isArray(result?.frames) ? result.frames : []
    if (frames.length === 0) {
      lines.push(`  query ${record.originalRefId}: no data`)
      continue
    }
    const shown = frames.slice(0, MAX_FRAMES_PER_QUERY)
    for (const frame of shown) lines.push(`  query ${record.originalRefId}: ${summarizeFrame(frame)}`)
    if (frames.length > shown.length) lines.push(`  query ${record.originalRefId}: …${frames.length - shown.length} more series not shown`)
  }
  if (lines.length > MAX_QUERY_SUMMARY_LINES) {
    const hidden = lines.length - MAX_QUERY_SUMMARY_LINES
    return [...lines.slice(0, MAX_QUERY_SUMMARY_LINES), `…${hidden} more line(s) not shown.`]
  }
  return lines
}

// 大盘结构摘要：只保留解读所需的骨架（面板、查询、阈值、变量），降低超大
// 盘 JSON 的上下文成本；只读输出，不记录写快照。
export function dashboardSummary(dashboard, meta) {
  const lines = []
  lines.push(`dashboard uid=${dashboard.uid} ${JSON.stringify(oneLine(dashboard.title ?? '', 100))} version=${dashboard.version} folder=${folderLabel(meta?.folderTitle, folderUidOf(meta))}`)
  const templating = Array.isArray(dashboard.templating?.list) ? dashboard.templating.list : []
  const variables = templating
    .filter((variable) => variable && typeof variable === 'object' && typeof variable.name === 'string' && variable.name)
    .map((variable) => `${variable.name}(${oneLine(variable.type ?? '?', 20)})`)
  if (variables.length > 0) lines.push(`variables: ${variables.join(', ')}`)

  for (const panel of flattenPanels(dashboard).values()) {
    const title = oneLine(panel.title ?? '', 60)
    lines.push(title
      ? `panel id=${panel.id} ${JSON.stringify(title)} type=${oneLine(panel.type ?? '?', 30)}`
      : `panel id=${panel.id} type=${oneLine(panel.type ?? '?', 30)}`)
    const datasource = panel.datasource
    if (datasource && typeof datasource === 'object') {
      lines.push(`  datasource: ${oneLine(datasource.type ?? '?', 40)} uid=${oneLine(datasource.uid ?? '?', 40)}`)
    } else if (typeof datasource === 'string') {
      lines.push(`  datasource: ${oneLine(datasource, 80)}`)
    }
    for (const target of Array.isArray(panel.targets) ? panel.targets : []) {
      if (!target || typeof target !== 'object' || target.hide === true) continue
      const text = SUMMARY_QUERY_KEYS.map((key) => target[key]).find((value) => typeof value === 'string' && value.trim())
      if (!text) continue
      const refId = typeof target.refId === 'string' && target.refId ? target.refId : 'A'
      lines.push(`  query ${refId}: ${oneLine(text, 300)}`)
    }
    const steps = panel.fieldConfig?.defaults?.thresholds?.steps
    if (Array.isArray(steps) && steps.length > 0) {
      const rendered = steps.map((step) => `${step?.value ?? 'base'}=${oneLine(step?.color ?? '?', 20)}`).join(', ')
      lines.push(`  thresholds: ${oneLine(rendered, 120)}`)
    }
    const overrideCount = Array.isArray(panel.fieldConfig?.overrides) ? panel.fieldConfig.overrides.length : 0
    if (overrideCount > 0) lines.push(`  overrides: ${overrideCount} rule(s)`)
  }

  if (lines.length > MAX_SUMMARY_LINES) {
    const hidden = lines.length - MAX_SUMMARY_LINES
    return [...lines.slice(0, MAX_SUMMARY_LINES), `…${hidden} more line(s) not shown.`].join('\n')
  }
  return lines.join('\n')
}
