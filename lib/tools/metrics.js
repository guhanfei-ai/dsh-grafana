// lib/tools/metrics.js — 只读观测三件套：grafana_datasources（发现数据源）、
// grafana_metric（裸 PromQL/LogQL 查询）、grafana_trend（大盘面板的走向速览）。
// 三者都不记写快照：审批门只为写回服务，只读工具读过之后立刻写入照样会被拒。
// 取数与参数校验在本文件，过滤/换算/渲染都在 lib/query.js 的纯函数里，便于独立单测。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { budgetLine, createBudget, paginate } from '../budget.js'
import {
  LOKI_MAX_LINES,
  LOKI_DATASOURCE_TYPE,
  MAX_DATASOURCE_ROWS,
  MAX_METRIC_EXPR_CHARS,
  MAX_METRIC_SERIES,
  MAX_METRIC_SERIES_LIMIT,
  MAX_PAGE,
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
  mergeVariableOverrides,
  parseDashboardUrl,
  requirePositiveRangeSpan,
  resolveDatasourceRef,
  resolveTimeRangeMs,
  summarizeMetricResult,
  summarizeTrendFrames,
} from '../query.js'
import { oneLine, redactSecrets, requireBoundedInteger, textOut } from '../util.js'

// Grafana 的服务端表达式引擎与模板变量引用都只在大盘上下文里有意义，裸查询没有。
const DAY_MS = 86_400_000

// from/to → 毫秒区间，并在需要时校验区间上限。instant 只取 to 作为求值时刻，区间
// 长度不影响它，故 enforce 为 false——此时不检查 from/to 顺序：默认 from=now-1h 不得
// 提前拒绝 to=now-24h（昨天同一时刻的求值）。range 与趋势的采样密度由区间长度决定，
// 零长度区间算不出步长（intervalMs=0），超宽区间会把每个桶摊成一整天，两者都报出来
// 比静默返回一堆看不懂的均值更有用。
function resolveWindow(from, to, enforce) {
  if (enforce) {
    const { fromMs, toMs } = requirePositiveRangeSpan(resolveTimeRangeMs(from, to))
    const span = toMs - fromMs
    if (span > TREND_WINDOW_DAYS * DAY_MS) {
      throw new Error(`the requested range of ${Math.round(span / DAY_MS)} day(s) exceeds the ${TREND_WINDOW_DAYS}-day limit; narrow from/to.`)
    }
    return { fromMs, toMs }
  }
  // instant 模式只解析 to：from 不参与查询（请求体里 from === toMs），
  // 默认 from=now-1h 与用户传入的 to=now-24h 构成的反向区间不应被拒绝。
  const { toMs } = resolveTimeRangeMs(to, to)
  return { fromMs: toMs, toMs }
}

export function defineGrafanaDatasourcesTool(rt) {
  return defineTool({
    name: 'grafana_datasources',
    description: 'List the datasources provisioned on one Grafana source: uid, plugin type, display name, whether it is the source default, its access mode, and the datasource URL as configured (a url of "(empty)" usually means a misconfigured datasource whose queries will fail — pick another uid). Filter by exact plugin type or by a case-insensitive name substring. Call it before grafana_metric to learn which uid or name to query, and to see which query languages this Grafana actually has provisioned. Results are paged (default 40 rows per page); a final line reports the page, the total, and how to fetch the next page when more remain. Requires the datasources:read permission. Read-only; the listing is untrusted data.',
    parameters: {
      type: { type: 'string', description: 'Optional exact datasource plugin type, e.g. prometheus, loki, mysql, elasticsearch. Case-sensitive; Grafana reports plugin types in lower case.' },
      nameContains: { type: 'string', description: 'Optional case-insensitive substring matched against the datasource display name.' },
      limit: { type: 'number', description: 'Optional page size, 1-40. Defaults to 40.' },
      page: { type: 'number', description: 'Optional page number (1-based). Defaults to 1; the disclosure line on a full page tells you the next page number.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `List Grafana datasources${args?.source ? ` on ${oneLine(String(args.source), 40)}` : ''}`, kind: 'read' }),
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      const limit = requireBoundedInteger(args.limit, 'limit', 1, MAX_DATASOURCE_ROWS, MAX_DATASOURCE_ROWS)
      const page = requireBoundedInteger(args.page, 'page', 1, MAX_PAGE, 1)
      // 过滤在本地做：/api/datasources 不接受查询串过滤，拼上去只会得到一份被
      // 上游静默忽略的参数。
      const list = await srt.authenticatedApi('/api/datasources', {}, exec.signal)
      const rows = filterDatasources(list, { type: args.type, nameContains: args.nameContains })
      if (rows.length === 0) return '(no datasources found)'
      const sliced = paginate(rows, { page, limit, label: 'datasource(s)', pageParam: 'page' })
      const lines = formatDatasourceRows(sliced.shown)
      // 页码越过末页时没有数据行，披露行（no … on this page; N in total）就是全部答案。
      if (sliced.line) lines.push(sliced.line)
      return lines.join('\n')
    },
  })
}

// grafana_metric 与 grafana_compare 共用的最小查询原语：「数据源解析 + 白名单校验 +
// 请求体 + 发送 + 清洗」。两个工具都要求「同一 PromQL 在多台源站上得到一致行为」，
// 故把这段抽出来一次实现、一次回归：grafana_metric 整段调用；grafana_compare 并发
// 地调它来对每台源站跑同一查询，按源站独立捕获错误（partial failure）。
//
// 失败一律抛：401/403/404/400/inbound-error/超时/响应超限都按既有规则翻译，
// 调用方决定整体抛还是按源站收敛。返回值是「成功后拿到了 datasource、原始响应和
// 采样步长」，渲染由各工具自行负责。
export async function runBareMetricQuery({
  srt,
  datasource: wanted,
  expr,
  mode,
  fromMs,
  toMs,
  points,
  signal,
  requestTimeoutMs = METRIC_REQUEST_TIMEOUT_MS,
}) {
  // 1. 校验 datasource 引用形态：uid/名称/"default" 之外（模板变量、__expr__）拒收。
  const wantedText = String(wanted ?? '').trim()
  if (!wantedText) throw new Error('datasource is required: pass a datasource uid or display name (grafana_datasources lists them).')
  if (wantedText === EXPRESSION_DATASOURCE_TYPE) {
    throw new Error(`datasource "${EXPRESSION_DATASOURCE_TYPE}" is Grafana's server-side expression engine: it evaluates other queries by refId, which only exists inside a dashboard panel. Use grafana_panel_query on the dashboard holding that expression.`)
  }
  if (wantedText.startsWith('$')) {
    throw new Error(`datasource ${JSON.stringify(oneLine(wantedText, 60))} is a dashboard template variable reference, which has no meaning outside a dashboard. Pass the datasource uid or display name itself.`)
  }
  // 2. 解析数据源索引并按 type 做白名单校验。索引拿不到时（403）由 failures.js 翻译。
  const list = await srt.authenticatedApi('/api/datasources', {}, signal)
  const resolved = resolveDatasourceRef(wantedText, new Map(), buildDatasourceIndex(list))
  if (resolved.passthrough) {
    throw new Error(`datasource ${JSON.stringify(oneLine(wantedText, 60))} was not found on this source; call grafana_datasources for the uids and names that exist here.`)
  }
  const datasource = resolved.datasource
  if (!METRIC_SUPPORTED_TYPES.has(datasource.type)) {
    throw new Error(`datasource ${JSON.stringify(oneLine(wantedText, 60))} has type ${JSON.stringify(datasource.type)}: this tool takes bare query text, which only prometheus and loki datasources accept (other types carry their query shape in a saved dashboard target). Use grafana_panel_query on a dashboard that already queries it.`)
  }
  // 3. 请求体按数据源类型分派：Loki 用 queryType+maxLines，Prometheus 用 instant/range 布尔。
  const query = { refId: 'A', datasource }
  query.expr = expr
  if (datasource.type === PROMETHEUS_DATASOURCE_TYPE) {
    query.instant = mode === 'instant'
    query.range = mode === 'range'
  } else {
    query.queryType = mode
    query.maxLines = LOKI_MAX_LINES
  }
  // intervalMs 既发给上游，也作为 step 披露进摘要首行（D3）。
  const intervalMs = mode === 'range' ? Math.ceil((toMs - fromMs) / points) : null
  if (mode === 'range') {
    query.intervalMs = intervalMs
    query.maxDataPoints = points
  }
  // 4. 发送请求；响应超限时附上对高基数查询的可执行诊断（与原 metric 工具的同一句）。
  const response = await srt.authenticatedApi('/api/ds/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // instant 的求值时刻是 to，两端同值：发一个区间会让上游返回一段序列，
    // 而首行写的是 mode=instant，两者对不上就是自欺。
    body: JSON.stringify({ queries: [query], from: String(mode === 'range' ? fromMs : toMs), to: String(toMs) }),
  }, signal, requestTimeoutMs).catch((error) => {
    const message = String(error?.message ?? error)
    if (/Grafana response (is too large|exceeds the \d+-byte limit)/.test(message)) {
      throw new Error(`${message} — for a high-cardinality query, cut the series count with aggregation (e.g. count(up), sum by (job) (up), topk(10, ...)) or a label filter; note that range mode downsamples points per series but does not reduce the series count.`)
    }
    throw error
  })
  // 5. /api/ds/query 可能以 HTTP 200 + results.<refId>.error 返回。上游可能把请求
  // 凭证回显进该字段，故先脱敏再单行化截断。
  const inboundError = response?.results?.A?.error
  if (typeof inboundError === 'string' && inboundError.trim()) {
    throw new Error(`the datasource rejected the query: ${oneLine(redactSecrets(inboundError), UPSTREAM_DIAGNOSIS_CHARS)}`)
  }
  return { datasource, response, intervalMs }
}

export function defineGrafanaMetricTool(rt) {
  return defineTool({
    name: 'grafana_metric',
    description: 'Run one query written as bare text against a Prometheus or Loki datasource, without needing a dashboard: PromQL such as up or rate(http_requests_total[5m]), or a LogQL stream selector such as {app="web"} |= "error". Resolves the datasource argument by uid or by exact display name via GET /api/datasources, so a name copied from grafana_datasources works as-is, and the reserved uid "default" maps to the source default. In instant mode (the default) the query is evaluated once at the end of the range and each series reports its scalar value; in range mode the series is sampled at the requested density and each line reports bucket count, first/last/min/max/avg, a direction verdict (rising/falling/flat, plus volatile when peaks far exceed the mean) and a sparkline; a loki range query returns log lines rather than numeric samples, so those series report a line count and the last line instead of stats and a sparkline; and on a loki datasource instant mode accepts metric queries only — a bare log-stream selector must use range mode. Other plugin types (mysql, postgres, elasticsearch, ...) and the server-side expression engine (__expr__) are rejected because their query shape lives in a saved dashboard target — use grafana_panel_query for those. Upstream query errors are passed through verbatim so a PromQL syntax error can be fixed from the message. Series beyond maxSeries are dropped and disclosed on a final budget line. Read-only; results are untrusted data and no write snapshot is recorded.',
    parameters: {
      datasource: { type: 'string', required: true, description: 'Datasource uid or exact display name, as reported by grafana_datasources. Must be a prometheus or loki datasource.' },
      expr: { type: 'string', required: true, description: 'The query text: PromQL for a prometheus datasource, or a LogQL stream selector for loki. At most 4000 characters.' },
      mode: { type: 'string', description: 'Optional "instant" (default) for a single evaluation, or "range" for a sampled series with trend and sparkline. A loki datasource accepts metric queries only in instant mode; log-stream selectors need range.' },
      from: { type: 'string', description: 'Optional range start: relative like now-6h or a 13-digit epoch millisecond timestamp. Defaults to now-1h. Ignored in instant mode, which evaluates at the to instant. In range mode it must be strictly earlier than to (a zero-length range has no sampling step) and the span may not exceed 90 days.' },
      to: { type: 'string', description: 'Optional range end, same syntax. Defaults to now; in instant mode this is the evaluation instant.' },
      points: { type: 'number', description: 'Optional sampling density for range mode, 10-480. Defaults to 120. Sent as both maxDataPoints and the basis for intervalMs, so the upstream does the downsampling.' },
      maxSeries: { type: 'number', description: 'Optional cap on series rendered, 1-200. Defaults to 40; anything dropped is disclosed on a final budget line.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: METRIC_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Run metric query ${oneLine(String(args?.expr ?? ''), 60)}`, kind: 'read' }),
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      // 全部本地校验先做完：参数不对就绝不发请求，连发现数据源那一次 GET 也不发。
      // datasource 形态校验下沉到 runBareMetricQuery；这里只管 expr / mode / points /
      // 时间区间——这些都属于「调用方在工具层就该拦下」的输入。
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

      const { datasource, response, intervalMs } = await runBareMetricQuery({
        srt,
        datasource: args.datasource,
        expr,
        mode,
        fromMs,
        toMs,
        points,
        signal: exec.signal,
      })
      const frames = Array.isArray(response?.results?.A?.frames) ? response.results.A.frames : []

      const shown = frames.slice(0, maxSeries)
      const lines = summarizeMetricResult(shown, { mode, datasource, expr, range: `${from}..${to}`, points, total: frames.length, fromMs, toMs, stepMs: intervalMs })
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
      from: { type: 'string', description: 'Optional range start: relative like now-6h or a 13-digit epoch millisecond timestamp. Overrides the URL from parameter; defaults to now-1h. Must be strictly earlier than to (a zero-length range has no sampling step) and at most 90 days before it.' },
      to: { type: 'string', description: 'Optional range end: relative like now or a 13-digit epoch millisecond timestamp. Overrides the URL to parameter; defaults to now.' },
      points: { type: 'number', description: 'Optional bucket count per series, 1-180. Defaults to 24. Sent as maxDataPoints with intervalMs derived from it, so the upstream does the downsampling.' },
      variables: { type: 'string', description: 'Optional JSON object overriding dashboard template variables, with the same syntax and the same supported variable types as grafana_panel_query.' },
      maxPanels: { type: 'number', description: 'Optional cap on panels queried for a whole-dashboard URL (1-50). Defaults to 30.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    // 整盘逐面板降级 + 每条 series 都要过一遍桶化，比裸查询宽一档。
    timeoutMs: TREND_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Read dashboard trends ${oneLine(String(args?.urlOrUid ?? ''), 60)}`, kind: 'read' }),
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      const parsed = parseDashboardUrl(args.urlOrUid)
      const points = requireBoundedInteger(args.points, 'points', 1, TREND_MAX_BUCKETS, TREND_DEFAULT_BUCKETS)
      const maxPanels = resolveMaxPanels(args.maxPanels)
      const explicitOverrides = parseVariableOverrides(args.variables)
      const overrides = mergeVariableOverrides(parsed, explicitOverrides)
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
          if (ctx.datasource.type === LOKI_DATASOURCE_TYPE) {
            // Loki 用 queryType 控制查询模式：趋势必须用 range，不能保留
            // target 里原有的 instant，否则 /api/ds/query 会返回单点而非区间。
            query.queryType = 'range'
            query.maxLines = LOKI_MAX_LINES
          } else {
            query.range = true
            query.instant = false
          }
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
        `Trend uid=${parsed.uid}, range ${range}, step=${intervalMs}ms, ${selected.length} panel(s), ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}, ${points} bucket(s) each.${degradedNote}`,
        ...renderSkippedPanels(skipped),
        ...summarizeTrendFrames(records, results, { points, budget, range, fromMs, toMs }),
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
