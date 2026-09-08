// lib/panels.js — 面板查询管线：把「面板 target → /api/ds/query 请求体」与「批量请求 →
// 逐面板降级」两段从工具里抽出来，供 grafana_panel_query 与 grafana_trend 共用。
// 两个工具的唯一差异落在 queryShape 回调（往请求体上盖哪些采样键）与各自的摘要函数上；
// 变量插值、adhoc 分发、refId 去重、跳过原因归并、批量降级这些容易走样的规则只维护一份。
// 本模块是纯搬迁：文案、判定顺序与边界处理与抽取前逐字一致（仅消除了两处变量遮蔽
// 与一个只能被调用一次的惰加载标志）。
import {
  ADHOC_DATASOURCE_SUPPORT_TEXT,
  DEFAULT_DATASOURCE_UID,
  DEFAULT_QUERY_MAX_PANELS,
  LOKI_DATASOURCE_TYPE,
  MAX_QUERY_VARIABLES_BYTES,
  PROMETHEUS_DATASOURCE_TYPE,
  QUERY_MAX_PANELS_LIMIT,
} from './constants.js'
import {
  applyAdhocFilters,
  applicableAdhocFilters,
  buildDatasourceIndex,
  interpolateVariablesJson,
  resolveDatasourceRef,
  targetHasQueryPayload,
  validateAdhocFiltersForDatasource,
  variableValuesOf,
} from './query.js'
import { byteLength, flattenPanels, oneLine } from './util.js'

// 从原始数据源引用里提取模板变量名：$datasource 与 ${datasource} 两种形状
// （datasource 型模板变量的典型引用方式）；非变量引用返回 null。
function datasourceVariableNameOf(ref) {
  const uid = ref && typeof ref === 'object' && typeof ref.uid === 'string' ? ref.uid.trim() : ''
  if (uid.startsWith('${') && uid.endsWith('}')) return uid.slice(2, -1)
  if (uid.startsWith('$')) return uid.slice(1)
  return null
}

// maxPanels 与 variables 两个参数的校验：两个工具共用同一条边界与同一句报错，
// 免得日后一边放宽一边没放。
export function resolveMaxPanels(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_QUERY_MAX_PANELS
  if (!Number.isInteger(value) || value < 1 || value > QUERY_MAX_PANELS_LIMIT) {
    throw new Error(`maxPanels must be an integer between 1 and ${QUERY_MAX_PANELS_LIMIT}.`)
  }
  return value
}

export function parseVariableOverrides(raw) {
  if (!String(raw ?? '').trim()) return null
  if (byteLength(raw) > MAX_QUERY_VARIABLES_BYTES) throw new Error(`variables exceeds the ${MAX_QUERY_VARIABLES_BYTES}-byte limit.`)
  let overrides
  try {
    overrides = JSON.parse(raw)
  } catch (error) {
    throw new Error(`variables is not valid JSON: ${error.message}`)
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('variables must be a JSON object of variable names to values.')
  return overrides
}

// 取盘 → 选面板 → 解析模板变量与 adhoc → 按需拉数据源索引。这一段完全不涉及
// from/to（panel_query 把 now-2h 原样透传给 /api/ds/query，trend 则要先换算成毫秒才能
// 算 intervalMs），所以时间参数的差异留在各自的工具里，这段能干净地共用。
// 与 collectPanelQueries 同理：这些规则最容易走样，只维护一份。
export async function loadPanelRun({ srt, parsed, maxPanels, overrides, signal }) {
  const data = await srt.authenticatedApi(`/api/dashboards/uid/${encodeURIComponent(parsed.uid)}`, {}, signal)
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
  const templating = Array.isArray(dashboard?.templating?.list) ? dashboard.templating.list : []
  for (const variable of templating) {
    if (!variable || typeof variable !== 'object' || typeof variable.name !== 'string' || !variable.name) continue
    if (variable.type !== 'adhoc') continue
    const filters = values.get(variable.name)
    if (!Array.isArray(filters) || filters.length === 0) continue
    rawAdhocEntries.push({ name: variable.name, filters, boundRef: variable.datasource ?? null })
  }

  // 数据源索引按需加载：仅当存在需要解析的引用（字符串 uid、缺 type 的对象、
  // uid 引用 $datasource 变量、"default" 伪 uid；含 adhoc 变量的绑定引用）时才请求
  // 一次 GET /api/datasources；权限不足或响应异常时为 null，引用走原 uid 透传
  // （Grafana 可自行解析裸 uid）。
  const refNeedsResolution = (ref) => {
    if (!ref) return true
    if (typeof ref === 'string') return true
    if (typeof ref !== 'object' || Array.isArray(ref)) return true
    if (typeof ref.type !== 'string' || !ref.type.trim()) return true
    if (typeof ref.uid !== 'string') return true
    const uid = ref.uid.trim()
    return uid === DEFAULT_DATASOURCE_UID || uid.startsWith('$')
  }
  const needsIndex = selected.some((panel) => panel.targets.some((target) => target && typeof target === 'object' && target.hide !== true && refNeedsResolution(target.datasource ?? panel.datasource)))
    || rawAdhocEntries.some((entry) => entry.boundRef !== null && refNeedsResolution(entry.boundRef))
  let datasourceIndex = null
  if (needsIndex) {
    try {
      const entries = await srt.authenticatedApi('/api/datasources', {}, signal)
      datasourceIndex = Array.isArray(entries) ? buildDatasourceIndex(entries) : null
    } catch {
      datasourceIndex = null
    }
  }

  // 把 adhoc 绑定解析成真实 uid（与面板引用同一套规则）；解析不了就整工具
  // 报错——静默当成未绑定或匹配失败都会丢过滤条件。能否安全映射到查询语法
  // 由 collectPanelQueries 里的 dry-run 翻译把关。
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

  return { dashboard, selected, queryable, values, scopedVars, adhocEntries, datasourceIndex }
}

// 把选中面板的每个可见 target 编译成一条 /api/ds/query 请求。
// queryShape(query, ctx) 是调用方注入的采样形状回调，ctx 带 panel/target/datasource/
// refId/originalRefId，便于按数据源类型决定盖哪些键——表达式 target 由服务端引擎
// 解析，不接受 range/instant/intervalMs 这类采样键。缺省时不盖任何键。
export function collectPanelQueries({ dashboard, parsed, selected, values, scopedVars, adhocEntries, datasourceIndex, queryShape }) {
  const shape = typeof queryShape === 'function' ? queryShape : () => {}
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
      const rawRef = target.datasource ?? panel.datasource
      let resolved
      try {
        resolved = resolveDatasourceRef(rawRef, values, datasourceIndex)
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
        // adhoc 条件必须能安全映射到对应数据源的查询语法：解析出数据源类型后
        // dry-run 翻译，无法映射直接报整工具错误，绝不带病发请求、绝不静默忽略。
        validateAdhocFiltersForDatasource(datasource, adhocEntries)
      }
      // 404/502 失败后的回溯线索。两类来源值得记（索引在场为前提，否则无法与
      // 「索引暂时拉不到」区分）：
      // - 引用来自 datasource 型模板变量（$var/${var}）：不以 passthrough 为前提。
      //   变量已存值可能指向已删除的 uid（索引查无 → 透传），也可能指向列表里
      //   仍在、内部已坏的源（如 URL 为空，一查即 404/502——实弹复测正是这种：
      //   解析命中索引、Grafana 仍拒查询）。两种根因下「传 variables 换一个好源」
      //   都是可行动的出路。
      // - 直存 uid 且索引查无此源（passthrough）：面板保存的数据源已不存在。
      // 名称与 uid 均为不可信数据，先清洗。
      let datasourceOrigin = null
      if (datasourceIndex) {
        const variableName = datasourceVariableNameOf(rawRef)
        if (variableName !== null) {
          datasourceOrigin = { kind: 'variable', name: oneLine(variableName, 60), uid: oneLine(datasource.uid, 60) }
        } else if (resolved.passthrough) {
          datasourceOrigin = { kind: 'uid', uid: oneLine(datasource.uid, 60) }
        }
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
      shape(query, { panel, target, datasource, refId, originalRefId })
      queries.push(query)
      records.push({ panel, refId, originalRefId, query, datasourceOrigin })
    }
  }
  if (queries.length === 0) {
    // 所有面板被跳过：逐面板列出 id/标题与跳过原因（同一面板的同一原因
    // 去重为一条并附 target refId 列表），绝不笼统地只说 "no executable query"。
    const detail = skipped.map(renderSkipDetail).join('; ')
    throw new Error(`The selected panel(s) yielded no executable query. ${detail ? `Skipped: ${detail}` : 'No visible query targets were found on the selected panels.'}`)
  }
  return { queries, records, skipped }
}

// 跳过原因的输出行：一行一个面板。与 collectPanelQueries 里那份错误文案的渲染分开
// ——错误要把所有原因挤进一句（标题只留 40 字符），输出行有整行可用（留 60）。
// 两个工具共用这一份，格式不会各写各的。
export function renderSkippedPanels(skipped) {
  return (Array.isArray(skipped) ? skipped : []).map((entry) => {
    const refIds = entry.refIds.length === 1 ? ` (target ${entry.refIds[0]})` : entry.refIds.length > 1 ? ` (targets ${entry.refIds.join(', ')})` : ''
    return `panel id=${entry.panel.id} ${JSON.stringify(oneLine(entry.panel.title ?? '', 60))}: skipped (${oneLine(entry.message, 120)})${refIds}`
  })
}

// /api/ds/query 的 404/502 与数据源引用有关时，把「实际用的 uid + 出路」附进失败
// 文案。变量引用解析出的 uid 有两种坏法：已存值指向已删除的源（索引查无 → 透传
// 即 404），或指向列表里仍在、内部已坏的源（空 URL 等，一查即 404/502）——两种
// 根因的出路相同：传 variables 换一个数据源。只对 404/502 生效（400 是查询语法
// 错、5xx 的其余码与此无关的居多）；来源标注在 collectPanelQueries 里已完成
//（名称与 uid 已清洗）。
function datasourceFailureHint(records, message) {
  if (!/^Grafana API (404|502) POST \/api\/ds\/query/.test(String(message ?? ''))) return ''
  const parts = []
  const seen = new Set()
  for (const record of Array.isArray(records) ? records : []) {
    const origin = record?.datasourceOrigin
    if (!origin || seen.has(origin.uid)) continue
    seen.add(origin.uid)
    parts.push(origin.kind === 'variable'
      ? `datasource uid "${origin.uid}" came from template variable "${origin.name}"; if that saved value is stale or points at a broken datasource, pass variables={"${origin.name}":"<valid uid>"} (grafana_datasources lists the uids and their URLs)`
      : `datasource uid "${origin.uid}" was saved in the dashboard and does not exist on this source; edit the panel's datasource or override the variable`)
  }
  // 同一请求里最多列两个可疑来源（面板数据源通常一致，多列只是噪音）。
  return parts.length > 0 ? ` — ${parts.slice(0, 2).join('; ')}${parts.length > 2 ? '; …' : ''}` : ''
}

// 多条查询先试一次批量请求（含 __expr__ 面板时表达式引用天然正常）；
// 失败（超时、响应过大等）自动降级为逐面板请求，单面板失败只记录不中断，
// 最后汇总出部分结果。降级时把失败原因写进 degradedNote，由调用方拼进首行。
export async function runPanelQueries({ srt, queries, records, from, to, scopedVars, signal, timeoutMs }) {
  const vars = scopedVars && typeof scopedVars === 'object' ? scopedVars : {}
  // 构建请求体：与面板自带 lucene 串的合并在构建期已完成，请求体不含
  // 请求级 adhocFilters（Grafana 10.x 的 /api/ds/query 不消费该字段）。
  const scopedVarsBody = Object.keys(vars).length > 0 ? { scopedVars: vars } : {}
  const postQuery = (queryList) => srt.authenticatedApi('/api/ds/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: queryList, from, to, ...scopedVarsBody }),
  }, signal, timeoutMs)

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
        // 工具级超时已到（宿主 abort 了 exec.signal）：继续重试只会得到一墙
        // 「timed out or was cancelled」的误导性 failed 行，让模型误判数据源全挂——
        // 未重试的面板显式记为预算耗尽，模型即可区分工具时限与数据源故障。
        if (signal?.aborted) {
          const message = 'tool time budget exhausted before this panel could be retried'
          for (const record of panelRecords) record.failed = message
          continue
        }
        try {
          const response = await postQuery(panelRecords.map((record) => record.query))
          Object.assign(results, response?.results ?? {})
        } catch (panelError) {
          // 上游文案照旧截 150 字符；提示句有界且已清洗，追加其后不占这个预算。
          const message = `${oneLine(panelError?.message ?? String(panelError), 150)}${datasourceFailureHint(panelRecords, panelError?.message)}`
          for (const record of panelRecords) record.failed = message
        }
      }
    }
  } else {
    // 单查询特例：保持直发，无降级；404/502 且引用来源可疑时附加回溯提示。
    try {
      results = (await postQuery(queries))?.results
    } catch (error) {
      const hint = datasourceFailureHint(records, error?.message)
      if (hint) throw new Error(`${error.message}${hint}`)
      throw error
    }
  }
  return { results, degradedNote }
}
