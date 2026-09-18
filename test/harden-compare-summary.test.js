// Correctness hardening — Bug A: grafana_compare partial-result semantics.
// 复现并锁定：数学 summary（highest/lowest/avg/ratio）只在「全部请求源站都成功
// 且各自恰好返回一个可比标量」时才输出；任一源站失败 / 无数据 / 多 series 都让
// 比较不完整，此时只保留 per-source 明细并省略 summary，绝不把部分证据伪装成
// 完整比较。
import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeCompareResult } from '../lib/query.js'

const opt = (extra = {}) => ({ mode: 'instant', query: 'up', totalSources: 3, datasourceWanted: 'Prometheus', ...extra })
const single = (name, value, extra = {}) => ({
  name,
  ok: true,
  datasource: { type: 'prometheus', uid: 'x' },
  series: [{ kind: 'instant', label: '{a}', value }],
  ...extra,
})

// Case A1 — 全部成功且各为单标量：必须有数学 summary。
test('A1 all requested sources succeed with one scalar each → summary present', () => {
  const out = summarizeCompareResult([
    single('tokyo', 120),
    single('sg', 90),
    single('us', 40),
  ], opt()).join('\n')
  assert.match(out, /summary \(based on 3 of 3 source/)
  assert.match(out, /highest=tokyo/)
  assert.match(out, /lowest=us/)
  assert.match(out, /avg=/)
})

// Case A2 — 一个超时/失败：summary 省略，但其余成功值与失败行都保留。
test('A2 one source times out/fails → summary omitted, partial results retained', () => {
  const lines = summarizeCompareResult([
    single('tokyo', 120),
    { name: 'sg', ok: false, error: 'timeout' },
    single('us', 90),
  ], opt())
  const out = lines.join('\n')
  assert.ok(out.includes('tokyo'), 'tokyo retained')
  assert.ok(out.includes('us'), 'us retained')
  assert.match(out, /sg:.*ERROR/)
  assert.equal(lines.find((l) => l.startsWith('summary (')), undefined, 'no summary when a source failed')
  assert.match(out, /Comparison summary omitted/)
})

// Case A3 — 一个无数据：summary 省略。
test('A3 one source returns no data → summary omitted', () => {
  const lines = summarizeCompareResult([
    single('tokyo', 120),
    { name: 'sg', ok: true, noData: true, series: [] },
    single('us', 90),
  ], opt())
  const out = lines.join('\n')
  assert.equal(lines.find((l) => l.startsWith('summary (')), undefined)
  assert.match(out, /sg:.*NO DATA/)
  assert.match(out, /Comparison summary omitted/)
})

// Case A4 — 一个返回多 series：summary 省略（本轮不新增 collapse 策略）。
test('A4 one source returns multiple series → summary omitted', () => {
  const lines = summarizeCompareResult([
    single('tokyo', 120),
    { name: 'sg', ok: true, datasource: { type: 'prometheus', uid: 'y' }, series: [
      { kind: 'instant', label: '{a}', value: 1 },
      { kind: 'instant', label: '{b}', value: 2 },
    ] },
  ], { mode: 'instant', query: 'up', totalSources: 2, datasourceWanted: 'Prometheus' })
  const out = lines.join('\n')
  assert.equal(lines.find((l) => l.startsWith('summary (')), undefined)
  assert.match(out, /sg:.*series=2/)
  assert.match(out, /Comparison summary omitted/)
})

// Case A5 — 2 源下限由工具在更上游强制，summary 闸门本身只要求「全部可比」；
// 单源输入（totalSources=1）在工具层面不可达，但闸门不应擅自抬高比较门槛。
test('A5 single-source input still emits a summary (2-source minimum is enforced upstream, not by the summary gate)', () => {
  const out = summarizeCompareResult([single('only', 7)], {
    mode: 'instant', query: 'up', totalSources: 1, datasourceWanted: 'Prometheus',
  }).join('\n')
  assert.match(out, /summary \(based on 1 of 1 source/)
})

// Case A6 — 可比性按 mode 判定：range 紧凑表要渲染 first/last/min/max/avg 一整行，
// 无时间轴的表格帧在 range 下只能给出 instant 形状（value/min/max/avg/rows）。
// 修复前它被当成可比值、无条件读取 first/last，formatNumber(undefined) 直接抛错，
// 整次 grafana_compare 调用失败。
const rangeOpt = (extra = {}) => ({ mode: 'range', query: 'up', range: 'now-1h..now', totalSources: 2, datasourceWanted: 'Prometheus', stepMs: 60_000, ...extra })
const tableSeries = () => [{ kind: 'instant', label: '"(unnamed series)"', value: 2, min: 1, max: 2, avg: 1.5, rows: 2 }]

test('A6 range mode with a no-time-axis table frame → per-source detail instead of a crash', () => {
  const lines = summarizeCompareResult([
    { name: 'a', ok: true, datasource: { type: 'prometheus', uid: 'x' }, series: tableSeries() },
    { name: 'b', ok: true, datasource: { type: 'prometheus', uid: 'y' }, series: tableSeries() },
  ], rangeOpt())
  const out = lines.join('\n')
  assert.doesNotMatch(out, /first    last/, 'must not render the range compact table')
  assert.match(out, /Comparison summary omitted/)
  // 值本身不丢：per-source 行仍给出 instant 形状的统计与行数。
  assert.match(out, /a:.*value=2/)
  assert.match(out, /b:.*value=2/)
  assert.match(out, /rows=2/)
  // 不可直接比较的原因必须写出来，否则模型只看到「omitted」无从判断该怎么办。
  assert.match(out, /time axis|not comparable/i)
})

// Case A7 — 正例：真正的 range 形状（带完整区间统计）仍走紧凑表 + summary，
// 收紧闸门不能把正常的 range 比较一起挡掉。
test('A7 range mode with complete range series still renders the compact table and summary', () => {
  const ranged = (name, uid, first, last) => ({
    name,
    ok: true,
    datasource: { type: 'prometheus', uid },
    series: [{ kind: 'range', label: '{a}', points: 4, buckets: 4, first, last, min: first, max: last, avg: (first + last) / 2, trend: 'rising', spark: '▁▂▄█' }],
  })
  const lines = summarizeCompareResult([
    ranged('a', 'x', 100, 200),
    ranged('b', 'y', 10, 20),
  ], rangeOpt())
  const out = lines.join('\n')
  assert.match(out, /first    last     min      max      avg      trend/)
  assert.match(out, /summary \(based on 2 of 2 source/)
  assert.match(out, /highest=a/)
})

// Case A8 — range 形状缺字段（直接构造入参的兜底）：字段不全等同不可比，
// 不能渲染出一行 undefined/NaN。
test('A8 range series missing stats fields is treated as non-comparable', () => {
  const lines = summarizeCompareResult([
    { name: 'a', ok: true, datasource: { type: 'prometheus', uid: 'x' }, series: [{ kind: 'range', label: '{a}', trend: 'flat' }] },
    { name: 'b', ok: true, datasource: { type: 'prometheus', uid: 'y' }, series: [{ kind: 'range', label: '{a}', first: 1, last: 2, min: 1, max: 2, avg: 1.5, trend: 'flat' }] },
  ], rangeOpt())
  const out = lines.join('\n')
  assert.doesNotMatch(out, /first    last/)
  assert.match(out, /Comparison summary omitted/)
  assert.equal(out.includes('NaN'), false)
})
