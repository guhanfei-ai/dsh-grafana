// lib/budget.js — 截断显式披露：把「丢了多少、丢在哪个维度」收敛成一行可读文案。
// 既有摘要在超出上限时只说 "more series not shown"，既不报截断前总量也不报已显示量，
// 模型无法判断自己看到的是全貌还是碎片。这里提供一个极小的计数器：调用方每次丢弃
// 时 spend()，收尾用 budgetLine() 取一行披露文案（没有任何丢弃时返回 null，不产生空行）。
// 文案强制单行且维度名先经清洗，避免拼接出可伪造输出行的内容。
import { oneLine } from './util.js'

// 维度名与整行的长度上限：维度名是调用方自己的字面量，上限只作防御性收敛，
// 量级与其它单行披露（错误诊断 240 字符）保持一致。
const LABEL_MAX_CHARS = 40
const NOTE_MAX_CHARS = 240

export function createBudget() {
  // label -> { hidden, shown }；shown 为 null 表示调用方没有提供已显示数量。
  const rows = new Map()

  // count: 本次被丢弃的数量；label: 维度名（如 "alerts" / "series" / "line(s)"）；
  // shown: 可选，本次实际显示的数量——只有提供它才能渲染 "30 of 128 shown" 形态。
  function spend(count, label, shown) {
    const hidden = Math.floor(Number(count))
    if (!Number.isFinite(hidden) || hidden <= 0) return
    const key = oneLine(label, LABEL_MAX_CHARS) || 'item'
    const row = rows.get(key) ?? { hidden: 0, shown: null }
    row.hidden += hidden
    const kept = Math.floor(Number(shown))
    if (Number.isFinite(kept) && kept >= 0) row.shown = (row.shown ?? 0) + kept
    rows.set(key, row)
  }

  function note() {
    const parts = []
    for (const [label, row] of rows) {
      if (row.hidden <= 0) continue
      parts.push(row.shown === null
        ? `${row.hidden} ${label} hidden`
        : `${row.shown} of ${row.shown + row.hidden} ${label} shown; ${row.hidden} hidden`)
    }
    if (parts.length === 0) return null
    return oneLine(`budget: ${parts.join(' — ')} (raise limit to include them)`, NOTE_MAX_CHARS)
  }

  return { spend, note }
}

// 便捷取值：预算对象缺失或形状不对时返回 null，调用方不必自行判空。
export function budgetLine(budget) {
  if (!budget || typeof budget.note !== 'function') return null
  return budget.note()
}
