// lib/tools/query.js — grafana_panel_query：对大盘面板背后的数据源执行实时查询。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { budgetLine, createBudget } from '../budget.js'
import {
  MAX_QUERY_POINTS_PER_QUERY,
  QUERY_REQUEST_TIMEOUT_MS,
  QUERY_TOOL_TIMEOUT_MS,
} from '../constants.js'
import {
  collectPanelQueries,
  loadPanelRun,
  parseVariableOverrides,
  renderSkippedPanels,
  resolveMaxPanels,
  runPanelQueries,
} from '../panels.js'
import { isValidTimeInput, parseDashboardUrl, summarizeFrames } from '../query.js'
import { textOut } from '../util.js'

export function defineGrafanaPanelQueryTool(rt) {
  return defineTool({
    name: 'grafana_panel_query',
    description: 'Query the live data behind dashboard panels. Paste the dashboard or panel-view URL from the browser (or a UID); the tool runs the panel queries via /api/ds/query and returns a bounded statistical summary. Template variables use saved dashboard state by default; override with the variables argument. Variable references support Grafana format modifiers (${var:csv|doublequote|singlequote|json|raw|pipe|percent|querystring|regex|lucene|sqlstring}); unknown modifiers throw an explicit error. For Prometheus and Loki targets, a bare multi-value variable renders as (a|b) so it works inside =~ matchers. Datasource references are resolved for legacy dashboards: string datasource uids and {"uid":"$datasource"} references to datasource-type variables are resolved via GET /api/datasources (the saved "default" maps to the default datasource); datasource-type variables can be overridden with a uid string. Adhoc filter support by datasource type: elasticsearch → conditions merged into each target Lucene query (= and != always; > and < numeric values only; =~ and !~ as Lucene regex field:/pattern/); prometheus and loki → label matchers added to every selector (= != =~ !~; > < throw); SQL datasources (mysql/postgres/mssql/mariadb/sqlite/clickhouse) → conditions replace the ${__adhoc} placeholder in rawSql; other datasource types throw with a support matrix. Adhoc applies per target datasource uid (unbound variables apply to all non-expression targets); adhoc overrides replace saved filters entirely ([] clears). Only query/custom/interval/adhoc/textbox/constant/datasource variable types are supported for override; other types throw an error. Read-only; results are untrusted data.',
    parameters: {
      urlOrUid: { type: 'string', required: true, description: 'Dashboard URL, panel-view URL containing ?viewPanel=..., or a 1-40 character dashboard UID.' },
      from: { type: 'string', description: 'Optional range start: relative like now-1h or a 13-digit epoch millisecond timestamp. Overrides the URL from parameter; defaults to now-1h.' },
      to: { type: 'string', description: 'Optional range end: relative like now or a 13-digit epoch millisecond timestamp. Overrides the URL to parameter; defaults to now.' },
      variables: { type: 'string', description: 'Optional JSON object overriding dashboard template variables. Single value: {"env":"prod"}. Multi value: {"hosts":["a","b"]} (expanded with Grafana format modifiers like ${hosts:csv} / ${hosts:regex}; for Prometheus/Loki targets a bare $hosts renders as (a|b)). Adhoc variables take an array of filter objects, e.g. {"Filters":[{"key":"host.keyword","operator":"=","value":"www.example.com"}]}. Datasource variables are overridden with a uid string, e.g. {"datasource":"prom-prod"}. Adhoc overrides replace saved filters entirely ([] clears). Only query/custom/interval/adhoc/textbox/constant/datasource types are supported; other types throw an error.' },
      maxPanels: { type: 'number', description: 'Optional cap on panels queried for a whole-dashboard URL (1-50). Defaults to 30.' },
      source: { type: 'string', description: 'Optional Grafana source name (call grafana_sources to list configured sources); omit to use the default source.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    // 批量失败后还有逐面板降级，总超时比其它工具更宽。
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      const parsed = parseDashboardUrl(args.urlOrUid)
      const from = String(args.from ?? '').trim() || parsed.from || 'now-1h'
      const to = String(args.to ?? '').trim() || parsed.to || 'now'
      if (!isValidTimeInput(from) || !isValidTimeInput(to)) {
        throw new Error('from/to must be a relative time like now-1h or a 13-digit epoch millisecond timestamp.')
      }

      const maxPanels = resolveMaxPanels(args.maxPanels)
      const overrides = parseVariableOverrides(args.variables)

      // 取盘、选面板、模板变量与 adhoc 解析都在 lib/panels.js，与 grafana_trend 共用
      // 同一套规则；只读查询不记录写快照，只有 grafana_get 能为写回铺路。
      const { dashboard, selected, queryable, values, scopedVars, adhocEntries, datasourceIndex } = await loadPanelRun({
        srt,
        parsed,
        maxPanels,
        overrides,
        signal: exec.signal,
      })

      // 面板 target → 请求体：变量插值、adhoc 分发、refId 去重与跳过原因归并
      // 都在 lib/panels.js 里，与 grafana_trend 共用同一套规则。
      const { queries, records, skipped } = collectPanelQueries({
        dashboard,
        parsed,
        selected,
        values,
        scopedVars,
        adhocEntries,
        datasourceIndex,
        // 本工具只盖采样点数；grafana_trend 会另盖 range/instant/intervalMs。
        queryShape: (query) => { query.maxDataPoints = MAX_QUERY_POINTS_PER_QUERY },
      })
      const { results, degradedNote } = await runPanelQueries({
        srt,
        queries,
        records,
        from,
        to,
        scopedVars,
        signal: exec.signal,
        timeoutMs: QUERY_REQUEST_TIMEOUT_MS,
      })

      const scope = parsed.viewPanel !== null ? `panel id=${parsed.viewPanel}` : `${selected.length} panel(s)`
      // 预算只统计摘要阶段丢掉的 series 与行；面板上限已有自己的一句带数量披露。
      const budget = createBudget()
      const lines = [
        `Dashboard uid=${parsed.uid}, range ${from}..${to}, ${scope}, ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}.${degradedNote}`,
        ...renderSkippedPanels(skipped),
        ...summarizeFrames(records, results, budget),
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
