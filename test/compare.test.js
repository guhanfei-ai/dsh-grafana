import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'
import {
  MAX_COMPARE_SERIES_PER_SOURCE,
  MAX_COMPARE_SOURCES,
  MAX_METRIC_EXPR_CHARS,
  METRIC_DEFAULT_POINTS,
  METRIC_MIN_POINTS,
  TREND_WINDOW_DAYS,
} from '../lib/constants.js'
import {
  summarizeCompareResult,
  summarizeCompareSeries,
} from '../lib/query.js'

// ── 共享 fixture：单源站 harness + 多源站 harness + 帧构造 ────────────────────

function execution() {
  return { signal: new AbortController().signal }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createContext() {
  const tools = []
  const listeners = new Map()
  const ctx = {
    credentials: {
      async resolve(ref) {
        if (ref === 'GRAFANA_BASE_URL') return { value: 'https://grafana.example.com' }
        if (ref === 'GRAFANA_TOKEN') return { value: 'test-token' }
        return undefined
      },
    },
    inject() {},
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    systemPrompt: { section() {} },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  }
  apply(ctx, {})
  return { tools, listeners }
}

function createSettingsContext(userSection, credentialState) {
  const tools = []
  const listeners = new Map()
  const creds = { ...credentialState }
  const ctx = {
    credentials: { async resolve(ref) { return creds[ref] ? { value: creds[ref] } : undefined } },
    inject(services, callback) {
      if (!services.includes('settings')) return
      callback({
        ...ctx,
        effect(setup) { setup() },
        settings: {
          register(ns, schema, options = {}) {
            const scope = { get: () => schema({ ...options.base, ...userSection }) }
            options.validate?.(scope.get())
            return scope
          },
        },
      })
    },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    systemPrompt: { section() {} },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  }
  apply(ctx, {})
  return { tools, listeners }
}

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

// 只读工具不得为写回铺路：读完之后立刻写入仍应被审批门拒绝。
async function assertNoWriteSnapshot(listeners) {
  const decision = await listeners.get('tools/pre-execute')({
    name: 'grafana_push',
    arguments: { dashboardJson: JSON.stringify({ id: 7, uid: 'abc123', title: 'x', version: 1, panels: [] }), changeSummary: 's' },
  }, async () => ({ kind: 'allow' }))
  assert.match(decision.reason, /no recent trusted snapshot/)
}

// 每源站的 datasources GET 与 /api/ds/query POST 都用同一份 datasources 列表。
// 不同源站 datasource name 一致但 UID 不同，正是规格要求覆盖的核心场景。
function makeDatasourcesList() {
  return [
    { uid: 'prom-prod', type: 'prometheus', name: 'Prometheus', isDefault: true, access: 'proxy', url: 'https://prom-a.example.com' },
    { uid: 'loki-1', type: 'loki', name: 'Loki', access: 'proxy', url: 'https://loki.example.com' },
  ]
}

// 帧构造：每桶一个样本，时间点落在真实窗口中点（与 metric 测试的 liveFrame 同源）。
function liveFrame(values, labels, spanMs = 3_600_000) {
  const now = Date.now()
  const step = spanMs / values.length
  const times = values.map((_, i) => now - spanMs + Math.floor((i + 0.5) * step))
  return {
    schema: { fields: [{ name: 'time', type: 'time' }, { name: 'Value', type: 'number', ...(labels ? { labels } : {}) }] },
    data: { values: [times, values] },
  }
}

const RANGE_SPAN = 3_600_000

// ── 工具注册 ────────────────────────────────────────────────────────────────

test('grafana_compare is registered alongside the other read-only tools', () => {
  const { tools } = createContext()
  const names = tools.map((t) => t.name)
  assert.ok(names.includes('grafana_compare'), names.join(', '))
  // 工具元数据里的关键声明：read-only、并发安全（isConcurrencySafe 在框架里
  // 要先过 schema 校验才返回 true）、描述明确区分 grafana_metric。
  const tool = toolByName(tools, 'grafana_compare')
  assert.equal(tool.isConcurrencySafe({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up' }), true)
  assert.match(tool.description, /multiple configured Grafana sources/)
  assert.match(tool.description, /Read-only/)
})

// ── sources 校验 ────────────────────────────────────────────────────────────

test('grafana_compare rejects fewer than 2 sources without issuing any request', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return jsonResponse({}) }
  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_compare')
    await assert.rejects(tool.execute({ sources: ['prod'], datasource: 'Prometheus', query: 'up' }, execution()), /at least 2/)
    await assert.rejects(tool.execute({ sources: [], datasource: 'Prometheus', query: 'up' }, execution()), /at least 2/)
    // 完全省略 sources：参数框架的 required 校验先拦下。
    await assert.rejects(tool.execute({ datasource: 'Prometheus', query: 'up' }, execution()), /missing required property "sources"|sources must be an array/)
    // sources 不是数组：参数框架先拦（按 schema 类型），错误文案与 execute 自抛略有不同，
    // 关键是「models 看到 sources 不是数组 → 立刻报错，不会发请求」。
    await assert.rejects(tool.execute({ sources: 'a,b', datasource: 'Prometheus', query: 'up' }, execution()), /sources.*array|array/i)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_compare rejects more than the configured source cap without issuing any request', async () => {
  const originalFetch = globalThis.fetch
  const sources = Array.from({ length: MAX_COMPARE_SOURCES + 1 }, (_, i) => `s${i}`)
  let called = false
  globalThis.fetch = async () => { called = true; return jsonResponse({}) }
  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_compare')
    await assert.rejects(
      tool.execute({ sources, datasource: 'Prometheus', query: 'up' }, execution()),
      new RegExp(`must not exceed ${MAX_COMPARE_SOURCES}`),
    )
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_compare rejects duplicate source names so the same instance is never queried twice', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return jsonResponse({}) }
  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_compare')
    await assert.rejects(
      tool.execute({ sources: ['default', 'default', 'default'], datasource: 'Prometheus', query: 'up' }, execution()),
      /duplicate source/,
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_compare rejects unknown source names up front before any HTTP request', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return jsonResponse(makeDatasourcesList()) }
  try {
    const { tools } = createSettingsContext({
      sources: [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }],
      defaultSource: 'id-prod',
    }, { GRAFANA_TOKEN_idprod: 'p' })
    const tool = toolByName(tools, 'grafana_compare')
    await assert.rejects(
      tool.execute({ sources: ['prod', 'singapore'], datasource: 'Prometheus', query: 'up' }, execution()),
      /Unknown Grafana source "singapore"/,
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_compare rejects bad input shapes and oversized expr without issuing requests', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return jsonResponse({}) }
  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_compare')
    await assert.rejects(tool.execute({ sources: ['a', 'b'], datasource: '   ', query: 'up' }, execution()), /datasource is required/)
    await assert.rejects(tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: '   ' }, execution()), /query is required/)
    await assert.rejects(
      tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: `up{${'x'.repeat(MAX_METRIC_EXPR_CHARS)}}` }, execution()),
      new RegExp(`query must not exceed ${MAX_METRIC_EXPR_CHARS}`),
    )
    await assert.rejects(tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up', mode: 'latest' }, execution()), /mode must be "instant" or "range"/)
    await assert.rejects(tool.execute({ sources: ['', 'a'], datasource: 'Prometheus', query: 'up' }, execution()), /non-empty/)
    await assert.rejects(tool.execute({ sources: [1, 'a'], datasource: 'Prometheus', query: 'up' }, execution()), /must be strings/)
    // range 模式：非法起止区间仍被拒；正向超 90 天窗口也拒。
    await assert.rejects(tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up', mode: 'range', from: 'now', to: 'now-1h' }, execution()), /must not be later than/)
    await assert.rejects(
      tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up', mode: 'range', from: `now-${TREND_WINDOW_DAYS + 30}d`, to: 'now' }, execution()),
      new RegExp(`exceeds the ${TREND_WINDOW_DAYS}-day limit`),
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 跨源站独立解析数据源（规格核心场景） ──────────────────────────────────────

test('grafana_compare resolves the same datasource NAME to a different UID on each source', async () => {
  // 这正是规格里点名要写的测试：两台 Grafana 上的「Prometheus」数据源 UID 不同，
  // compare 必须分别使用各自的 UID 发请求，不能错误复用一个 UID。
  const originalFetch = globalThis.fetch
  const calls = []
  // 关键：两台源站的 datasources 列表里都包含 name="Prometheus"，但 UID 不同。
  const A_DATASOURCES = [
    { uid: 'abc', type: 'prometheus', name: 'Prometheus', isDefault: true, access: 'proxy' },
  ]
  const B_DATASOURCES = [
    { uid: 'xyz', type: 'prometheus', name: 'Prometheus', isDefault: true, access: 'proxy' },
  ]
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: String(init?.method ?? 'GET'), body: init?.body ? JSON.parse(init.body) : null })
    if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
      // 单 series 标量响应（instant）
      return jsonResponse({ results: { A: { frames: [{ schema: { fields: [{ name: 'Value', type: 'number', labels: { job: 'api' } }] }, data: { values: [[1240]] } }] } } })
    }
    if (String(url).startsWith('https://a.example.com')) return jsonResponse(A_DATASOURCES)
    if (String(url).startsWith('https://b.example.com')) return jsonResponse(B_DATASOURCES)
    return jsonResponse([])
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-a', name: 'tokyo', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' },
        { id: 'id-b', name: 'singapore', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_idb' },
      ],
      defaultSource: 'id-a',
    }, { GRAFANA_TOKEN_ida: 'tokyo-token', GRAFANA_TOKEN_idb: 'sg-token' })
    const tool = toolByName(tools, 'grafana_compare')
    const out = await tool.execute({ sources: ['tokyo', 'singapore'], datasource: 'Prometheus', query: 'sum(rate(http_requests_total[5m]))' }, execution())

    // 1. 两台源站都被打到：先各自 GET /api/datasources，再 POST /api/ds/query。
    const getA = calls.find((c) => c.url === 'https://a.example.com/api/datasources' && c.method === 'GET')
    const getB = calls.find((c) => c.url === 'https://b.example.com/api/datasources' && c.method === 'GET')
    assert.ok(getA, 'expected GET /api/datasources on tokyo')
    assert.ok(getB, 'expected GET /api/datasources on singapore')

    const postA = calls.find((c) => c.url === 'https://a.example.com/api/ds/query' && c.method === 'POST')
    const postB = calls.find((c) => c.url === 'https://b.example.com/api/ds/query' && c.method === 'POST')
    assert.ok(postA, 'expected POST /api/ds/query on tokyo')
    assert.ok(postB, 'expected POST /api/ds/query on singapore')

    // 2. 两台源站的请求体里 datasource.uid 各自正确：tokyo 用 abc，singapore 用 xyz，
    //    不能错用同一个 UID。这是规格里明确点名要覆盖的关键场景。
    assert.equal(postA.body.queries[0].datasource.uid, 'abc')
    assert.equal(postB.body.queries[0].datasource.uid, 'xyz')
    assert.deepEqual(postA.body.queries[0].datasource, { type: 'prometheus', uid: 'abc' })
    assert.deepEqual(postB.body.queries[0].datasource, { type: 'prometheus', uid: 'xyz' })

    // 3. 输出里两台源站分别显示各自的 uid，模型不会误以为它们查同一台。
    assert.match(out, /"abc"/)
    assert.match(out, /"xyz"/)
    // 4. 单 series 且都是 instant：走分支 ①（紧凑表 + summary）。
    assert.match(out, /source      type        uid        value/)
    assert.match(out, /highest=/)
    assert.match(out, /lowest=/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── instant 单 series 横向比较 ──────────────────────────────────────────────

test('grafana_compare renders a compact side-by-side table and numeric summary for instant queries', async () => {
  const originalFetch = globalThis.fetch
  const sources = {
    tokyo: 1240.2,
    singapore: 1188.5,
    us: 402.1,
  }
  globalThis.fetch = async (url, init) => {
    const match = /^https:\/\/([^.]+)\.example\.com/.exec(String(url))
    const shortName = match[1]
    if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
      return jsonResponse({ results: { A: { frames: [{ schema: { fields: [{ name: 'Value', type: 'number' }] }, data: { values: [[sources[shortName]]] } }] } } })
    }
    return jsonResponse([{ uid: `${shortName[0]}p`, type: 'prometheus', name: 'Prometheus', isDefault: true }])
  }
  try {
    const { tools, listeners } = createSettingsContext({
      sources: [
        { id: 'id-tokyo', name: 'tokyo', baseUrl: 'https://tokyo.example.com', tokenRef: 'GRAFANA_TOKEN_idtokyo' },
        { id: 'id-sg', name: 'singapore', baseUrl: 'https://singapore.example.com', tokenRef: 'GRAFANA_TOKEN_idsg' },
        { id: 'id-us', name: 'us', baseUrl: 'https://us.example.com', tokenRef: 'GRAFANA_TOKEN_idus' },
      ],
      defaultSource: 'id-tokyo',
    }, { GRAFANA_TOKEN_idtokyo: 't', GRAFANA_TOKEN_idsg: 's', GRAFANA_TOKEN_idus: 'u' })
    const tool = toolByName(tools, 'grafana_compare')
    const out = await tool.execute({ sources: ['tokyo', 'singapore', 'us'], datasource: 'Prometheus', query: 'histogram_quantile(0.99, sum by (le) (rate(p99[5m])))' }, execution())

    const lines = out.split('\n')
    assert.match(lines[0], /compare mode=instant/)
    assert.match(lines[0], /query="histogram_quantile\(/)
    assert.match(lines[0], /datasource="Prometheus"/)
    assert.equal(lines[1], 'sources=3 succeeded=3 no_data=0 failed=0')
    // 紧凑表 + 数值摘要
    const tableHeader = lines.indexOf('source      type        uid        value')
    assert.notEqual(tableHeader, -1)
    assert.match(lines[tableHeader + 1], /tokyo\s+prometheus\s+"tp"\s+1240/)
    assert.match(lines[tableHeader + 2], /singapore\s+prometheus\s+"sp"\s+1189/)
    assert.match(lines[tableHeader + 3], /us\s+prometheus\s+"up"\s+402\.1/)
    // 数学 summary：tokyo 1240 最大，us 402 最小；max/min = 1240 / 402 = 3.08x
    const summaryIdx = lines.findIndex((l) => l.startsWith('summary ('))
    assert.notEqual(summaryIdx, -1)
    assert.match(lines[summaryIdx], /based on 3 of 3 source\(s\)/)
    assert.match(lines[summaryIdx + 1], /highest=tokyo \(value=1240\)/)
    assert.match(lines[summaryIdx + 2], /lowest=us \(value=402\.1\)/)
    assert.match(lines[summaryIdx + 3], /avg=/)
    assert.match(lines[summaryIdx + 4], /max\/min=3\.08x/)

    await assertNoWriteSnapshot(listeners)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── range 横向比较 ─────────────────────────────────────────────────────────

test('grafana_compare renders per-source first/last/min/max/avg/trend for range queries', async () => {
  const originalFetch = globalThis.fetch
  // 三种典型走势：flat / rising / falling，跨度够大以保证分桶后趋势仍可识别。
  // 数据故意保持简单：flat=100 恒定；rising=100..160 步长 1；falling=1000..101 步长 15。
  // 均值/边界都规整，避免 formatNumber 收敛成不可预测的小数让断言难写。
  const flat60 = Array.from({ length: 60 }, () => 100)                   // tokyo: flat
  const rising60 = Array.from({ length: 60 }, (_, i) => 100 + i)           // singapore: 100..159
  const falling60 = Array.from({ length: 60 }, (_, i) => 1000 - i * 15)   // us: 1000..115
  const fixtures = { tokyo: flat60, singapore: rising60, us: falling60 }
  globalThis.fetch = async (url, init) => {
    const match = /^https:\/\/([^.]+)\.example\.com/.exec(String(url))
    const shortName = match[1]
    if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
      return jsonResponse({ results: { A: { frames: [liveFrame(fixtures[shortName], { job: 'api' })] } } })
    }
    return jsonResponse([{ uid: `${shortName[0]}p`, type: 'prometheus', name: 'Prometheus', isDefault: true }])
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-tokyo', name: 'tokyo', baseUrl: 'https://tokyo.example.com', tokenRef: 'GRAFANA_TOKEN_idtokyo' },
        { id: 'id-sg', name: 'singapore', baseUrl: 'https://singapore.example.com', tokenRef: 'GRAFANA_TOKEN_idsg' },
        { id: 'id-us', name: 'us', baseUrl: 'https://us.example.com', tokenRef: 'GRAFANA_TOKEN_idus' },
      ],
      defaultSource: 'id-tokyo',
    }, { GRAFANA_TOKEN_idtokyo: 't', GRAFANA_TOKEN_idsg: 's', GRAFANA_TOKEN_idus: 'u' })
    const tool = toolByName(tools, 'grafana_compare')
    const out = await tool.execute({ sources: ['tokyo', 'singapore', 'us'], datasource: 'Prometheus', query: 'rate(req_total[5m])', mode: 'range', from: 'now-1h', to: 'now', points: 60 }, execution())
    const lines = out.split('\n')

    assert.match(lines[0], /compare mode=range/)
    assert.match(lines[0], /range=now-1h\.\.now/)
    assert.match(lines[0], /step=\d+ms/)
    assert.equal(lines[1], 'sources=3 succeeded=3 no_data=0 failed=0')
    const headerIdx = lines.indexOf('source      type        uid        first    last     min      max      avg      trend')
    assert.notEqual(headerIdx, -1)
    // flat: first=last=min=max=avg=100
    assert.match(lines[headerIdx + 1], /tokyo\s+prometheus\s+"tp"\s+100\s+100\s+100\s+100\s+100\s+flat/)
    // rising 100→159：first=100, last=159, min=100, max=159, avg=129.5
    assert.match(lines[headerIdx + 2], /singapore\s+prometheus\s+"sp"\s+100\s+159\s+100\s+159\s+129\.5\s+rising/)
    // falling 1000→115：first=1000, last=115, min=115, max=1000, avg=557.5
    assert.match(lines[headerIdx + 3], /us\s+prometheus\s+"up"\s+1000\s+115\s+115\s+1000\s+557\.5\s+falling/)
    // summary 用 avg：us (557.5) > singapore (129.5) > tokyo (100)
    const summaryIdx = lines.findIndex((l) => l.startsWith('summary ('))
    assert.match(lines[summaryIdx + 1], /highest=us \(avg=557\.5\)/)
    assert.match(lines[summaryIdx + 2], /lowest=tokyo \(avg=100\)/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 多 series：直接数值比较不可用，走 per-source 详情 ───────────────────────

test('grafana_compare reports direct comparison unavailable when any source returns multiple series', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const match = /^https:\/\/([^.]+)\.example\.com/.exec(String(url))
    const shortName = match[1]
    if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
      // tokyo 单 series，singapore 多 series — 走分支 ②。
      if (shortName === 'tokyo') {
        return jsonResponse({ results: { A: { frames: [{ schema: { fields: [{ name: 'Value', type: 'number', labels: { job: 'api' } }] }, data: { values: [[1]] } }] } } })
      }
      return jsonResponse({ results: { A: { frames: [{ schema: { fields: [{ name: 'Value', type: 'number', labels: { job: 'api' } }, { name: 'Value', type: 'number', labels: { job: 'web' } }, { name: 'Value', type: 'number', labels: { job: 'db' } }] }, data: { values: [[1], [1], [1]] } }] } } })
    }
    return jsonResponse([{ uid: `${shortName[0]}p`, type: 'prometheus', name: 'Prometheus' }])
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-tokyo', name: 'tokyo', baseUrl: 'https://tokyo.example.com', tokenRef: 'GRAFANA_TOKEN_idtokyo' },
        { id: 'id-sg', name: 'singapore', baseUrl: 'https://singapore.example.com', tokenRef: 'GRAFANA_TOKEN_idsg' },
      ],
      defaultSource: 'id-tokyo',
    }, { GRAFANA_TOKEN_idtokyo: 't', GRAFANA_TOKEN_idsg: 's' })
    const tool = toolByName(tools, 'grafana_compare')
    const out = await tool.execute({ sources: ['tokyo', 'singapore'], datasource: 'Prometheus', query: 'up' }, execution())
    const lines = out.split('\n')

    // 提示行：明确说「不可用」+ 多少源站多 series
    const note = lines.find((l) => l.includes('direct comparison unavailable'))
    assert.ok(note, `expected note line, got: ${JSON.stringify(out)}`)
    assert.match(note, /1 of 2 successful source\(s\) returned multiple series/)
    // singapore 行：series=N
    const sgLine = lines.find((l) => l.includes('singapore') && l.includes('series='))
    assert.ok(sgLine, `expected singapore series= line in: ${JSON.stringify(out)}`)
    assert.match(sgLine, /series=3/)
    // per-series 行（缩进两空格）
    assert.ok(lines.some((l) => l.startsWith('  series')), 'expected indented series lines')
    // summary 行不会出现（多 series 路径）
    assert.equal(lines.find((l) => l.startsWith('summary (')), undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_compare does not silently take the first series of a multi-series response', async () => {
  // 直接构造 summarizeCompareResult 输入，断言多 series 时整个列表保留，
  // 第一条 series 不会被「假装成该 source 的值」。
  const lines = summarizeCompareResult([
    { name: 'tokyo', ok: true, datasource: { type: 'prometheus', uid: 'a' }, series: [{ kind: 'instant', label: '{a}', value: 100 }, { kind: 'instant', label: '{b}', value: 200 }] },
    { name: 'sg', ok: true, datasource: { type: 'prometheus', uid: 'b' }, series: [{ kind: 'instant', label: '{a}', value: 300 }] },
  ], { mode: 'instant', query: 'up', totalSources: 2, datasourceWanted: 'Prometheus' })
  const out = lines.join('\n')
  // 不该出现 compact 表（多 series 源站）
  assert.equal(out.includes('source      type        uid        value'), false)
  // 不该出现 summary（多 series 源站）
  assert.equal(out.includes('summary ('), false)
  // tokyo 必须以 series= 形式呈现
  const tokyoLine = out.split('\n').find((l) => l.startsWith('tokyo:'))
  assert.match(tokyoLine, /series=2/)
  // 两条 series 都在（缩进行，含各自的标签）
  assert.ok(out.includes('{a}') && out.includes('{b}'), `missing labels: ${out}`)
})

// ── partial failure ─────────────────────────────────────────────────────────

test('grafana_compare keeps successful results when one source fails (401/403 sanitized)', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const match = /^https:\/\/([^.]+)\.example\.com/.exec(String(url))
    const shortName = match[1]
    if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
      // singapore 拒：模拟 403 带回显凭据
      if (shortName === 'singapore') {
        return jsonResponse({ message: 'access denied — Bearer glsa_AAAAAAAAAAAAAAAAAAAA' }, 403)
      }
      return jsonResponse({ results: { A: { frames: [{ schema: { fields: [{ name: 'Value', type: 'number' }] }, data: { values: [[42]] } }] } } })
    }
    return jsonResponse([{ uid: `${shortName[0]}p`, type: 'prometheus', name: 'Prometheus' }])
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-tokyo', name: 'tokyo', baseUrl: 'https://tokyo.example.com', tokenRef: 'GRAFANA_TOKEN_idtokyo' },
        { id: 'id-sg', name: 'singapore', baseUrl: 'https://singapore.example.com', tokenRef: 'GRAFANA_TOKEN_idsg' },
        { id: 'id-us', name: 'us', baseUrl: 'https://us.example.com', tokenRef: 'GRAFANA_TOKEN_idus' },
      ],
      defaultSource: 'id-tokyo',
    }, { GRAFANA_TOKEN_idtokyo: 't', GRAFANA_TOKEN_idsg: 's', GRAFANA_TOKEN_idus: 'u' })
    const tool = toolByName(tools, 'grafana_compare')
    const out = await tool.execute({ sources: ['tokyo', 'singapore', 'us'], datasource: 'Prometheus', query: 'up' }, execution())
    const lines = out.split('\n')

    // 计数：1 失败 + 2 成功
    assert.equal(lines[1], 'sources=3 succeeded=2 no_data=0 failed=1')
    // singapore 行的错误脱敏：Bearer 与 glsa_ 已脱敏
    const sgLine = lines.find((l) => l.startsWith('singapore'))
    assert.ok(sgLine, `expected singapore line in: ${JSON.stringify(out)}`)
    assert.match(sgLine, /ERROR:/)
    assert.match(sgLine, /datasources:query/)
    assert.doesNotMatch(sgLine, /Bearer /)
    assert.doesNotMatch(sgLine, /glsa_/)
    // tokyo 与 us 行正常
    assert.ok(lines.some((l) => l.startsWith('tokyo') && !l.includes('ERROR')))
    assert.ok(lines.some((l) => l.startsWith('us') && !l.includes('ERROR')))
    // summary 仍出：基于 2 of 3
    const summaryIdx = lines.findIndex((l) => l.startsWith('summary ('))
    assert.notEqual(summaryIdx, -1)
    assert.match(lines[summaryIdx], /based on 2 of 3 source\(s\)/)
    assert.match(lines[summaryIdx], /, 1 failed/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_compare returns per-source ERROR rows when all sources fail', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
      return jsonResponse({ message: 'query failed' }, 500)
    }
    const match = /^https:\/\/([^.]+)\.example\.com/.exec(String(url))
    return jsonResponse([{ uid: `${match[1][0]}p`, type: 'prometheus', name: 'Prometheus' }])
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' },
        { id: 'id-b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_idb' },
      ],
      defaultSource: 'id-a',
    }, { GRAFANA_TOKEN_ida: 'x', GRAFANA_TOKEN_idb: 'y' })
    const tool = toolByName(tools, 'grafana_compare')
    const out = await tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up' }, execution())
    const lines = out.split('\n')
    assert.equal(lines[1], 'sources=2 succeeded=0 no_data=0 failed=2')
    // summary 行不出现（全失败）
    assert.equal(lines.find((l) => l.startsWith('summary (')), undefined)
    // 两行 ERROR 都在
    assert.equal(lines.filter((l) => l.includes('ERROR:')).length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── NO DATA / partial NO DATA ──────────────────────────────────────────────

test('grafana_compare distinguishes query success with no data from query failure', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const match = /^https:\/\/([^.]+)\.example\.com/.exec(String(url))
    const shortName = match[1]
    if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
      // singapore 成功但无数据；us 拒 401
      if (shortName === 'singapore') return jsonResponse({ results: { A: { frames: [] } } })
      if (shortName === 'us') return jsonResponse({ message: 'unauthorized' }, 401)
      return jsonResponse({ results: { A: { frames: [{ schema: { fields: [{ name: 'Value', type: 'number' }] }, data: { values: [[12.4]] } }] } } })
    }
    return jsonResponse([{ uid: `${shortName[0]}p`, type: 'prometheus', name: 'Prometheus' }])
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-tokyo', name: 'tokyo', baseUrl: 'https://tokyo.example.com', tokenRef: 'GRAFANA_TOKEN_idtokyo' },
        { id: 'id-sg', name: 'singapore', baseUrl: 'https://singapore.example.com', tokenRef: 'GRAFANA_TOKEN_idsg' },
        { id: 'id-us', name: 'us', baseUrl: 'https://us.example.com', tokenRef: 'GRAFANA_TOKEN_idus' },
      ],
      defaultSource: 'id-tokyo',
    }, { GRAFANA_TOKEN_idtokyo: 't', GRAFANA_TOKEN_idsg: 's', GRAFANA_TOKEN_idus: 'u' })
    const tool = toolByName(tools, 'grafana_compare')
    const out = await tool.execute({ sources: ['tokyo', 'singapore', 'us'], datasource: 'Prometheus', query: 'up' }, execution())
    const lines = out.split('\n')
    // 三向分区：succeeded（有值）/ no_data（请求成功无返回值）/ failed（请求失败）。
    // tokyo=succeeded, singapore=no_data, us=failed。
    assert.equal(lines[1], 'sources=3 succeeded=1 no_data=1 failed=1')
    // NO DATA 与 ERROR 是不同的两行，绝不混为 n/a。
    const sgLine = lines.find((l) => l.startsWith('singapore'))
    const usLine = lines.find((l) => l.startsWith('us'))
    assert.match(sgLine, /NO DATA/)
    assert.match(usLine, /ERROR:/)
    // summary 只基于真正有值的源站：基于 1 of 3，附注「1 returned no data, 1 failed」。
    const summaryIdx = lines.findIndex((l) => l.startsWith('summary ('))
    assert.notEqual(summaryIdx, -1)
    assert.match(lines[summaryIdx], /based on 1 of 3/)
    assert.match(lines[summaryIdx], /1 returned no data/)
    assert.match(lines[summaryIdx], /1 failed/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 超时 / AbortSignal ─────────────────────────────────────────────────────

test('grafana_compare stops on AbortSignal and never produces a partial-looking result', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ results: { A: { frames: [] } } })
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' },
        { id: 'id-b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_idb' },
      ],
      defaultSource: 'id-a',
    }, { GRAFANA_TOKEN_ida: 'x', GRAFANA_TOKEN_idb: 'y' })
    const tool = toolByName(tools, 'grafana_compare')
    // 调用前立即 abort：execute 应当把这个 cancel 翻译成一个明确错误，
    // 而不是返回一份看起来完整的部分结果。
    const exec = { signal: AbortSignal.abort() }
    await assert.rejects(tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up' }, exec), /cancelled|abort/i)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── response bounding（2MB 硬顶） ────────────────────────────────────────────

test('grafana_compare turns the response-size hard limit into an actionable error per source', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    // 模拟响应超限：内容长度超过 2MB
    return new Response('x'.repeat(2 * 1024 * 1024 + 1), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) },
    })
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' },
        { id: 'id-b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_idb' },
      ],
      defaultSource: 'id-a',
    }, { GRAFANA_TOKEN_ida: 'x', GRAFANA_TOKEN_idb: 'y' })
    const tool = toolByName(tools, 'grafana_compare')
    const out = await tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up' }, execution())
    const lines = out.split('\n')
    assert.equal(lines[1], 'sources=2 succeeded=0 no_data=0 failed=2')
    // 两行都是 ERROR，且提示「响应超限 + 减少序列数」的可执行建议。
    const errorLines = lines.filter((l) => l.includes('ERROR:'))
    assert.equal(errorLines.length, 2)
    for (const line of errorLines) {
      assert.match(line, /too large|exceeds the \d+-byte limit/)
      assert.match(line, /high-cardinality|aggregation/i)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 每源站 series 上限（response bounding 的另一面） ─────────────────────────

test('grafana_compare caps each source at MAX_COMPARE_SERIES_PER_SOURCE and discloses hidden series', () => {
  // 直接构造 summarizeCompareResult 输入，断言多条 series 时按上限截断并披露 hidden。
  // 输入 8 条 series（5 上限 + 3 隐藏），第一行写 series=8 与「(+3 hidden)」。
  const total = MAX_COMPARE_SERIES_PER_SOURCE + 3
  const manySeries = Array.from({ length: MAX_COMPARE_SERIES_PER_SOURCE }, (_, i) => ({
    kind: 'instant', label: `{job="${i}"}`, value: i + 1,
  }))
  const lines = summarizeCompareResult([
    { name: 'tokyo', ok: true, datasource: { type: 'prometheus', uid: 'a' }, series: manySeries, hidden: 3 },
    { name: 'sg', ok: true, datasource: { type: 'prometheus', uid: 'b' }, series: [{ kind: 'instant', label: '{job="0"}', value: 100 }] },
  ], { mode: 'instant', query: 'up', totalSources: 2, datasourceWanted: 'Prometheus' })
  const out = lines.join('\n')
  // 多 series：分支 ②；series 计数行写「上限值 (+N hidden)」
  const tokyoLine = out.split('\n').find((l) => l.startsWith('tokyo:'))
  assert.match(tokyoLine, new RegExp(`series=${MAX_COMPARE_SERIES_PER_SOURCE}.*\\+3 hidden`))
  // 显示的 series 行数等于上限（隐含：MAX_COMPARE_SERIES_PER_SOURCE 条缩进的 series 行）。
  const seriesLines = out.split('\n').filter((l) => l.startsWith('  series '))
  assert.equal(seriesLines.length, MAX_COMPARE_SERIES_PER_SOURCE)
})

// ── 零值/NaN 边界：summary 不出 ∞% ──────────────────────────────────────────

test('grafana_compare reports n/a instead of infinity when summary ratio is undefined (zero-value or all-zero cases)', () => {
  // 1) 最低为 0、最高有限 → 不出 ∞%。
  const zeroLines = summarizeCompareResult([
    { name: 'tokyo', ok: true, datasource: { type: 'prometheus', uid: 'a' }, series: [{ kind: 'instant', label: '{a}', value: 0 }] },
    { name: 'sg', ok: true, datasource: { type: 'prometheus', uid: 'b' }, series: [{ kind: 'instant', label: '{a}', value: 100 }] },
  ], { mode: 'instant', query: 'up', totalSources: 2, datasourceWanted: 'Prometheus' })
  assert.match(zeroLines.join('\n'), /max\/min=n\/a/)

  // 2) 全为 0 → 视为相等（ratio = 1）。
  const allZero = summarizeCompareResult([
    { name: 'a', ok: true, datasource: { type: 'prometheus', uid: 'a' }, series: [{ kind: 'instant', label: '{a}', value: 0 }] },
    { name: 'b', ok: true, datasource: { type: 'prometheus', uid: 'b' }, series: [{ kind: 'instant', label: '{a}', value: 0 }] },
  ], { mode: 'instant', query: 'up', totalSources: 2, datasourceWanted: 'Prometheus' })
  assert.match(allZero.join('\n'), /max\/min=1\.00x/)

  // 3) NaN / Infinity：summary 渲染前 numericValues 过滤非有限值，不会出 ∞%。
  //    注：summarizeCompareSeries 自身（通过 numericStats）就已经过滤，所以这条
  //    主要覆盖直接构造 summarizeCompareResult 入参的兜底——渲染层不抛 NaN。
  const nanLines = summarizeCompareResult([
    { name: 'a', ok: true, datasource: { type: 'prometheus', uid: 'a' }, series: [{ kind: 'instant', label: '{a}', value: 1 }] },
    { name: 'b', ok: true, datasource: { type: 'prometheus', uid: 'b' }, series: [{ kind: 'instant', label: '{a}', value: NaN }] },
  ], { mode: 'instant', query: 'up', totalSources: 2, datasourceWanted: 'Prometheus' })
  // 只剩一个有效数值时 summary 不出 max/min（validCount < 2）。
  assert.equal(nanLines.join('\n').includes('Infinity'), false)
  assert.doesNotMatch(nanLines.join('\n'), /max\/min=Infinity/)
})

// ── 纯函数：summarizeCompareSeries 与 summarizeCompareResult 的边界 ──────────

test('summarizeCompareSeries covers instant single/multi-point, range, log, and empty frames', () => {
  // 单点 instant
  const single = [{
    schema: { fields: [{ name: 'Value', type: 'number', labels: { job: 'api' } }] },
    data: { values: [[42]] },
  }]
  const singleSeries = summarizeCompareSeries(single[0], { mode: 'instant', points: 60, fromMs: 0, toMs: 1 })
  assert.equal(singleSeries.length, 1)
  assert.equal(singleSeries[0].kind, 'instant')
  assert.equal(singleSeries[0].value, 42)
  assert.equal(singleSeries[0].rows, undefined)

  // 多点 instant（表格帧：cols.length > 1 给 range=instant 路径附带 min/max/avg/rows）
  const multi = [{
    schema: { fields: [{ name: 'Value', type: 'number' }] },
    data: { values: [[1, 5, 10]] },
  }]
  const multiSeries = summarizeCompareSeries(multi[0], { mode: 'instant', points: 60, fromMs: 0, toMs: 1 })
  assert.equal(multiSeries[0].kind, 'instant')
  assert.equal(multiSeries[0].value, 10)
  assert.equal(multiSeries[0].min, 1)
  assert.equal(multiSeries[0].max, 10)
  // numericStats 返回原始均值（不会被 formatNumber 收敛），与渲染层无关。
  assert.equal(multiSeries[0].avg, (1 + 5 + 10) / 3)
  assert.equal(multiSeries[0].rows, 3)

  // range 单 series
  const rangeSeries = summarizeCompareSeries(liveFrame([10, 20, 30]), { mode: 'range', points: 3, fromMs: 0, toMs: RANGE_SPAN })
  assert.equal(rangeSeries[0].kind, 'range')
  assert.equal(rangeSeries[0].first, 10)
  assert.equal(rangeSeries[0].last, 30)
  assert.equal(rangeSeries[0].min, 10)
  assert.equal(rangeSeries[0].max, 30)
  assert.equal(rangeSeries[0].avg, 20)

  // log 帧
  const log = [{
    schema: { fields: [{ name: 'Line', type: 'string' }] },
    data: { values: [['first', 'second', 'last']] },
  }]
  const logSeries = summarizeCompareSeries(log[0], { mode: 'range', points: 3, fromMs: 0, toMs: 1 })
  assert.equal(logSeries[0].kind, 'log')
  assert.equal(logSeries[0].lines, 3)
  assert.equal(logSeries[0].last, 'last')

  // 无数值列（仅有空字符串字段）
  const empty = [{ schema: { fields: [{ name: 'note', type: 'string' }] }, data: { values: [[]] } }]
  const emptySeries = summarizeCompareSeries(empty[0], { mode: 'instant', points: 60, fromMs: 0, toMs: 1 })
  assert.equal(emptySeries[0].kind, 'log')
  assert.equal(emptySeries[0].lines, 0)

  // 防御性空输入
  assert.deepEqual(summarizeCompareSeries(null, {}), [])
  assert.deepEqual(summarizeCompareSeries({}, {}), [])
})

test('summarizeCompareResult with all-failed sources returns per-source ERROR rows and omits summary', () => {
  const lines = summarizeCompareResult([
    { name: 'a', ok: false, error: 'Grafana API 401 GET /api/datasources: missing token' },
    { name: 'b', ok: false, error: 'the datasource rejected the query: parse error' },
  ], { mode: 'instant', query: 'up', totalSources: 2, datasourceWanted: 'Prometheus' })
  const out = lines.join('\n')
  assert.match(out, /sources=2 succeeded=0 no_data=0 failed=2/)
  assert.match(out, /ERROR: Grafana API 401/)
  assert.match(out, /ERROR: the datasource rejected the query: parse error/)
  // summary 行不出现（全失败）
  assert.equal(out.includes('summary ('), false)
})

// ── 共享原语 regression：runBareMetricQuery 仍兼容 grafana_metric ────────────

test('grafana_metric still works after the runBareMetricQuery extraction (regression)', async () => {
  // grafana_metric 的入口签名、参数校验、请求体、响应渲染逐字不变。
  // 抽 helper 后 grafana_compare 与 grafana_metric 共用同一段，确保 metric
  // 既有行为完全兼容（详见 metrics.test.js 里的全部用例）。
  const originalFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/datasources')) return jsonResponse(makeDatasourcesList())
    bodies.push(JSON.parse(init.body))
    // 60 点递增序列铺满 2h 窗口：与既有 metrics.test.js 中 trend=rising 的断言
    // 同款 fixture（time-bucketing 在 1h 窗口下可能因覆盖度不够判 n/a）。
    return jsonResponse({ results: { A: { frames: [liveFrame(Array.from({ length: 60 }, (_, i) => i + 1), { host: 'a' }, 7_200_000)] } } })
  }
  try {
    const { tools } = createContext()
    const out = await toolByName(tools, 'grafana_metric').execute({ datasource: 'prom-prod', expr: 'rate(up[5m])', mode: 'range', from: 'now-2h', to: 'now', points: 60 }, execution())
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].queries[0].datasource.uid, 'prom-prod')
    assert.match(out, /mode=range/)
    assert.match(out, /trend=rising/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 工具不记写快照、不进审批门 ─────────────────────────────────────────────

test('grafana_compare records no write snapshot and triggers no approval', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ results: { A: { frames: [] } } })
  try {
    const { tools, listeners } = createSettingsContext({
      sources: [
        { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' },
        { id: 'id-b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_idb' },
      ],
      defaultSource: 'id-a',
    }, { GRAFANA_TOKEN_ida: 'x', GRAFANA_TOKEN_idb: 'y' })
    const tool = toolByName(tools, 'grafana_compare')

    // 走完一次调用，立刻尝试 grafana_push：应当被「无最近可信快照」拒绝。
    await tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up' }, execution())
    await assertNoWriteSnapshot(listeners)

    // pre-execute 不应因 grafana_compare 进入「ask」分支：它是只读工具，工具描述里
    // 已声明 Read-only；若某天写错加了 ask 路径，下面这条会立刻捕获。
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_compare',
      arguments: { sources: ['a', 'b'], datasource: 'Prometheus', query: 'up' },
    }, async () => ({ kind: 'allow' }))
    assert.notEqual(decision.kind, 'ask')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── 其它 ────────────────────────────────────────────────────────────────────

test('grafana_compare uses the default source resolution when no source argument is involved in per-source names', async () => {
  // sources 数组中的名称仍然独立按名解析——默认源站解析只用于「省略 source 时」，
  // compare 永远按名称逐台解析，绝不隐式用 default 顶替数组里的某一项。
  // a 必为 default 但数组里同时含 a/b：要求 a/b 两台都被独立解析（不同 UID），
  // 且因 a 的值更大（10），highest=a、lowest=b 验证默认源站不在数组里被忽略。
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const m = /^https:\/\/([^.]+)\.example\.com/.exec(String(url))
    const shortName = m[1]
    if (String(init?.method ?? 'GET').toUpperCase() === 'POST') {
      const value = shortName === 'a' ? 10 : 5
      return jsonResponse({ results: { A: { frames: [{ schema: { fields: [{ name: 'Value', type: 'number' }] }, data: { values: [[value]] } }] } } })
    }
    return jsonResponse([{ uid: `${shortName[0]}p`, type: 'prometheus', name: 'Prometheus' }])
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' },
        { id: 'id-b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_idb' },
      ],
      defaultSource: 'id-a',
    }, { GRAFANA_TOKEN_ida: 'x', GRAFANA_TOKEN_idb: 'y' })
    const tool = toolByName(tools, 'grafana_compare')
    // 故意不放 default 源站到数组里；要求精确按名称解析。
    const out = await tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up' }, execution())
    // 两台源站都打到了
    assert.match(out, /sources=2 succeeded=2 no_data=0 failed=0/)
    assert.match(out, /highest=a/)
    assert.match(out, /lowest=b/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_compare honors METRIC_DEFAULT_POINTS as the default sampling density', async () => {
  const originalFetch = globalThis.fetch
  const bodies = []
  // 带 time 字段的 fixture，让 range 模式走完整分支（不退回 instant）。
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/datasources')) return jsonResponse([{ uid: 'p', type: 'prometheus', name: 'Prometheus' }])
    bodies.push(JSON.parse(init.body))
    return jsonResponse({ results: { A: { frames: [liveFrame([1, 2, 3], {}, 3_600_000)] } } })
  }
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' },
        { id: 'id-b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_idb' },
      ],
      defaultSource: 'id-a',
    }, { GRAFANA_TOKEN_ida: 'x', GRAFANA_TOKEN_idb: 'y' })
    const tool = toolByName(tools, 'grafana_compare')
    await tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up', mode: 'range', from: 'now-1h', to: 'now' }, execution())
    // points 默认值 = METRIC_DEFAULT_POINTS；intervalMs = (1h)/points
    const expectedInterval = Math.ceil(3_600_000 / METRIC_DEFAULT_POINTS)
    assert.equal(bodies.length, 2)
    for (const body of bodies) {
      assert.equal(body.queries[0].maxDataPoints, METRIC_DEFAULT_POINTS)
      assert.equal(body.queries[0].intervalMs, expectedInterval)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_compare enforces METRIC_MIN_POINTS and METRIC_MAX_POINTS bounds on points', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({})
  try {
    const { tools } = createSettingsContext({
      sources: [
        { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' },
        { id: 'id-b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_idb' },
      ],
      defaultSource: 'id-a',
    }, { GRAFANA_TOKEN_ida: 'x', GRAFANA_TOKEN_idb: 'y' })
    const tool = toolByName(tools, 'grafana_compare')
    await assert.rejects(
      tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up', mode: 'range', points: METRIC_MIN_POINTS - 1 }, execution()),
      new RegExp(`points must be an integer between ${METRIC_MIN_POINTS} and`),
    )
    await assert.rejects(
      tool.execute({ sources: ['a', 'b'], datasource: 'Prometheus', query: 'up', mode: 'range', points: 1000 }, execution()),
      /points must be an integer between/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})