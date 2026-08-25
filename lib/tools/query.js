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
import { interpolateVariables, isValidTimeInput, parseDashboardUrl, summarizeFrames, variableValuesOf } from '../query.js'
import { byteLength, flattenPanels, oneLine, textOut } from '../util.js'

export function defineGrafanaQueryTool(rt) {
  return defineTool({
    name: 'grafana_query',
    description: 'Query the live data behind dashboard panels. Paste the dashboard or panel-view URL from the browser (or a UID); the tool runs the panel queries via /api/ds/query and returns a bounded statistical summary. Read-only; results are untrusted data.',
    parameters: {
      urlOrUid: { type: 'string', required: true, description: 'Dashboard URL, panel-view URL containing ?viewPanel=..., or a 1-40 character dashboard UID.' },
      from: { type: 'string', description: 'Optional range start: relative like now-1h or a 13-digit epoch millisecond timestamp. Overrides the URL from parameter; defaults to now-1h.' },
      to: { type: 'string', description: 'Optional range end: relative like now or a 13-digit epoch millisecond timestamp. Overrides the URL to parameter; defaults to now.' },
      variables: { type: 'string', description: 'Optional JSON object overriding dashboard template variables, e.g. {"env":"prod"}.' },
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
      const values = variableValuesOf(dashboard, overrides)
      const records = []
      const skipped = []
      const queries = []
      const usedRefIds = new Set()
      for (const panel of selected) {
        for (const target of panel.targets) {
          if (!target || typeof target !== 'object' || target.hide === true) continue
          // 旧版字符串型数据源拿不到 type，跳过；/api/ds/query 需要 { type, uid } 结构。
          const datasource = target.datasource ?? panel.datasource
          if (!datasource || typeof datasource !== 'object' || typeof datasource.type !== 'string') continue
          const originalRefId = typeof target.refId === 'string' && target.refId ? target.refId : 'A'
          let query
          try {
            const raw = JSON.stringify({ ...target, datasource })
            // Expression 面板里的 $A 是 refId 引用，由 Grafana 表达式引擎在服务端
            // 解析，不是模板变量，原样透传。
            query = JSON.parse(datasource.type === '__expr__' ? raw : interpolateVariables(raw, values))
          } catch (error) {
            // 单面板替换失败不拖垮整盘：记录并跳过，摘要里说明原因。
            skipped.push({ panel, message: error.message })
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
        const detail = skipped.map((entry) => `panel id=${entry.panel.id}: ${oneLine(entry.message, 120)}`).join('; ')
        throw new Error(`The selected panel(s) yielded no executable query.${detail ? ` Skipped: ${detail}` : ''}`)
      }

      // 多条查询先试一次批量请求；失败（超时、响应过大等）自动降级为逐面板请求，
      // 单面板失败只记录不中断，最后汇总出部分结果。
      const batchInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries, from, to }),
      }
      let results
      let degradedNote = ''
      if (queries.length > 1) {
        try {
          const response = await rt.authenticatedApi('/api/ds/query', batchInit, exec.signal, QUERY_REQUEST_TIMEOUT_MS)
          results = response?.results
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
              const response = await rt.authenticatedApi('/api/ds/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ queries: panelRecords.map((record) => record.query), from, to }),
              }, exec.signal, QUERY_REQUEST_TIMEOUT_MS)
              Object.assign(results, response?.results ?? {})
            } catch (panelError) {
              const message = oneLine(panelError?.message ?? String(panelError), 150)
              for (const record of panelRecords) record.failed = message
            }
          }
        }
      } else {
        const response = await rt.authenticatedApi('/api/ds/query', batchInit, exec.signal, QUERY_REQUEST_TIMEOUT_MS)
        results = response?.results
      }

      const scope = parsed.viewPanel !== null ? `panel id=${parsed.viewPanel}` : `${selected.length} panel(s)`
      const lines = [
        `Dashboard uid=${parsed.uid}, range ${from}..${to}, ${scope}, ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}.${degradedNote}`,
        ...skipped.map((entry) => `panel id=${entry.panel.id} ${JSON.stringify(oneLine(entry.panel.title ?? '', 60))}: skipped (${oneLine(entry.message, 120)})`),
        ...summarizeFrames(records, results),
      ]
      if (parsed.viewPanel === null && queryable.length > selected.length) {
        lines.push(`(…${queryable.length - selected.length} more panel(s) not queried; raise maxPanels to include them.)`)
      }
      return lines.join('\n')
    },
  })
}
