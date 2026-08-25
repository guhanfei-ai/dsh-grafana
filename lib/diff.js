// lib/diff.js — 大盘内容 diff 纯函数：比对当前大盘与待写 JSON，产出有界、清洗过的审批预览行。
import { DIFF_SKIP_FIELDS, MAX_DIFF_CHANGED_KEYS, MAX_DIFF_LINES, MAX_DIFF_VALUE_CHARS } from './constants.js'
import { flattenPanels, oneLine } from './util.js'

function panelLabel(panel) {
  const title = typeof panel.title === 'string' && panel.title.trim() ? ` ${JSON.stringify(oneLine(panel.title, 60))}` : ''
  const type = typeof panel.type === 'string' && panel.type ? ` type=${oneLine(panel.type, 40)}` : ''
  return `id=${panel.id}${title}${type}`
}

function changedKeyNames(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed = []
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(oneLine(key, 40))
  }
  if (changed.length > MAX_DIFF_CHANGED_KEYS) {
    return `${changed.slice(0, MAX_DIFF_CHANGED_KEYS).join(', ')} +${changed.length - MAX_DIFF_CHANGED_KEYS} more`
  }
  return changed.join(', ')
}

function variableMapOf(dashboard) {
  const list = Array.isArray(dashboard?.templating?.list) ? dashboard.templating.list : []
  return new Map(list
    .filter((variable) => variable && typeof variable === 'object' && typeof variable.name === 'string' && variable.name)
    .map((variable) => [variable.name, variable]))
}

// 纯函数：以实时复核的当前大盘为基线，与待写 JSON 比对出有界、清洗过的内容
// diff 行（面板增/删/改、模板变量增/删/改、顶层字段变化），供审批文案展示。
// proposed 侧全部来自不可信数据，所有文本都经 oneLine 清洗，无法伪造换行。
export function diffDashboards(current, proposed) {
  if (!current || typeof current !== 'object' || !proposed || typeof proposed !== 'object') return []
  const lines = []

  const currentPanels = flattenPanels(current)
  const proposedPanels = flattenPanels(proposed)
  for (const [id, panel] of currentPanels) {
    if (!proposedPanels.has(id)) lines.push(`- panel ${panelLabel(panel)}`)
  }
  for (const [id, panel] of proposedPanels) {
    const before = currentPanels.get(id)
    if (!before) {
      lines.push(`+ panel ${panelLabel(panel)}`)
      continue
    }
    const changed = changedKeyNames(before, panel)
    if (changed) lines.push(`~ panel ${panelLabel(panel)}: changed ${changed}`)
  }

  const currentVars = variableMapOf(current)
  const proposedVars = variableMapOf(proposed)
  for (const [name] of currentVars) {
    if (!proposedVars.has(name)) lines.push(`- variable ${JSON.stringify(oneLine(name, 60))}`)
  }
  for (const [name, variable] of proposedVars) {
    const before = currentVars.get(name)
    if (!before) {
      lines.push(`+ variable ${JSON.stringify(oneLine(name, 60))}`)
      continue
    }
    const changed = changedKeyNames(before, variable)
    if (changed) lines.push(`~ variable ${JSON.stringify(oneLine(name, 60))}: changed ${changed}`)
  }

  const fieldKeys = new Set([...Object.keys(current), ...Object.keys(proposed)])
  for (const key of fieldKeys) {
    if (DIFF_SKIP_FIELDS.has(key)) continue
    const before = JSON.stringify(current[key])
    const after = JSON.stringify(proposed[key])
    if (before === after) continue
    lines.push(`~ field ${oneLine(key, 40)}: ${oneLine(before ?? '(absent)', MAX_DIFF_VALUE_CHARS)} -> ${oneLine(after ?? '(absent)', MAX_DIFF_VALUE_CHARS)}`)
  }

  if (lines.length > MAX_DIFF_LINES) {
    const hidden = lines.length - MAX_DIFF_LINES
    return [...lines.slice(0, MAX_DIFF_LINES), `…${hidden} more change(s) not shown.`]
  }
  return lines
}
