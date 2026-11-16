import assert from 'node:assert/strict'
import test from 'node:test'

import { planPanelUpsert, planVariableUpsert, collectPanels } from '../lib/dashboard-edit.js'
import { applyPatch, changedPaths, MAX_PATCH_OPS, parsePointer } from '../lib/jsonpatch.js'

function fixture() {
  return {
    uid: 'fixture-dash-0001',
    id: 7,
    version: 3,
    title: 'Overview',
    panels: [
      { id: 1, type: 'timeseries', title: 'CPU', gridPos: { x: 0, y: 0, w: 12, h: 8 }, targets: [{ refId: 'A', expr: 'up' }] },
      { id: 2, type: 'row', title: 'Details', gridPos: { x: 0, y: 8, w: 24, h: 1 }, panels: [
        { id: 3, type: 'stat', title: 'Nested', gridPos: { x: 0, y: 9, w: 6, h: 4 } },
      ] },
    ],
    templating: { list: [{ name: 'env', type: 'custom', query: 'prod,stage' }] },
  }
}

test('parsePointer applies the RFC 6901 escapes in the right order and rejects reserved keys', () => {
  assert.deepEqual(parsePointer(''), [])
  assert.deepEqual(parsePointer('/a~1b/c~0d'), ['a/b', 'c~d'])
  assert.throws(() => parsePointer('panels'), /must be a JSON pointer starting with "\/"/)
  assert.throws(() => parsePointer('/__proto__/x'), /reserved key/)
  assert.throws(() => parsePointer('/a/constructor'), /reserved key/)
  assert.throws(() => parsePointer('/a/prototype'), /reserved key/)
})

test('applyPatch applies add, replace, remove, copy, move and test without touching the input', () => {
  const before = fixture()
  const snapshot = JSON.stringify(before)
  const after = applyPatch(before, [
    { op: 'replace', path: '/title', value: 'Overview v2' },
    { op: 'add', path: '/panels/-', value: { id: 9, type: 'text' } },
    { op: 'copy', from: '/panels/0', path: '/panels/-' },
    { op: 'move', from: '/panels/3', path: '/panels/0' },
    { op: 'remove', path: '/panels/1' },
    { op: 'test', path: '/title', value: 'Overview v2' },
  ])
  assert.equal(after.title, 'Overview v2')
  assert.deepEqual(after.panels.map((panel) => panel.id), [1, 2, 9])
  assert.equal(JSON.stringify(before), snapshot, 'the input document must not be modified')
})

test('applyPatch rejects the whole patch on the first invalid operation and names its index', () => {
  const doc = fixture()
  assert.throws(() => applyPatch(doc, [
    { op: 'replace', path: '/title', value: 'ok' },
    { op: 'replace', path: '/panels/9/title', value: 'missing' },
  ]), /ops\[1\] \(replace "\/panels\/9\/title"\): path "\/panels\/9\/title" does not exist/)
  assert.throws(() => applyPatch(doc, [{ op: 'test', path: '/title', value: 'nope' }]), /test failed/)
  assert.throws(() => applyPatch(doc, [{ op: 'add', path: '/panels/5/title', value: 'x' }]), /does not exist|crosses|missing/)
  assert.throws(() => applyPatch(doc, [{ op: 'add', path: '/panels/9', value: {} }]), /out of range/)
  assert.throws(() => applyPatch(doc, [{ op: 'add', path: '/__proto__/polluted', value: 1 }]), /reserved key/)
  assert.throws(() => applyPatch(doc, [{ op: 'add', path: '/title', value: 'x', extra: true }]), /unknown field "extra"/)
  assert.throws(() => applyPatch(doc, [{ op: 'add', path: '/title' }]), /requires a value/)
  assert.throws(() => applyPatch(doc, [{ op: 'copy', path: '/title' }]), /requires a from pointer/)
  assert.throws(() => applyPatch(doc, [{ op: 'move', from: '/panels/1', path: '/panels/1/panels/-' }]), /inside itself/)
  assert.throws(() => applyPatch(doc, [{ op: 'replace', path: '' , value: {} }]), /whole document/)
  assert.throws(() => applyPatch(doc, []), /non-empty array/)
  assert.throws(() => applyPatch(doc, Array.from({ length: MAX_PATCH_OPS + 1 }, () => ({ op: 'test', path: '/title', value: 'Overview' }))), /must not exceed/)
  // 数组索引必须是规范十进制：前导零与负数都不认。
  assert.throws(() => applyPatch(doc, [{ op: 'replace', path: '/panels/01/title', value: 'x' }]), /does not exist/)
  assert.throws(() => applyPatch(doc, [{ op: 'replace', path: '/panels/-1/title', value: 'x' }]), /does not exist/)
})

test('changedPaths reports the JSON pointers that differ, bounded, and nothing when equal', () => {
  const before = fixture()
  const after = applyPatch(before, [
    { op: 'replace', path: '/panels/0/title', value: 'CPU 2' },
    { op: 'replace', path: '/templating/list/0/query', value: 'prod' },
  ])
  assert.deepEqual(changedPaths(before, after), { paths: ['/panels/0/title', '/templating/list/0/query'], total: 2 })
  assert.deepEqual(changedPaths(before, structuredClone(before)), { paths: [], total: 0 })
  const many = applyPatch(before, Array.from({ length: 5 }, (_, i) => ({ op: 'add', path: `/extra${i}`, value: i })))
  const bounded = changedPaths(before, many, 2)
  assert.equal(bounded.paths.length, 2)
  assert.equal(bounded.total, 5)
})

test('planPanelUpsert changes only the given fields and keeps gridPos unless it is given', () => {
  const doc = fixture()
  const plan = planPanelUpsert(doc, { panelId: 1, panel: { title: 'CPU (5m)' } })
  assert.equal(plan.action, 'update')
  assert.deepEqual(plan.ops, [{ op: 'add', path: '/panels/0/title', value: 'CPU (5m)' }])
  const after = applyPatch(doc, plan.ops)
  assert.deepEqual(after.panels[0].gridPos, { x: 0, y: 0, w: 12, h: 8 })
  assert.deepEqual(after.panels[0].targets, [{ refId: 'A', expr: 'up' }])

  // gridPos 只覆盖给出的键；未给出的键沿用原值。
  const moved = applyPatch(doc, planPanelUpsert(doc, { panelId: 1, gridPos: { w: 6 } }).ops)
  assert.deepEqual(moved.panels[0].gridPos, { x: 0, y: 0, w: 6, h: 8 })
  // 其它面板的 gridPos 不会被隐式改动。
  assert.deepEqual(moved.panels[1].gridPos, doc.panels[1].gridPos)
})

test('planPanelUpsert inserts after an anchor, inside rows too, and defaults the grid to the bottom', () => {
  const doc = fixture()
  const top = planPanelUpsert(doc, { afterPanelId: 1, panel: { type: 'gauge', title: 'G' }, gridPos: { x: 12, y: 0, w: 12, h: 4 } })
  assert.equal(top.action, 'insert')
  assert.deepEqual(top.panelIds, [4])
  const inserted = applyPatch(doc, top.ops)
  assert.deepEqual(inserted.panels.map((panel) => panel.id), [1, 4, 2])

  const nested = planPanelUpsert(doc, { afterPanelId: 3, panel: { type: 'text' } })
  const insertedNested = applyPatch(doc, nested.ops)
  assert.deepEqual(insertedNested.panels[1].panels.map((panel) => panel.id), [3, 4])

  // 没给 afterPanelId 与 gridPos：追加到顶层末尾，放在画布底部（顶层最大底边 9，即 y=9）。
  const appended = planPanelUpsert(doc, { panel: { type: 'text', title: 'Notes' } })
  assert.deepEqual(appended.ops[0].path, '/panels/-')
  assert.deepEqual(appended.ops[0].value.gridPos, { x: 0, y: 9, w: 12, h: 8 })
  assert.equal(appended.panelIds[0], 4)
})

test('planPanelUpsert deletes a row together with the panels inside it', () => {
  const doc = fixture()
  const plan = planPanelUpsert(doc, { panelId: 2, delete: true })
  assert.equal(plan.action, 'delete')
  assert.deepEqual(plan.panelIds, [2, 3])
  const after = applyPatch(doc, plan.ops)
  assert.deepEqual(after.panels.map((panel) => panel.id), [1])
})

test('planPanelUpsert refuses every ambiguous or out-of-range request explicitly', () => {
  const doc = fixture()
  assert.throws(() => planPanelUpsert(doc, { panel: { type: 'x' }, gridPos: { x: 20, y: 0, w: 12, h: 4 } }), /exceeds the 24-column grid/)
  assert.throws(() => planPanelUpsert(doc, { panel: { type: 'x', gridPos: { x: 0, y: 0, w: 30, h: 4 } } }), /gridPos.w must be between 1 and 24/)
  assert.throws(() => planPanelUpsert(doc, { panel: { type: 'x' }, gridPos: { x: 0, y: 0, w: 4, h: 4, z: 1 } }), /unknown field "z"/)
  assert.throws(() => planPanelUpsert(doc, { panel: { type: 'x', gridPos: { x: 0 } }, gridPos: { x: 0 } }), /gridPos once/)
  assert.throws(() => planPanelUpsert(doc, { panelId: 99, panel: { title: 'x' } }), /panel id=99 was not found, so this call adds a new panel/)
  assert.throws(() => planPanelUpsert(doc, { panel: { title: 'no type' } }), /needs a type/)
  assert.throws(() => planPanelUpsert(doc, { panelId: 1, afterPanelId: 3, panel: { title: 'x' } }), /only valid when adding/)
  assert.throws(() => planPanelUpsert(doc, { panelId: 1, panel: { id: 5 } }), /cannot change/)
  assert.throws(() => planPanelUpsert(doc, { panel: { id: 1, type: 'x' } }), /already exists/)
  assert.throws(() => planPanelUpsert(doc, { afterPanelId: 42, panel: { type: 'x' } }), /afterPanelId=42 was not found/)
  assert.throws(() => planPanelUpsert(doc, { panelId: 2, panel: {} }), /no fields to change/)
  // 工具参数来自 JSON，__proto__ 是自有属性（字面量写法会改设原型，不能代表真实输入）。
  assert.throws(() => planPanelUpsert(doc, { panelId: 1, panel: JSON.parse('{"__proto__":{"x":1},"title":"x"}') }), /reserved key/)
  assert.throws(() => planPanelUpsert({ uid: 'x' }, { panelId: 1, panel: { title: 'x' } }), /no panels array/)
})

test('duplicate panel ids are refused instead of guessing which panel to edit', () => {
  const doc = fixture()
  doc.panels.push({ id: 1, type: 'text', gridPos: { x: 0, y: 20, w: 6, h: 2 } })
  assert.deepEqual([...collectPanels(doc).duplicates], [1])
  assert.throws(() => planPanelUpsert(doc, { panelId: 1, panel: { title: 'x' } }), /appears more than once/)
  assert.throws(() => planPanelUpsert(doc, { panelId: 1, delete: true }), /appears more than once/)
})

test('planVariableUpsert edits one variable by name and leaves the others alone', () => {
  const doc = fixture()
  doc.templating.list.push({ name: 'region', type: 'custom', query: 'a,b' })
  const update = planVariableUpsert(doc, { name: 'env', variable: { label: 'Environment' } })
  assert.equal(update.action, 'update')
  const after = applyPatch(doc, update.ops)
  assert.equal(after.templating.list[0].label, 'Environment')
  assert.deepEqual(after.templating.list[1], doc.templating.list[1])

  const insert = planVariableUpsert(doc, { name: 'cluster', variable: { type: 'custom', query: 'x' } })
  assert.equal(insert.action, 'insert')
  assert.equal(applyPatch(doc, insert.ops).templating.list.at(-1).name, 'cluster')

  const remove = planVariableUpsert(doc, { name: 'region', delete: true })
  assert.deepEqual(applyPatch(doc, remove.ops).templating.list.map((variable) => variable.name), ['env'])
})

test('planVariableUpsert creates missing containers and refuses bad names or renames', () => {
  const bare = { uid: 'x', panels: [] }
  const created = planVariableUpsert(bare, { name: 'env', variable: { type: 'custom' } })
  assert.deepEqual(applyPatch(bare, created.ops).templating, { list: [{ type: 'custom', name: 'env' }] })
  const listOnly = planVariableUpsert({ uid: 'x', panels: [], templating: {} }, { name: 'env', variable: { type: 'custom' } })
  assert.deepEqual(listOnly.ops[0], { op: 'add', path: '/templating/list', value: [] })

  const doc = fixture()
  assert.throws(() => planVariableUpsert(doc, { name: '  ', variable: { type: 'custom' } }), /name is required/)
  assert.throws(() => planVariableUpsert(doc, { name: 'a\nb', variable: { type: 'custom' } }), /single line/)
  assert.throws(() => planVariableUpsert(doc, { name: 'env', variable: { name: 'other' } }), /cannot change/)
  assert.throws(() => planVariableUpsert(doc, { name: 'nope', variable: { label: 'x' } }), /Variable "nope" was not found, so this call adds a new variable/)
  assert.throws(() => planVariableUpsert(doc, { name: 'nope', delete: true }), /was not found/)
  assert.throws(() => planVariableUpsert(doc, { name: 'fresh', variable: { label: 'no type' } }), /needs a type/)
  assert.throws(() => planVariableUpsert({ uid: 'x', templating: 'broken' }, { name: 'env', variable: { type: 'custom' } }), /not an object/)
  assert.throws(() => planVariableUpsert({ uid: 'x', templating: { list: {} } }, { name: 'env', variable: { type: 'custom' } }), /list is not an array/)
  assert.throws(() => planVariableUpsert({ uid: 'x', templating: { list: [{ name: 'env' }, { name: 'env' }] } }, { name: 'env', variable: { label: 'x' } }), /appears more than once/)
})
