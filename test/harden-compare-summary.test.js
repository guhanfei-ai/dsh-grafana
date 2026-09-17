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
