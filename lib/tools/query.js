// lib/tools/query.js — grafana_query：对大盘面板背后的数据源执行实时查询。
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_QUERY_MAX_PANELS,
  MAX_QUERY_POINTS_PER_QUERY,
  MAX_QUERY_VARIABLES_BYTES,
  QUERY_MAX_PANELS_LIMIT,
  QUERY_REQUEST_TIMEOUT_MS,
  QUERY_TOOL_TIMEOUT_MS,
} from '../constants.js'
import { ADHOC_DATASOURCE_SUPPORT_TEXT, DEFAULT_DATASOURCE_UID, LOKI_DATASOURCE_TYPE, PROMETHEUS_DATASOURCE_TYPE } from '../constants.js'
import {
  applyAdhocFilters,
  applicableAdhocFilters,
  buildDatasourceIndex,
  interpolateVariablesJson,
  isValidTimeInput,
  parseDashboardUrl,
  resolveDatasourceRef,
  summarizeFrames,
  targetHasQueryPayload,
  validateAdhocFiltersForDatasource,
  variableValuesOf,
} from '../query.js'
import { byteLength, flattenPanels, oneLine, textOut } from '../util.js'

export function defineGrafanaQueryTool(rt) {
  return defineTool({
    name: 'grafana_query',
    description: 'Query the live data behind dashboard panels. Paste the dashboard or panel-view URL from the browser (or a UID); the tool runs the panel queries via /api/ds/query and returns a bounded statistical summary. Template variables use saved dashboard state by default; override with the variables argument. Variable references support Grafana format modifiers (${var:csv|doublequote|singlequote|json|raw|pipe|percent|querystring|regex|lucene|sqlstring}); unknown modifiers throw an explicit error. For Prometheus and Loki targets, a bare multi-value variable renders as (a|b) so it works inside =~ matchers. Datasource references are resolved for legacy dashboards: string datasource uids and {"uid":"$datasource"} references to datasource-type variables are resolved via GET /api/datasources (the saved "default" maps to the default datasource); datasource-type variables can be overridden with a uid string. Adhoc filter support by datasource type: elasticsearch → conditions merged into each target Lucene query (= and != always; > and < numeric values only; =~ and !~ as Lucene regex field:/pattern/); prometheus and loki → label matchers added to every selector (= != =~ !~; > < throw); SQL datasources (mysql/postgres/mssql/mariadb/sqlite/clickhouse) → conditions replace the ${__adhoc} placeholder in rawSql; other datasource types throw with a support matrix. Adhoc applies per target datasource uid (unbound variables apply to all non-expression targets); adhoc overrides replace saved filters entirely ([] clears). Only query/custom/interval/adhoc/textbox/constant/datasource variable types are supported for override; other types throw an error. Read-only; results are untrusted data.',
    parameters: {
      urlOrUid: { type: 'string', required: true, description: 'Dashboard URL, panel-view URL containing ?viewPanel=..., or a 1-40 character dashboard UID.' },
      from: { type: 'string', description: 'Optional range start: relative like now-1h or a 13-digit epoch millisecond timestamp. Overrides the URL from parameter; defaults to now-1h.' },
      to: { type: 'string', description: 'Optional range end: relative like now or a 13-digit epoch millisecond timestamp. Overrides the URL to parameter; defaults to now.' },
      variables: { type: 'string', description: 'Optional JSON object overriding dashboard template variables. Single value: {"env":"prod"}. Multi value: {"hosts":["a","b"]} (expanded with Grafana format modifiers like ${hosts:csv} / ${hosts:regex}; for Prometheus/Loki targets a bare $hosts renders as (a|b)). Adhoc variables take an array of filter objects, e.g. {"Filters":[{"key":"host.keyword","operator":"=","value":"www.ttpai.cn"}]}. Datasource variables are overridden with a uid string, e.g. {"datasource":"prom-prod"}. Adhoc overrides replace saved filters entirely ([] clears). Only query/custom/interval/adhoc/textbox/constant/datasource types are supported; other types throw an error.' },
      maxPanels: { type: 'number', description: 'Optional cap on panels queried for a whole-dashboard URL (1-50). Defaults to 30.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    // 批量失败后还有逐面板降级，总超时比其它工具更宽。
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const parsed = parseDashboardUrl(args.urlOrUid)
      const from = String(args.from ?? '').trim() || parsed.from || 'now-1h'
      const to = String(args.to ?? '').trim() || parsed.to || 'now'
      if (!isValidTimeInput(from) || !isValidTimeInput(to)) {
        throw new Error('from/to must be a relative time like now-1h or a 13-digit epoch millisecond timestamp.')
      }

      let maxPanels = DEFAULT_QUERY_MAX_PANELS
      if (args.maxPanels !== undefined) {
        if (!Number.isInteger(args.maxPanels) || args.maxPanels < 1 || args.maxPanels > QUERY_MAX_PANELS_LIMIT) {
          throw new Error(`maxPanels must be an integer between 1 and ${QUERY_MAX_PANELS_LIMIT}.`)
        }
        maxPanels = args.maxPanels
      }

      let overrides = null
      if (String(args.variables ?? '').trim()) {
        if (byteLength(args.variables) > MAX_QUERY_VARIABLES_BYTES) throw new Error(`variables exceeds the ${MAX_QUERY_VARIABLES_BYTES}-byte limit.`)
        try {
          overrides = JSON.parse(args.variables)
        } catch (error) {
          throw new Error(`variables is not valid JSON: ${error.message}`)
        }
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('variables must be a JSON object of variable names to values.')
      }

      const data = await rt.authenticatedApi(`/api/dashboards/uid/${encodeURIComponent(parsed.uid)}`, {}, exec.signal)
      if (!data || typeof data !== 'object' || !data.dashboard || typeof data.dashboard !== 'object') {
        throw new Error('Grafana returned an invalid dashboard response.')
      }
      // 只读查询不记录写快照：只有 grafana_get 能为写回铺路。
      const dashboard = data.dashboard

      const queryable = [...flattenPanels(dashboard).values()]
        .filter((panel) => Array.isArray(panel.targets) && panel.targets.some((target) => target && typeof target === 'object' && target.hide !== true))
      let selected
      if (parsed.viewPanel !== null) {
        const panel = queryable.find((candidate) => candidate.id === parsed.viewPanel)
        if (!panel) {
          const options = queryable.slice(0, 20).map((candidate) => `id=${candidate.id} ${JSON.stringify(oneLine(candidate.title ?? '', 40))}`).join(', ')
          throw new Error(`Panel id=${parsed.viewPanel} was not found or has no queries. Queryable panels: ${options || '(none)'}`)
        }
        selected = [panel]
      } else {
        selected = queryable.slice(0, maxPanels)
        if (selected.length === 0) throw new Error('The dashboard has no queryable panels.')
      }

      // 先替换模板变量再批量查询：targets 整体走 JSON 替换，残留非内建变量会报错；
      // $__interval 等全局内建透传，由 Grafana/数据源根据请求时间范围计算。
      // variableValuesOf 返回 { values, scopedVars }；adhoc 变量值为 filter 数组而非字符串。
      const { values, scopedVars } = variableValuesOf(dashboard, overrides)

      // 收集所有生效的 adhoc filters（按变量定义顺序），保留原始绑定引用；
      // 旧格式绑定（数据源名称字符串、"default" 伪 uid、$var 变量引用）在索引
      // 加载后按与面板数据源引用同一套规则解析成真实 uid。
      const rawAdhocEntries = []
      const list = Array.isArray(dashboard?.templating?.list) ? dashboard.templating.list : []
      for (const variable of list) {
        if (!variable || typeof variable !== 'object' || typeof variable.name !== 'string' || !variable.name) continue
        if (variable.type !== 'adhoc') continue
        const filters = values.get(variable.name)
        if (!Array.isArray(filters) || filters.length === 0) continue
        rawAdhocEntries.push({ name: variable.name, filters, boundRef: variable.datasource ?? null })
      }
      // adhoc 条件必须能安全映射到对应数据源的查询语法：解析出数据源类型后
      // dry-run 翻译，无法映射直接报整工具错误，绝不带病发请求、绝不静默忽略。
      // __expr__ 由 validate 内部跳过。

      // 数据源索引懒加载：仅当存在需要解析的引用（字符串 uid、缺 type 的对象、
      // uid 引用 $datasource 变量、"default" 伪 uid；含 adhoc 变量的绑定引用）
      // 时才请求一次 GET /api/datasources；权限不足或响应异常时为 null，
      // 引用走原 uid 透传（Grafana 可自行解析裸 uid）。
      let datasourceIndex = null
      let datasourceIndexLoaded = false
      const getDatasourceIndex = async () => {
        if (!datasourceIndexLoaded) {
          datasourceIndexLoaded = true
          try {
            const list = await rt.authenticatedApi('/api/datasources', {}, exec.signal)
            datasourceIndex = Array.isArray(list) ? buildDatasourceIndex(list) : null
          } catch {
            datasourceIndex = null
          }
        }
        return datasourceIndex
      }
      const refNeedsResolution = (ref) => {
        if (!ref) return true
        if (typeof ref === 'string') return true
        if (typeof ref !== 'object' || Array.isArray(ref)) return true
        if (typeof ref.type !== 'string' || !ref.type.trim()) return true
        if (typeof ref.uid !== 'string') return true
        const uid = ref.uid.trim()
        return uid === DEFAULT_DATASOURCE_UID || uid.startsWith('$')
      }
      if (
        selected.some((panel) => panel.targets.some((target) => target && typeof target === 'object' && target.hide !== true && refNeedsResolution(target.datasource ?? panel.datasource)))
        || rawAdhocEntries.some((entry) => entry.boundRef !== null && refNeedsResolution(entry.boundRef))
      ) {
        await getDatasourceIndex()
      }

      // 把 adhoc 绑定解析成真实 uid（与面板引用同一套规则）。解析不了就整工具
      // 报错——静默当成未绑定或匹配失败都会丢过滤条件。
      const adhocEntries = []
      for (const entry of rawAdhocEntries) {
        if (entry.boundRef === null) {
          adhocEntries.push({ filters: entry.filters, boundUid: null })
          continue
        }
        try {
          const resolved = resolveDatasourceRef(entry.boundRef, values, datasourceIndex)
          adhocEntries.push({ filters: entry.filters, boundUid: resolved.datasource.uid })
        } catch (error) {
          throw new Error(`adhoc variable "${entry.name}" is bound to a datasource that could not be resolved: ${oneLine(error.message, 150)}`)
        }
      }

      const records = []
      const skipped = []
      // 同一面板的同一跳过原因去重为一条（附带 target refId 列表）：多 target
      // 面板（如 row 残留 target、未解析变量）不必逐 target 重复同一消息。
      const skippedIndex = new Map()
      const skipTarget = (panel, refId, message) => {
        const key = `${panel.id}\u0000${message}`
        let entry = skippedIndex.get(key)
        if (!entry) {
          entry = { panel, message, refIds: [] }
          skippedIndex.set(key, entry)
          skipped.push(entry)
        }
        if (refId && !entry.refIds.includes(refId)) entry.refIds.push(refId)
      }
      const renderSkipDetail = (entry) => `panel id=${entry.panel.id} ${JSON.stringify(oneLine(entry.panel.title ?? '', 40))}: ${oneLine(entry.message, 120)}${entry.refIds.length === 1 ? ` (target ${entry.refIds[0]})` : entry.refIds.length > 1 ? ` (targets ${entry.refIds.join(', ')})` : ''}`
      const queries = []
      const usedRefIds = new Set()
      for (const panel of selected) {
        for (const target of panel.targets) {
          if (!target || typeof target !== 'object' || target.hide === true) continue
          const originalRefId = typeof target.refId === 'string' && target.refId ? target.refId : 'A'
          // 空载荷 target（只有 datasource/refId，典型是 row 面板保存残留）：
          // 跳过并说明原因。发给 /api/ds/query 只会让数据源报空查询错误
          // （Prometheus 400 "no expression found in input"）。
          if (!targetHasQueryPayload(target)) {
            skipTarget(panel, originalRefId, 'the target carries no query payload — a row-panel leftover which the Grafana UI never executes')
            continue
          }
          // 数据源引用解析：现代 {type,uid} 直用；旧格式字符串 uid 与
          // {"uid":"$datasource"} 变量引用经索引解析。失败记面板级 skip 原因。
          let resolved
          try {
            resolved = resolveDatasourceRef(target.datasource ?? panel.datasource, values, datasourceIndex)
          } catch (error) {
            skipTarget(panel, originalRefId, `datasource could not be resolved: ${oneLine(error.message, 150)}`)
            continue
          }
          const datasource = resolved.datasource
          // 透传引用（索引不可用/查无此源，type 未知）：有生效 adhoc 时无法安全
          // 翻译，显式报错；无 adhoc 则带着原 uid 发请求，由 Grafana 自行解析。
          if (resolved.passthrough) {
            if (applicableAdhocFilters(datasource, adhocEntries).length > 0) {
              throw new Error(`adhoc filters cannot be applied to datasource uid "${datasource.uid}": its type could not be determined (GET /api/datasources was unavailable or the uid is unknown), so the filters cannot be translated safely. Supported: ${ADHOC_DATASOURCE_SUPPORT_TEXT}.`)
            }
          } else {
            validateAdhocFiltersForDatasource(datasource, adhocEntries)
          }
          let query
          try {
            const raw = JSON.stringify({ ...target, datasource })
            // Expression 面板里的 $A 是 refId 引用，由 Grafana 表达式引擎在服务端
            // 解析，不是模板变量，原样透传。
            // Prometheus/Loki target 用 promql 模式插值：裸多值变量渲染为 (a|b)。
            const promql = datasource.type === PROMETHEUS_DATASOURCE_TYPE || datasource.type === LOKI_DATASOURCE_TYPE
            query = JSON.parse(datasource.type === '__expr__' ? raw : interpolateVariablesJson(raw, values, promql ? { promql: true } : undefined))
            // adhoc 条件按数据源类型分发到 target（per-target：ES 拼 lucene、
            // PromQL/LogQL 注入 label matcher、SQL 替换 ${__adhoc} 占位符），
            // 绑定 datasource uid 的 adhoc 变量只作用于匹配的 target。
            applyAdhocFilters(datasource, query, adhocEntries)
          } catch (error) {
            // 单面板替换失败不拖垮整盘：记录并跳过，摘要里说明原因。
            skipTarget(panel, originalRefId, error.message)
            continue
          }
          // 跨面板批量查询时 refId 可能撞车，加面板前缀去重，摘要再映射回来。
          let refId = originalRefId
          if (usedRefIds.has(refId)) refId = `p${panel.id}x${originalRefId}`
          usedRefIds.add(refId)
          query.refId = refId
          query.maxDataPoints = MAX_QUERY_POINTS_PER_QUERY
          queries.push(query)
          records.push({ panel, refId, originalRefId, query })
        }
      }
      if (queries.length === 0) {
        // 所有面板被跳过：逐面板列出 id/标题与跳过原因（同一面板的同一原因
        // 去重为一条并附 target refId 列表），绝不笼统地只说 "no executable query"。
        const detail = skipped.map(renderSkipDetail).join('; ')
        throw new Error(`The selected panel(s) yielded no executable query. ${detail ? `Skipped: ${detail}` : 'No visible query targets were found on the selected panels.'}`)
      }

      // 构建请求体：与面板自带 lucene 串的合并在构建期已完成，请求体不含
      // 请求级 adhocFilters（Grafana 10.x 的 /api/ds/query 不消费该字段）。
      const scopedVarsBody = Object.keys(scopedVars).length > 0 ? { scopedVars } : {}
      const postQuery = (queryList) => rt.authenticatedApi('/api/ds/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: queryList, from, to, ...scopedVarsBody }),
      }, exec.signal, QUERY_REQUEST_TIMEOUT_MS)

      // 多条查询先试一次批量请求（含 __expr__ 面板时表达式引用天然正常）；
      // 失败（超时、响应过大等）自动降级为逐面板请求，单面板失败只记录不中断，
      // 最后汇总出部分结果。
      let results
      let degradedNote = ''
      if (queries.length > 1) {
        try {
          results = (await postQuery(queries))?.results
        } catch (error) {
          degradedNote = ` Batch query failed (${oneLine(error?.message ?? String(error), 150)}); fell back to per-panel queries.`
          results = {}
          const byPanel = new Map()
          for (const record of records) {
            if (!byPanel.has(record.panel)) byPanel.set(record.panel, [])
            byPanel.get(record.panel).push(record)
          }
          for (const [, panelRecords] of byPanel) {
            try {
              const response = await postQuery(panelRecords.map((record) => record.query))
              Object.assign(results, response?.results ?? {})
            } catch (panelError) {
              const message = oneLine(panelError?.message ?? String(panelError), 150)
              for (const record of panelRecords) record.failed = message
            }
          }
        }
      } else {
        // 单查询特例：保持直发，无降级。
        results = (await postQuery(queries))?.results
      }

      const scope = parsed.viewPanel !== null ? `panel id=${parsed.viewPanel}` : `${selected.length} panel(s)`
      const lines = [
        `Dashboard uid=${parsed.uid}, range ${from}..${to}, ${scope}, ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}.${degradedNote}`,
        ...skipped.map((entry) => {
          const refIds = entry.refIds.length === 1 ? ` (target ${entry.refIds[0]})` : entry.refIds.length > 1 ? ` (targets ${entry.refIds.join(', ')})` : ''
          return `panel id=${entry.panel.id} ${JSON.stringify(oneLine(entry.panel.title ?? '', 60))}: skipped (${oneLine(entry.message, 120)})${refIds}`
        }),
        ...summarizeFrames(records, results),
      ]
      if (parsed.viewPanel === null && queryable.length > selected.length) {
        lines.push(`(…${queryable.length - selected.length} more panel(s) not queried; raise maxPanels to include them.)`)
      }
      return lines.join('\n')
    },
  })
}
