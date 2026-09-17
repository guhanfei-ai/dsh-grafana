// lib/tools/compare.js — grafana_compare：在多台已配置 Grafana 源站上并发执行同一
// 指标查询，按源站独立捕获错误并渲染成紧凑的横向比较。
//
// 与 grafana_metric 共享 runBareMetricQuery 原语（见 lib/tools/metrics.js）：
// grafana_compare 对每台源站独立调一次，把「并发 + partial failure + bounded 输出」
// 这层放本文件内，datasource 解析与白名单校验不重写一遍。
//
// 安全边界：
//   - 显式只读：不记写快照，不进审批门；
//   - sources 上限 10 / 下限 2：少则无比较意义，多则并发墙钟不可控；
//   - 每源站 series 上限 5：横向比较关心的是「整体值」，常配合 sum / avg / histogram_quantile
//     这类聚合查询自然收敛到单 series，截断既防输出爆炸又提示加聚合；
//   - 任一源站失败不影响其它源站的成功结果，按既有错误翻译（401/403/超时/inbound-error）
//     一律脱敏截断。
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  COMPARE_TOOL_TIMEOUT_MS,
  MAX_COMPARE_SERIES_PER_SOURCE,
  MAX_COMPARE_SOURCES,
  MAX_METRIC_EXPR_CHARS,
  MIN_COMPARE_SOURCES,
  METRIC_DEFAULT_POINTS,
  METRIC_MAX_POINTS,
  METRIC_MIN_POINTS,
  METRIC_REQUEST_TIMEOUT_MS,
  TREND_WINDOW_DAYS,
} from '../constants.js'
import {
  resolveTimeRangeMs,
  summarizeCompareResult,
  summarizeCompareSeries,
} from '../query.js'
import { oneLine, redactSecrets, requireBoundedInteger, textOut } from '../util.js'
import { runBareMetricQuery } from './metrics.js'

// Grafana 服务端表达式引擎与模板变量引用都只在大盘上下文里有意义，裸查询没有。
const DAY_MS = 86_400_000

// from/to → 毫秒区间，并在需要时校验区间上限。语义与 grafana_metric 同源：instant
// 只取 to 作为求值时刻，range 校验 90 天上限并拒绝反向区间。
function resolveCompareWindow(from, to, enforce) {
  if (enforce) {
    const { fromMs, toMs } = resolveTimeRangeMs(from, to)
    const span = toMs - fromMs
    if (span > TREND_WINDOW_DAYS * DAY_MS) {
      throw new Error(`the requested range of ${Math.round(span / DAY_MS)} day(s) exceeds the ${TREND_WINDOW_DAYS}-day limit; narrow from/to.`)
    }
    return { fromMs, toMs }
  }
  const { toMs } = resolveTimeRangeMs(to, to)
  return { fromMs: toMs, toMs }
}

// 一行格式校验的标准化：把上游错误压成单行并脱敏。复用 redactSecrets 与 oneLine，
// 与 failures.js / runBareMetricQuery 对 HTTP 与 inbound 错误体的处理同一套规则。
function sanitizeErrorMessage(error) {
  const message = String(error?.message ?? error ?? 'unknown failure')
  return oneLine(redactSecrets(message), 240) || 'unknown failure'
}

// 在 execute 内部使用：跑一台源站、捕获错误，把结果整理成 summarizeCompareResult
// 期望的形状。AbortSignal 通过 srt.authenticatedApi 沿链路传播——宿主取消时这条
// promise 立即被 abort，其它源站并发跑完的不受影响。
async function runOneSource({ rt, sourceName, datasource, query, mode, fromMs, toMs, points, signal }) {
  let srt
  try {
    srt = rt.forSource(rt.resolveSource(sourceName))
  } catch (error) {
    return { name: sourceName, ok: false, error: sanitizeErrorMessage(error) }
  }
  try {
    const { datasource: resolved, response } = await runBareMetricQuery({
      srt,
      datasource,
      expr: query,
      mode,
      fromMs,
      toMs,
      points,
      signal,
      requestTimeoutMs: METRIC_REQUEST_TIMEOUT_MS,
    })
    const frames = Array.isArray(response?.results?.A?.frames) ? response.results.A.frames : []
    // 按 maxSeries 上限收集所有 frame 的 series。多 frame 通常意味着同一查询被
    // 服务端分组（如 panel_query 的多 refId），compare 的单一 refId 场景下一般只
    // 有 1 个 frame；多 frame 也按顺序铺平处理。
    const series = []
    let hidden = 0
    for (const frame of frames) {
      const frameSeries = summarizeCompareSeries(frame, { mode, points, fromMs, toMs })
      // 已经打满上限时后面的 frame 只计数：hidden 必须是被丢掉的真实条数，
      // 不能因为提前跳出而少报（少报就是静默截断）。
      if (series.length >= MAX_COMPARE_SERIES_PER_SOURCE) {
        hidden += frameSeries.length
        continue
      }
      for (const s of frameSeries) {
        if (series.length >= MAX_COMPARE_SERIES_PER_SOURCE) { hidden += 1; continue }
        series.push(s)
      }
    }
    return {
      name: sourceName,
      ok: true,
      datasource: resolved,
      series,
      hidden,
      noData: frames.length === 0 || series.length === 0,
    }
  } catch (error) {
    return { name: sourceName, ok: false, error: sanitizeErrorMessage(error) }
  }
}

export function defineGrafanaCompareTool(rt) {
  return defineTool({
    name: 'grafana_compare',
    description: 'Run the same Prometheus query against the corresponding datasource on multiple configured Grafana sources and return a compact side-by-side comparison. Pass an array of source names (call grafana_sources to list configured sources) and a single datasource — by exact display name when you want grafana_compare to resolve it on each source independently, or by uid when every source is expected to share one (UIDs are still resolved per source so a name is safer when sources disagree). The query runs concurrently across sources in instant (default) or range mode; each source is treated independently — a timeout or 4xx on one does not drop the others, but every error is sanitized and bounded (no credentials, no upstream URL paths leaked into the tool output). When all requested sources return a single numeric value, the output ends with a small numeric summary (highest/lowest/average/max-min ratio); if any source fails, returns no data, or returns multiple series, the summary is omitted and each source is listed with its per-source breakdown instead, so a partial or high-cardinality result cannot be misread as a direct scalar comparison. Read-only; records no write snapshot and triggers no approval.',
    parameters: {
      sources: { type: 'array', required: true, description: 'Array of configured Grafana source names, 2 to 10 entries. Call grafana_sources to list valid names. Each name is resolved independently; duplicates are rejected so the same source is never queried twice.' },
      datasource: { type: 'string', required: true, description: 'Datasource reference resolved per source: pass an exact display name (recommended, so Grafana instances with different UIDs for the same logical datasource still line up) or a uid (also resolved per source; a uid that exists on one source but not another is reported as an error on the missing side).' },
      query: { type: 'string', required: true, description: 'The query text: PromQL only in v1 (e.g. up, rate(http_requests_total[5m]), histogram_quantile(...)). At most 4000 characters.' },
      mode: { type: 'string', description: 'Optional "instant" (default) for a single evaluation at the range end, or "range" for a sampled series with first/last/min/max/avg/trend stats per source.' },
      from: { type: 'string', description: 'Optional range start: relative like now-15m or a 13-digit epoch millisecond timestamp. Defaults to now-15m. Ignored in instant mode, which evaluates at the to instant. The range may not span more than 90 days.' },
      to: { type: 'string', description: 'Optional range end, same syntax. Defaults to now; in instant mode this is the evaluation instant.' },
      points: { type: 'number', description: 'Optional sampling density for range mode, 10-480. Defaults to 120. Sent as both maxDataPoints and the basis for intervalMs, so the upstream does the downsampling.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: COMPARE_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Compare metric ${oneLine(String(args?.query ?? ''), 60)}`, kind: 'read' }),
    async execute(args, exec) {
      // 全部本地校验先做完：参数不对就绝不发请求；sources 中任一名称无法解析也
      // 早失败，不让部分请求落地。
      if (!Array.isArray(args.sources)) throw new Error('sources must be an array of configured Grafana source names.')
      const raw = args.sources
      if (raw.length < MIN_COMPARE_SOURCES) throw new Error(`sources must contain at least ${MIN_COMPARE_SOURCES} entries (got ${raw.length}).`)
      if (raw.length > MAX_COMPARE_SOURCES) throw new Error(`sources must not exceed ${MAX_COMPARE_SOURCES} entries (got ${raw.length}).`)
      const seen = new Set()
      const unique = []
      for (const entry of raw) {
        if (typeof entry !== 'string') throw new Error(`sources entries must be strings (got ${typeof entry}).`)
        const name = entry.trim()
        if (!name) throw new Error('sources entries must be non-empty strings.')
        if (seen.has(name)) throw new Error(`duplicate source ${JSON.stringify(name)} in sources; pass each configured source at most once.`)
        seen.add(name)
        unique.push(name)
      }
      const datasource = String(args.datasource ?? '').trim()
      if (!datasource) throw new Error('datasource is required: pass the datasource display name (grafana_datasources lists them) so each source can resolve it independently.')
      const query = String(args.query ?? '')
      if (!query.trim()) throw new Error('query is required: the PromQL query text to run on each source.')
      if (query.length > MAX_METRIC_EXPR_CHARS) throw new Error(`query must not exceed ${MAX_METRIC_EXPR_CHARS} characters.`)
      const mode = String(args.mode ?? '').trim() || 'instant'
      if (mode !== 'instant' && mode !== 'range') throw new Error(`mode must be "instant" or "range" (got ${JSON.stringify(oneLine(mode, 20))}).`)
      const points = requireBoundedInteger(args.points, 'points', METRIC_MIN_POINTS, METRIC_MAX_POINTS, METRIC_DEFAULT_POINTS)
      const from = String(args.from ?? '').trim() || 'now-15m'
      const to = String(args.to ?? '').trim() || 'now'
      const { fromMs, toMs } = resolveCompareWindow(from, to, mode === 'range')

      // 预先解析所有 source 名称：任一不存在就早失败，避免一组并行请求里一半
      // 已经落地、另一半才报「unknown source」。返回值不用——runOneSource 内部
      // 会再解析一次取 srt，这里只做 fail-fast 的副作用检查。
      for (const name of unique) {
        try { rt.resolveSource(name) }
        catch (error) { throw new Error(error?.message ?? String(error)) }
      }

      // 并发跑所有 source：每条 promise 独立捕获错误并返回结构化结果。
      // exec.signal 沿 srt.authenticatedApi 传递——宿主取消时各请求被 abort，
      // Promise.all 立即 reject，外层 try/catch 把整个工具降级为「全部失败」
      // （partial 路径走不了，因为 cancel 是全局的）。
      const results = await Promise.all(unique.map((name) => runOneSource({
        rt,
        sourceName: name,
        datasource,
        query,
        mode,
        fromMs,
        toMs,
        points,
        signal: exec.signal,
      }).catch((error) => ({ name, ok: false, error: sanitizeErrorMessage(error) }))))

      // 工具级 abort（exec.signal 已 aborted）：按用户取消处理，不输出部分结果——
      // 调用方既然要求停止，就必须收到取消失败，而不是一份看起来完整的部分结果。
      if (exec.signal?.aborted) {
        throw new Error('Grafana compare cancelled before all sources completed.')
      }

      const stepMs = mode === 'range' ? Math.ceil((toMs - fromMs) / points) : null
      return summarizeCompareResult(results, {
        mode,
        query,
        range: `${from}..${to}`,
        points,
        totalSources: unique.length,
        datasourceWanted: datasource,
        stepMs,
      }).join('\n')
    },
  })
}