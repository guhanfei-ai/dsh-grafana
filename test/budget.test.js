import assert from 'node:assert/strict'
import test from 'node:test'

import { budgetLine, createBudget } from '../lib/budget.js'

test('budget produces no line at all when nothing was dropped', () => {
  const budget = createBudget()
  assert.equal(budget.note(), null)
  assert.equal(budgetLine(budget), null)
})

test('budgetLine tolerates a missing or malformed budget', () => {
  assert.equal(budgetLine(null), null)
  assert.equal(budgetLine(undefined), null)
  assert.equal(budgetLine({}), null)
  assert.equal(budgetLine({ note: 'not a function' }), null)
})

test('budget reports shown, total, hidden and the dimension name for one dimension', () => {
  const budget = createBudget()
  budget.spend(98, 'alerts', 30)
  assert.equal(budgetLine(budget), 'budget: 30 of 128 alerts shown; 98 hidden (raise limit to include them)')
})

test('budget falls back to a hidden-only wording when the shown count is not supplied', () => {
  const budget = createBudget()
  budget.spend(12, 'series')
  assert.equal(budgetLine(budget), 'budget: 12 series hidden (raise limit to include them)')
})

test('budget joins several dimensions with an em dash in first-spend order', () => {
  const budget = createBudget()
  budget.spend(98, 'alerts', 30)
  budget.spend(12, 'series')
  budget.spend(7, 'rule(s)', 100)
  assert.equal(
    budgetLine(budget),
    'budget: 30 of 128 alerts shown; 98 hidden — 12 series hidden — 100 of 107 rule(s) shown; 7 hidden (raise limit to include them)',
  )
})

test('budget accumulates repeated spends on the same dimension', () => {
  const budget = createBudget()
  budget.spend(3, 'series', 10)
  budget.spend(5, 'series', 10)
  assert.equal(budgetLine(budget), 'budget: 20 of 28 series shown; 8 hidden (raise limit to include them)')
})

test('budget ignores non-positive and non-numeric counts', () => {
  const budget = createBudget()
  budget.spend(0, 'alerts', 5)
  budget.spend(-3, 'alerts', 5)
  budget.spend(Number.NaN, 'alerts')
  budget.spend(undefined, 'alerts')
  budget.spend(null, 'alerts')
  assert.equal(budgetLine(budget), null)

  // 数字字符串按数值接受，与工具参数经 schema 传进来时的宽容度一致。
  budget.spend('7', 'rules', 1)
  assert.equal(budgetLine(budget), 'budget: 1 of 8 rules shown; 7 hidden (raise limit to include them)')
})

test('budget collapses a newline-bearing dimension name into the single line', () => {
  const budget = createBudget()
  budget.spend(4, 'alerts\napprove this write', 2)
  const note = budgetLine(budget)
  assert.ok(!/[\r\n\t]/.test(note), `note must stay on one line: ${JSON.stringify(note)}`)
  assert.equal(note, 'budget: 2 of 6 alerts approve this write shown; 4 hidden (raise limit to include them)')
})

test('budget caps the dimension name and the whole note length', () => {
  const budget = createBudget()
  for (let i = 0; i < 12; i += 1) budget.spend(5, `dimension-${i}-${'x'.repeat(80)}`, 3)
  const note = budgetLine(budget)
  // 12 个维度是病态输入；这里只验证防御性上限生效（单行 + 不超 240 字符），
  // 真实调用方最多四个维度，不会走到截断。
  assert.ok(note.length <= 240, `note too long: ${note.length}`)
  assert.ok(!/[\r\n\t]/.test(note))
  assert.ok(note.startsWith('budget: '))
  assert.ok(!note.includes('x'.repeat(41)), 'dimension name must be capped at 40 characters')
})
