// Correctness hardening — Bug B: trend / range stats must respect the requested
// time window. 复现并锁定：窗口外数据点既不能被 clamp 进首尾桶，也不能参与
// first/last/min/max/avg 的计算。先形成 {time, value} 对，按窗口过滤，再对过滤
// 后的数据计算所有统计量与分桶。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bucketizeSeries,
  summarizeCompareSeries,
  summarizeMetricResult,
  summarizeTrendFrames,
} from '../lib/query.js'

function timeFrame(values, times) {
  return {
    schema: { fields: [{ name: 'time', type: 'time' }, { name: 'Value', type: 'number', labels: { host: 'a' } }] },
    data: { values: [times, values] },
  }
}

// B1 — 窗口前点不得被 clamp 进第一个桶。
test('B1 pre-window point is excluded from buckets (no clamp into first bucket)', () => {
  const times = [-1000, 375, 1125, 1875]
  const values = [500, 100, 200, 300]
  assert.deepEqual(bucketizeSeries(values, 4, times, 0, 3000), [100, 200, 300, null])
})

// B2 — 窗口后点同样不得被 clamp 进最后一个桶。
test('B2 post-window point is excluded from buckets', () => {
  const times = [375, 1125, 1875, 4000]
  const values = [100, 200, 300, 9999]
  assert.deepEqual(bucketizeSeries(values, 4, times, 0, 3000), [100, 200, 300, null])
})

// B3 — 精确落在 from 边界的点应被包含（边界包含 [from, to]）。
test('B3 exact from-boundary point is included in the first bucket', () => {
  assert.deepEqual(bucketizeSeries([100], 4, [0], 0, 3000), [100, null, null, null])
})

// B4 — 精确落在 to 边界的点应被包含（半开区间的对称边界）。
test('B4 exact to-boundary point is included in the last bucket', () => {
  assert.deepEqual(bucketizeSeries([100], 4, [3000], 0, 3000), [null, null, null, 100])
})

// B5 — 窗口内完全没有点：返回全空桶，而非把窗外点 clamp 进来。
test('B5 only outside points → all buckets empty (no clamp)', () => {
  assert.deepEqual(bucketizeSeries([9999], 4, [-500], 0, 3000), [null, null, null, null])
})

// B6 — summarizeCompareSeries 的 range 统计只用窗口内值。
test('B6 windowed stats ignore outside points (first/last/min/max/avg)', () => {
  const times = [1000, 1500, 2000, -500, 4000]
  const values = [100, 200, 300, 9999, 500]
  const s = summarizeCompareSeries(timeFrame(values, times), { mode: 'range', points: 4, fromMs: 0, toMs: 3000 })[0]
  assert.equal(s.first, 100)
  assert.equal(s.last, 300)
  assert.equal(s.min, 100)
  assert.equal(s.max, 300)
  assert.equal(s.avg, 200)
})

// B7 — summarizeMetricResult range 统计只用窗口内值。
test('B7 summarizeMetricResult range stats use only in-window values', () => {
  const times = [1000, 1500, 2000, -500, 4000]
  const values = [100, 200, 300, 9999, 500]
  const line = summarizeMetricResult([timeFrame(values, times)], {
    mode: 'range',
    datasource: { type: 'prometheus', uid: 'p' },
    expr: 'up',
    range: 'now-1h..now',
    points: 4,
    fromMs: 0,
    toMs: 3000,
    stepMs: 750,
  })[1]
  assert.match(line, /first=100 /)
  assert.match(line, /last=300 /)
  assert.match(line, /min=100 /)
  assert.match(line, /max=300 /)
  assert.match(line, /avg=200 /)
  assert.doesNotMatch(line, /9999/)
  assert.doesNotMatch(line, /500/)
})

// B8 — summarizeTrendFrames range 统计只用窗口内值。
test('B8 summarizeTrendFrames range stats use only in-window values', () => {
  const records = [{ panel: { id: 7, title: 'RPM' }, refId: 'A', originalRefId: 'A' }]
  const results = { A: { frames: [timeFrame([100, 200, 300, 9999, 500], [1000, 1500, 2000, -500, 4000])] } }
  const line = summarizeTrendFrames(records, results, { points: 4, range: 'now-1h..now', fromMs: 0, toMs: 3000 })[0]
  assert.match(line, /first=100 /)
  assert.match(line, /last=300 /)
  assert.match(line, /min=100 /)
  assert.match(line, /max=300 /)
  assert.match(line, /avg=200 /)
  assert.doesNotMatch(line, /9999/)
  assert.doesNotMatch(line, /500/)
})
