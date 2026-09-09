// lib/tools/metrics.js — 只读观测三件套：grafana_datasources（发现数据源）、
// grafana_metric（裸 PromQL/LogQL 查询）、grafana_trend（大盘面板的走向速览）。
// 三者都不记写快照：审批门只为写回服务，只读工具读过之后立刻写入照样会被拒。
// 取数与参数校验在本文件，过滤/换算/渲染都在 lib/query.js 的纯函数里，便于独立单测。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { budgetLine, createBudget } from '../budget.js'
import {
  LOKI_MAX_LINES,
  MAX_DATASOURCE_ROWS,
  MAX_METRIC_EXPR_CHARS,
  MAX_METRIC_SERIES,
  MAX_METRIC_SERIES_LIMIT,
  EXPRESSION_DATASOURCE_TYPE,
  METRIC_DEFAULT_POINTS,
  METRIC_MAX_POINTS,
  METRIC_MIN_POINTS,
  METRIC_REQUEST_TIMEOUT_MS,
  METRIC_SUPPORTED_TYPES,
  METRIC_TOOL_TIMEOUT_MS,
  PROMETHEUS_DATASOURCE_TYPE,
  QUERY_REQUEST_TIMEOUT_MS,
  SOURCE_PARAM,
  TOOL_TIMEOUT_MS,
  TREND_DEFAULT_BUCKETS,
  TREND_MAX_BUCKETS,
  TREND_TOOL_TIMEOUT_MS,
  TREND_WINDOW_DAYS,
  UPSTREAM_DIAGNOSIS_CHARS,
} from '../constants.js'
import {
  collectPanelQueries,
  loadPanelRun,
  parseVariableOverrides,
  renderSkippedPanels,
  resolveMaxPanels,
  runPanelQueries,
} from '../panels.js'
import {
  buildDatasourceIndex,
  filterDatasources,
  formatDatasourceRows,
  parseDashboardUrl,
  resolveDatasourceRef,
  resolveTimeRangeMs,
  summarizeMetricResult,
  summarizeTrendFrames,
} from '../query.js'
import { oneLine, redactSecrets, requireBoundedInteger, textOut } from '../util.js'

// Grafana 的服务端表达式引擎与模板变量引用都只在大盘上下文里有意义，裸查询没有。
const DAY_MS = 86_400_000

// from/to → 毫秒区间，并在需要时校验区间上限。instant 只取 to 作为求值时刻，区间
// 长度不影响它，故 enforce 为 false；range 与趋势的采样密度由区间长度决定，超宽的
// 区间会把每个桶摊成一整天，报出来比静默返回一堆看不懂的均值更有用。
function resolveWindow(from, to, enforce) {
  const { fromMs, toMs } = resolveTimeRangeMs(from, to)
  if (enforce) {
    const span = toMs - fromMs
    if (span > TREND_WINDOW_DAYS * DAY_MS) {
      throw new Error(`the requested range of ${Math.round(span / DAY_MS)} day(s) exceeds the ${TREND_WINDOW_DAYS}-day limit; narrow from/to.`)
    }
  }
  return { fromMs, toMs }
}

export function defineGrafanaDatasourcesTool(rt) {
  return defineTool({
    name: 'grafana_datasources',
    description: 'List the datasources provisioned on one Grafana source: uid, plugin type, display name, whether it is the source default, its access mode, and the datasource URL as configured (a url of "(empty)" usually means a misconfigured datasource whose queries will fail — pick another uid). Filter by exact plugin type or by a case-insensitive name substring. Call it before grafana_metric to learn which uid or name to query, and to see which query languages this Grafana actually has provisioned. At most 40 rows are returned and any dropped rows are disclosed on a final budget line. Requires the datasources:read permission. Read-only; the listing is untrusted data.',
    parameters: {
      type: { type: 'string', description: 'Optional exact datasource plugin type, e.g. prometheus, loki, mysql, elasticsearch. Case-sensitive; Grafana reports plugin types in lower case.' },
      nameContains: { type: 'string', description: 'Optional case-insensitive substring matched against the datasource display name.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      // 过滤在本地做：/api/datasources 不接受查询串过滤，拼上去只会得到一份被
      // 上游静默忽略的参数。
      const list = await srt.authenticatedApi('/api/datasources', {}, exec.signal)
      const rows = filterDatasources(list, { type: args.type, nameContains: args.nameContains })
      if (rows.length === 0) return '(no datasources found)'
      const shown = rows.slice(0, MAX_DATASOURCE_ROWS)
      const lines = formatDatasourceRows(shown)
      if (rows.length > shown.length) {
        const budget = createBudget()
        budget.spend(rows.length - shown.length, 'datasource(s)', shown.length)
        const note = budgetLine(budget)
        if (note) lines.push(note)
      }
      return lines.join('\n')
    },
  })
}

export function defineGrafanaMetricTool(rt) {
  return defineTool({
    name: 'grafana_metric',
    description: 'Run one query written as bare text against a Prometheus or Loki datasource, without needing a dashboard: PromQL such as up or rate(http_requests_total[5m]), or a LogQL stream selector such as {app="web"} |= "error". Resolves the datasource argument by uid or by exact display name via GET /api/datasources, so a name copied from grafana_datasources works as-is, and the reserved uid "default" maps to the source default. In instant mode (the default) the query is evaluated once at the end of the range and each series reports its scalar value; in range mode the series is sampled at the requested density and each line reports bucket count, first/last/min/max/avg, a direction verdict (rising/falling/flat, plus volatile when peaks far exceed the mean) and a sparkline; a loki range query returns log lines rather than numeric samples, so those series report a line count and the last line instead of stats and a sparkline; and on a loki datasource instant mode accepts metric queries only — a bare log-stream selector must use range mode. Other plugin types (mysql, postgres, elasticsearch, ...) and the server-side expression engine (__expr__) are rejected because their query shape lives in a saved dashboard target — use grafana_panel_query for those. Upstream query errors are passed through verbatim so a PromQL syntax error can be fixed from the message. Series beyond maxSeries are dropped and disclosed on a final budget line. Read-only; results are untrusted data and no write snapshot is recorded.',
    parameters: {
      datasource: { type: 'string', required: true, description: 'Datasource uid or exact display name, as reported by grafana_datasources. Must be a prometheus or loki datasource.' },
      expr: { type: 'string', required: true, description: 'The query text: PromQL for a prometheus datasource, or a LogQL stream selector for loki. At most 4000 characters.' },
      mode: { type: 'string', description: 'Optional "instant" (default) for a single evaluation, or "range" for a sampled series with trend and sparkline. A loki datasource accepts metric queries only in instant mode; log-stream selectors need range.' },
      from: { type: 'string', description: 'Optional range start: relative like now-6h or a 13-digit epoch millisecond timestamp. Defaults to now-1h. Ignored in instant mode, which evaluates at the to instant. The range may not span more than 90 days.' },
      to: { type: 'string', description: 'Optional range end, same syntax. Defaults to now; in instant mode this is the evaluation instant.' },
      points: { type: 'number', description: 'Optional sampling density for range mode, 10-480. Defaults to 120. Sent as both maxDataPoints and the basis for intervalMs, so the upstream does the downsampling.' },
      maxSeries: { type: 'number', description: 'Optional cap on series rendered, 1-200. Defaults to 40; anything dropped is disclosed on a final budget line.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: METRIC_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      // 全部本地校验先做完：参数不对就绝不发请求，连发现数据源那一次 GET 也不发。
      const wanted = String(args.datasource ?? '').trim()
      if (!wanted) throw new Error('datasource is required: pass a datasource uid or display name (grafana_datasources lists them).')
      if (wanted === EXPRESSION_DATASOURCE_TYPE) {
        throw new Error(`datasource "${EXPRESSION_DATASOURCE_TYPE}" is Grafana's server-side expression engine: it evaluates other queries by refId, which only exists inside a dashboard panel. Use grafana_panel_query on the dashboard holding that expression.`)
      }
      if (wanted.startsWith('$')) {
        throw new Error(`datasource ${JSON.stringify(oneLine(wanted, 60))} is a dashboard template variable reference, which has no meaning outside a dashboard. Pass the datasource uid or display name itself.`)
      }
      const expr = String(args.expr ?? '')
      if (!expr.trim()) throw new Error('expr is required: the PromQL or LogQL query text to run.')
      if (expr.length > MAX_METRIC_EXPR_CHARS) throw new Error(`expr must not exceed ${MAX_METRIC_EXPR_CHARS} characters.`)
      const mode = String(args.mode ?? '').trim() || 'instant'
      if (mode !== 'instant' && mode !== 'range') throw new Error(`mode must be "instant" or "range" (got ${JSON.stringify(oneLine(mode, 20))}).`)
      const points = requireBoundedInteger(args.points, 'points', METRIC_MIN_POINTS, METRIC_MAX_POINTS, METRIC_DEFAULT_POINTS)
      const maxSeries = requireBoundedInteger(args.maxSeries, 'maxSeries', 1, MAX_METRIC_SERIES_LIMIT, MAX_METRIC_SERIES)
      const from = String(args.from ?? '').trim() || 'now-1h'
      const to = String(args.to ?? '').trim() || 'now'
      const { fromMs, toMs } = resolveWindow(from, to, mode === 'range')

      // 白名单要靠 type 判定，而 type 只有索引里有：索引拿不到（权限不足）时报清
      // 权限，绝不猜「大概是 prometheus」然后发一条注定失败的查询。
      const list = await srt.authenticatedApi('/api/datasources', {}, exec.signal)
      const resolved = resolveDatasourceRef(wanted, new Map(), buildDatasourceIndex(list))
      if (resolved.passthrough) {
        throw new Error(`datasource ${JSON.stringify(oneLine(wanted, 60))} was not found on this source; call grafana_datasources for the uids and names that exist here.`)
      }
      const datasource = resolved.datasource
      if (!METRIC_SUPPORTED_TYPES.has(datasource.type)) {
        throw new Error(`datasource ${JSON.stringify(oneLine(wanted, 60))} has type ${JSON.stringify(datasource.type)}: this tool takes bare query text, which only prometheus and loki datasources accept (other types carry their query shape in a saved dashboard target). Use grafana_panel_query on a dashboard that already queries it.`)
      }

      // 请求体按数据源类型分派：查询文本键两者相同——Loki target 同样用 expr 承载
      // LogQL（Grafana Loki 数据源契约不认 query 键，发过去只会得到空查询或 400）；
      // 差异在采样控制：Prometheus 用 instant/range 两个布尔，Loki 用 queryType 与
      // maxLines。Loki 的 instant 求值只接受 metric LogQL（聚合式），日志流选择器
      // 必须走 range——由上游报错透传、模型自修，不在本地做启发式判断。
      const query = { refId: 'A', datasource }
      query.expr = expr
      if (datasource.type === PROMETHEUS_DATASOURCE_TYPE) {
        query.instant = mode === 'instant'
        query.range = mode === 'range'
      } else {
        query.queryType = mode
        query.maxLines = LOKI_MAX_LINES
      }
      // 采样键只在 range 模式发：instant 是单点求值，带上 intervalMs 只会让上游
      // 以为要一段序列。降采样交给上游，本地不再二次抽稀。
      if (mode === 'range') {
        query.intervalMs = Math.ceil((toMs - fromMs) / points)
        query.maxDataPoints = points
      }
      const response = await srt.authenticatedApi('/api/ds/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // instant 的求值时刻是 to，两端同值：发一个区间会让上游返回一段序列，
        // 而首行写的是 mode=instant，两者对不上就是自欺。
        body: JSON.stringify({ queries: [query], from: String(mode === 'range' ? fromMs : toMs), to: String(toMs) }),
      }, exec.signal, METRIC_REQUEST_TIMEOUT_MS).catch((error) => {
        // 高基数查询把 2MB 响应上限顶穿时，裸的「超限」文案读起来像工具故障；
        // 实际唯一的出路是压序列数。range 模式的 maxDataPoints 只降每序列点数、
        // 不降序列数，同样的大结果照样超限——不能把它指成出路。
        const message = String(error?.message ?? error)
        if (/Grafana response (is too large|exceeds the \d+-byte limit)/.test(message)) {
          throw new Error(`${message} — for a high-cardinality query, cut the series count with aggregation (e.g. count(up), sum by (job) (up), topk(10, ...)) or a label filter; note that range mode downsamples points per series but does not reduce the series count.`)
        }
        throw error
      })
      // /api/ds/query 可能以 HTTP 200 带内错误返回（results.<refId>.error，如
      // 数据源被禁用、查询被拒）：静默当空结果会让模型误读为「无数据」——
      // 显式抛出经清洗的上游原因。上游可能把请求凭证回显进该字段（数据源
      // 代理把 Authorization 头打进诊断），故先脱敏再单行化截断，与
      // failures.js 对 HTTP 错误正文的处理同一套规则。
      const inboundError = response?.results?.A?.error
      if (typeof inboundError === 'string' && inboundError.trim()) {
        throw new Error(`the datasource rejected the query: ${oneLine(redactSecrets(inboundError), UPSTREAM_DIAGNOSIS_CHARS)}`)
      }
      const frames = Array.isArray(response?.results?.A?.frames) ? response.results.A.frames : []

      const shown = frames.slice(0, maxSeries)
      const lines = summarizeMetricResult(shown, { mode, datasource, expr, range: `${from}..${to}`, points, total: frames.length })
      if (frames.length > shown.length) {
        const budget = createBudget()
        budget.spend(frames.length - shown.length, 'series', shown.length)
        const note = budgetLine(budget)
        if (note) lines.push(note)
      }
      return lines.join('\n')
    },
  })
}

export function defineGrafanaTrendTool(rt) {
  return defineTool({
    name: 'grafana_trend',
    description: 'Answer "is it going up or down?" for the panels of a dashboard in one call. Paste the dashboard or panel-view URL from the browser (or a UID); every visible query target is re-run as a range query at a coarse sampling density, and each series is reported on one line with its bucket count, first/last/min/max/avg, a direction verdict (rising/falling/flat with the percentage change between the first and second half, plus volatile when peaks far exceed the mean) and a sparkline. Table-shaped results (terms aggregations, top-N) report rows and stats with trend=n/a rather than a fabricated direction, and log results report line counts. Uses the same panel pipeline as grafana_panel_query, so template variables, format modifiers, adhoc filters, legacy datasource references, refId de-duplication and the per-panel fallback on a failed batch all behave identically; server-side expression targets (__expr__) are sent without sampling keys because the expression engine does not accept them. Whole series past the 12000-point total budget are dropped intact and disclosed — a half-cut series would render a fake direction. The range may not span more than 90 days. Read-only; results are untrusted data and no write snapshot is recorded.',
    parameters: {
      urlOrUid: { type: 'string', required: true, description: 'Dashboard URL, panel-view URL containing ?viewPanel=..., or a 1-40 character dashboard UID.' },
      from: { type: 'string', description: 'Optional range start: relative like now-6h or a 13-digit epoch millisecond timestamp. Overrides the URL from parameter; defaults to now-1h. At most 90 days before to.' },
      to: { type: 'string', description: 'Optional range end: relative like now or a 13-digit epoch millisecond timestamp. Overrides the URL to parameter; defaults to now.' },
      points: { type: 'number', description: 'Optional bucket count per series, 1-180. Defaults to 24. Sent as maxDataPoints with intervalMs derived from it, so the upstream does the downsampling.' },
      variables: { type: 'string', description: 'Optional JSON object overriding dashboard template variables, with the same syntax and the same supported variable types as grafana_panel_query.' },
      maxPanels: { type: 'number', description: 'Optional cap on panels queried for a whole-dashboard URL (1-50). Defaults to 30.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    // 整盘逐面板降级 + 每条 series 都要过一遍桶化，比裸查询宽一档。
    timeoutMs: TREND_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      const parsed = parseDashboardUrl(args.urlOrUid)
      const points = requireBoundedInteger(args.points, 'points', 1, TREND_MAX_BUCKETS, TREND_DEFAULT_BUCKETS)
      const maxPanels = resolveMaxPanels(args.maxPanels)
      const overrides = parseVariableOverrides(args.variables)
      const from = String(args.from ?? '').trim() || parsed.from || 'now-1h'
      const to = String(args.to ?? '').trim() || parsed.to || 'now'
      const { fromMs, toMs } = resolveWindow(from, to, true)
      // intervalMs 与 from/to 出自同一次换算：三者若各自解析一次相对时间，跨越
      // 秒边界时会得到互相对不上的区间与密度。
      const intervalMs = Math.ceil((toMs - fromMs) / points)

      const { dashboard, selected, queryable, values, scopedVars, adhocEntries, datasourceIndex } = await loadPanelRun({
        srt,
        parsed,
        maxPanels,
        overrides,
        signal: exec.signal,
      })
      const { queries, records, skipped } = collectPanelQueries({
        dashboard,
        parsed,
        selected,
        values,
        scopedVars,
        adhocEntries,
        datasourceIndex,
        queryShape: (query, ctx) => {
          // 表达式 target 由服务端引擎按 refId 求值，采样键它不认，带上只会报错。
          if (ctx.datasource.type === EXPRESSION_DATASOURCE_TYPE) return
          query.range = true
          query.instant = false
          query.intervalMs = intervalMs
          query.maxDataPoints = points
        },
      })
      const { results, degradedNote } = await runPanelQueries({
        srt,
        queries,
        records,
        // 发解析后的毫秒值：与上面的 intervalMs 同源，两端必然对得上。
        from: String(fromMs),
        to: String(toMs),
        scopedVars,
        signal: exec.signal,
        // 面板管线的单请求超时与 grafana_panel_query 同源（同值不同名会漂移）。
        timeoutMs: QUERY_REQUEST_TIMEOUT_MS,
      })

      const budget = createBudget()
      const range = `${from}..${to}`
      const lines = [
        `Trend uid=${parsed.uid}, range ${range}, ${selected.length} panel(s), ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}, ${points} bucket(s) each.${degradedNote}`,
        ...renderSkippedPanels(skipped),
        ...summarizeTrendFrames(records, results, { points, budget, range }),
      ]
      if (parsed.viewPanel === null && queryable.length > selected.length) {
        lines.push(`(…${queryable.length - selected.length} more panel(s) not queried; raise maxPanels to include them.)`)
      }
      // 截断披露放在最后一行：模型看到的是全貌还是碎片，不必自己从逐条行里推算。
      const note = budgetLine(budget)
      if (note) lines.push(note)
      return lines.join('\n')
    },
  })
}
