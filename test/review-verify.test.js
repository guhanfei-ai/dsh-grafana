import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'
import { evaluatePanelExpectations, validateExpect } from '../lib/tools/verify.js'

const UID = 'fixture-dash-0001'

function execution() {
  return { signal: new AbortController().signal }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function dashboard() {
  return {
    id: 7,
    uid: UID,
    version: 3,
    title: 'Overview',
    timezone: 'browser',
    panels: [
      {
        id: 1,
        type: 'timeseries',
        title: 'CPU',
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
        datasource: { type: 'prometheus', uid: 'prom-1' },
        targets: [{ refId: 'A', expr: 'up', datasource: { type: 'prometheus', uid: 'prom-1' } }],
      },
    ],
    templating: { list: [] },
  }
}

function createHarness({ response = null } = {}) {
  const tools = []
  const listeners = new Map()
  const calls = []
  const ctx = {
    credentials: {
      async resolve(ref) {
        if (ref === 'GRAFANA_BASE_URL') return { value: 'https://grafana.example.com' }
        if (ref === 'GRAFANA_TOKEN') return { value: 'test-token' }
        return undefined
      },
    },
    inject() {},
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    systemPrompt: { section() {} },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  }
  apply(ctx, {})
  const current = dashboard()
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname
    const method = String(init.method ?? 'GET').toUpperCase()
    calls.push({ path, method })
    if (path === `/api/dashboards/uid/${UID}`) return jsonResponse({ dashboard: structuredClone(current), meta: { canSave: true } })
    if (path === '/api/ds/query') return jsonResponse(response ?? {
      results: {
        A: {
          status: 200,
          frames: [{
            schema: { name: 'up', fields: [{ name: 'time', type: 'time' }, { name: 'Value', type: 'number' }] },
            data: { values: [[1700000000000, 1700000060000], [20, 21]] },
          }],
        },
      },
    })
    if (path === '/api/datasources') return jsonResponse([])
    return jsonResponse({ message: 'unexpected route' }, 404)
  }
  return { tools, listeners, calls, fetchImpl }
}

function toolByName(harness, name) {
  const tool = harness.tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

test('grafana_diff_dashboard shows paths and readable changes without writing or recording a snapshot', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = harness.fetchImpl
  try {
    const proposed = { ...dashboard(), title: 'Proposed', panels: [...dashboard().panels, { id: 2, type: 'text', title: 'Notes' }] }
    const output = await toolByName(harness, 'grafana_diff_dashboard').execute({ dashboardJson: JSON.stringify(proposed) }, execution())
    assert.match(output, /1 changed path|2 changed path|changed path\(s\)/)
    assert.match(output, /\/title/)
    assert.match(output, /\+ panel id=2/)
    assert.equal(harness.calls.some((call) => call.method === 'POST'), false)
    // diff 是只读预览：它没有为后续写入建立可信快照。
    const decision = await harness.listeners.get('tools/pre-execute')({
      name: 'grafana_patch', arguments: { urlOrUid: UID, ops: [{ op: 'replace', path: '/title', value: 'x' }] },
    }, async () => ({ kind: 'allow' }))
    assert.match(decision.reason, /no recent trusted snapshot/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_diff_dashboard rejects ambiguous input and malformed dashboard JSON', async () => {
  const harness = createHarness()
  const tool = toolByName(harness, 'grafana_diff_dashboard')
  await assert.rejects(tool.execute({}, execution()), /exactly one/)
  await assert.rejects(tool.execute({ dashboardJson: '{bad' }, execution()), /not valid JSON/)
  await assert.rejects(tool.execute({ dashboardJson: JSON.stringify({ uid: UID }) }, execution()), /panels array/)
  await assert.rejects(tool.execute({ dashboardJson: JSON.stringify({ panels: [] }) }, execution()), /valid 1-40 character uid/)
})

test('grafana_audit_time reports effective zones, SQL time usage and heuristic findings', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === `/api/dashboards/uid/${UID}`) {
      return jsonResponse({
        dashboard: {
          uid: UID,
          timezone: 'browser',
          panels: [
            { id: 1, type: 'timeseries', title: 'UTC naive', timezone: 'utc', fieldConfig: { defaults: { unit: 'time:YYYY-MM-DD' } }, targets: [{ rawSql: 'SELECT created_at AS time FROM t WHERE $__timeFilter(created_at)' }] },
            { id: 2, type: 'timeseries', title: 'Converted', timezone: 'utc', fieldConfig: { defaults: { unit: 'time:YYYY-MM-DD' } }, targets: [{ rawSql: 'SELECT UNIX_TIMESTAMP(created_at) AS time FROM t WHERE $__timeFilter(created_at)' }] },
            { id: 3, type: 'row', title: 'Group', panels: [{ id: 4, type: 'stat', title: 'Nested', targets: [{ expr: 'up' }] }] },
          ],
        },
        meta: {},
      })
    }
    return jsonResponse({ message: 'unexpected route' }, 404)
  }
  try {
    const output = await toolByName(harness, 'grafana_audit_time').execute({ urlOrUid: UID }, execution())
    assert.match(output, /dashboard timezone=browser/)
    assert.match(output, /panel id=1 .*timezone=utc \(panel\)/)
    assert.match(output, /naive-datetime/)
    assert.match(output, /epoch-conversion/)
    assert.match(output, /! panel id=1: UTC panel renders a naive DATETIME/)
    assert.match(output, /heuristic: check each against the database time zone/)
    assert.doesNotMatch(output, /panel id=3 /)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_verify_panel returns pass with real values for rows, cell and sum assertions', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = harness.fetchImpl
  try {
    const output = await toolByName(harness, 'grafana_verify_panel').execute({
      urlOrUid: UID,
      panelId: 1,
      expect: {
        rows: 2,
        cell: { refId: 'A', frame: 0, row: 0, field: 'Value', equals: 20 },
        sum: { field: 'Value', equals: 41 },
      },
    }, execution())
    assert.match(output, /PASS rows: expected 2, actual 2/)
    assert.match(output, /PASS cell A\[frame 0\]\[row 0\]\.Value: expected 20, actual 20/)
    assert.match(output, /PASS sum of "Value": expected 41, actual 41/)
    assert.match(output, /Verdict: pass/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_verify_panel fails on the first mismatch instead of claiming success', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = harness.fetchImpl
  try {
    const output = await toolByName(harness, 'grafana_verify_panel').execute({
      urlOrUid: UID, panelId: 1, expect: { cell: { row: 0, field: 'Value', equals: 19 } },
    }, execution())
    assert.match(output, /FAIL cell A\[frame 0\]\[row 0\]\.Value: expected 19, actual 20/)
    assert.match(output, /First mismatch:/)
    assert.match(output, /Verdict: fail/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_verify_panel distinguishes no-data from a failed query', async () => {
  const empty = createHarness({ response: { results: { A: { status: 200, frames: [{ schema: { fields: [{ name: 'Value', type: 'number' }] }, data: { values: [[]] } }] } } } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = empty.fetchImpl
  try {
    const output = await toolByName(empty, 'grafana_verify_panel').execute({ urlOrUid: UID, panelId: 1, expect: { rows: 1 } }, execution())
    assert.match(output, /Verdict: no-data/)
  } finally {
    globalThis.fetch = originalFetch
  }

  const failed = createHarness({ response: { results: { A: { status: 500, error: 'upstream failed' } } } })
  globalThis.fetch = failed.fetchImpl
  try {
    const output = await toolByName(failed, 'grafana_verify_panel').execute({ urlOrUid: UID, panelId: 1, expect: { rows: 0 } }, execution())
    assert.match(output, /Verdict: error/)
    assert.match(output, /upstream failed/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('panel expectation validation rejects incomplete or non-finite assertions', () => {
  assert.throws(() => validateExpect({}), /at least one/)
  assert.throws(() => validateExpect(null), /expect must be an object/)
  assert.throws(() => validateExpect({ rows: -1 }), /non-negative integer/)
  assert.throws(() => validateExpect({ cell: { row: 0, field: 'Value' } }), /equals/)
  assert.throws(() => validateExpect({ cell: { row: 0, field: 'Value', equals: {} } }), /number or a string/)
  assert.throws(() => validateExpect({ cell: { row: 0, field: 'Value', equals: Number.NaN } }), /finite number or a string/)
  assert.throws(() => validateExpect({ sum: { equals: Number.NaN } }), /finite number/)
  assert.throws(() => validateExpect({ sum: { equals: 1, tolerance: -1 } }), /between 0/)
  assert.deepEqual(validateExpect({ rows: 0 }), { rows: 0 })
})

test('evaluatePanelExpectations never turns a query error into a passing assertion', () => {
  const records = [{ originalRefId: 'A', refId: 'A', failed: 'timeout' }]
  const outcome = evaluatePanelExpectations({ rows: 0 }, records, {})
  assert.equal(outcome.verdict, 'error')
  assert.equal(outcome.checks[0].pass, true)
  assert.match(outcome.errors[0], /timeout/)
})
