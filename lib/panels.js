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
  EXPRESSION_DATASOURCE_TYPE,
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

// 按语法切出表达式里的引用，逐条带位置信息：
// - `${...}`：整体一个引用，名字里可以有空格（`${Query A}`）；
// - `$name`：math 里的显式引用；
// - 裸 name：只剩「无显式表达式类型的兜底解析」在用（见 expressionShapeOf）。
// 两类东西刻意不算引用：函数调用后的名字（`abs($A)` 里的 `abs`，它是 math 内建
// 函数而不是 refId），以及数字里的字母（`1e3` 里的 `e3`）。先消费 `${}` 与 `$name`，
// 再在剩下的文本里找裸名字，所以 `${Query A}` 里的 `A` 不会被当成独立的 A。
function parseExpressionReferences(text) {
  const value = String(text ?? '')
  const refs = []
  let index = 0
  while (index < value.length) {
    const ch = value[index]
    if (ch === '$' && value[index + 1] === '{') {
      const close = value.indexOf('}', index + 2)
      if (close !== -1) {
        refs.push({ name: value.slice(index + 2, close), kind: 'braced', start: index, end: close + 1 })
        index = close + 1
        continue
      }
    }
    if (ch === '$' && /[A-Za-z_]/.test(value[index + 1] ?? '')) {
      let end = index + 1
      while (end < value.length && /[A-Za-z0-9_]/.test(value[end])) end += 1
      refs.push({ name: value.slice(index + 1, end), kind: 'dollar', start: index, end })
      index = end
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = index
      while (end < value.length && /[A-Za-z0-9_]/.test(value[end])) end += 1
      const previous = value[index - 1] ?? ''
      const next = value[end] ?? ''
      // 紧邻数字/字母/点/下划线（`1e3`、`a.b`）说明这是别的东西的一部分。
      const attached = /[A-Za-z0-9_.$-]/.test(previous)
      if (!attached && next !== '(') refs.push({ name: value.slice(index, end), kind: 'bare', start: index, end })
      index = end
      continue
    }
    index += 1
  }
  return refs
}

// reduce/resample/threshold 的 expression 是「整个输入 refId」：Grafana 的
// UnmarshalReduceCommand / UnmarshalResampleCommand 只去掉可选的 $ 前缀，
// NeedsVars 返回该完整名称（Grafana v11 pkg/expr/commands.go）。输入名可以含
// 空格、连字符，甚至以数字开头（`Query A`、`A-B`、`1` 都是合法 refId），绝不能
// 当 math 公式拆词——拆词会让本面板明明存在的输入被判成缺失依赖，或让多面板
// 同名的数字输入悄悄绑到别的面板上。
function wholeExpressionName(expression) {
  const name = String(expression ?? '').trim().replace(/^\$/, '')
  return name || null
}

// 表达式 target 的解析形状，按 Grafana 的命令语义分派：
// - 'math'：公式，引用只认 $name / ${name}（裸名字是常量或函数，改写会破坏
//   合法表达式）；
// - 'whole'：reduce/resample/threshold，expression 整体是一个输入名；
// - 'scan'：只带 __expr__ 数据源、无显式类型的形状，沿用词法扫描（含裸名）
//   的保守解析——旧盘确实存在这种形状，宁多识别不漏识别。
function expressionShapeOf(query) {
  const type = String(query?.type ?? '')
  if (type === 'math') return 'math'
  if (type === 'reduce' || type === 'resample' || type === 'threshold') return 'whole'
  return 'scan'
}

// 把本面板被改名的 refId 同步进一段表达式文本，返回改写后的文本。
// 按解析出的位置从后往前替换，天然长名优先，也不会碰到函数名与数字。
// includeBare=false 时跳过裸名字（math 语义：裸名字是常量或函数，不是引用）。
function rewriteExpressionText(text, renamed, includeBare = true) {
  if (renamed.size === 0) return String(text ?? '')
  const refs = parseExpressionReferences(text)
  let out = String(text ?? '')
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const ref = refs[index]
    if (!includeBare && ref.kind === 'bare') continue
    const replacement = renamed.get(ref.name)
    if (replacement === undefined) continue
    const rendered = ref.kind === 'braced' ? `\${${replacement}}` : ref.kind === 'dollar' ? `$${replacement}` : replacement
    out = out.slice(0, ref.start) + rendered + out.slice(ref.end)
  }
  return out
}

// 把某个面板内被改名的 refId 同步到该面板表达式 target 的引用里，按表达式形状
// 分派（见 expressionShapeOf）：
// - math：只改写 $name / ${name}；
// - whole（reduce/resample/threshold）：expression 整体命中输入名就整体替换；
// - scan：词法扫描（含裸名）的保守解析。
// 另有 conditions[].query.params：threshold 条件引用的输入 refId 数组（整体相等才换）。
// 只改这两处，其余字段（expr/rawSql 等）不是 refId 引用，一律不动。
function rewriteRefIdReferences(query, renamed) {
  if (typeof query.expression === 'string') {
    const shape = expressionShapeOf(query)
    if (shape === 'whole') {
      const name = wholeExpressionName(query.expression)
      if (name !== null && renamed.has(name)) query.expression = renamed.get(name)
    } else {
      query.expression = rewriteExpressionText(query.expression, renamed, shape !== 'math')
    }
  }
  if (Array.isArray(query.conditions)) {
    for (const condition of query.conditions) {
      const params = condition?.query?.params
      if (!Array.isArray(params)) continue
      for (let index = 0; index < params.length; index += 1) {
        const value = params[index]
        if (typeof value === 'string' && renamed.has(value)) params[index] = renamed.get(value)
      }
    }
  }
}

function refIdOf(target) {
  return typeof target?.refId === 'string' && target.refId ? target.refId : 'A'
}

// 某个表达式 target 依赖的 refId 集合（expression 文本 + 条件参数），按表达式
// 形状分派（见 expressionShapeOf）。按语法提取，不按「本面板已有的目标集合」
// 过滤——A 根本不在本面板时，它同样是缺失的依赖；拿已有集合当白名单会让这条
// 引用悄悄绑到另一个面板的 A 上。
function expressionDependenciesOf(query) {
  const refs = new Set()
  if (typeof query?.expression === 'string' && query.expression.trim()) {
    const shape = expressionShapeOf(query)
    if (shape === 'whole') {
      const name = wholeExpressionName(query.expression)
      if (name !== null) refs.add(name)
    } else {
      for (const ref of parseExpressionReferences(query.expression)) {
        if (shape === 'math' && ref.kind === 'bare') continue
        refs.add(ref.name)
      }
    }
  }
  for (const condition of Array.isArray(query?.conditions) ? query.conditions : []) {
    const params = condition?.query?.params
    if (!Array.isArray(params)) continue
    for (const value of params) if (typeof value === 'string') refs.add(value)
  }
  return refs
}

// 一个面板真正需要发出的 refId：从每个非隐藏 target 出发，沿表达式依赖向上遍历。
// Grafana 的「隐藏查询只参与表达式」是常见写法，而且可以是多级链（A→B→C），
// 所以必须递归——只看一层会把链条上游的隐藏输入漏掉。
function requiredRefIdsOf(targets) {
  const byRefId = new Map()
  for (const target of targets) {
    if (!target || typeof target !== 'object') continue
    if (!byRefId.has(refIdOf(target))) byRefId.set(refIdOf(target), target)
  }
  const required = new Set()
  const queue = targets.filter((target) => target && typeof target === 'object' && target.hide !== true)
  while (queue.length > 0) {
    const target = queue.shift()
    const refId = refIdOf(target)
    if (required.has(refId)) continue
    required.add(refId)
    if (!isExpressionTarget(target)) continue
    for (const name of expressionDependenciesOf(target)) {
      const dependency = byRefId.get(name)
      if (dependency) queue.push(dependency)
    }
  }
  return required
}

// 服务端表达式 target：数据源是 __expr__，或 target 自己带表达式类型。
function isExpressionTarget(target) {
  const type = String(target?.type ?? '')
  if (type === 'math' || type === 'reduce' || type === 'resample' || type === 'threshold') return true
  return Boolean(target?.datasource && typeof target.datasource === 'object' && target.datasource.type === EXPRESSION_DATASOURCE_TYPE)
}

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
    // 每个面板分两遍：先把所有候选 target 编译成待发请求，再统一分配 refId。
    // 分两遍的原因有两个——被跳过的 target 不该占用 refId，而表达式引用必须
    // 在改名确定后一次性改写（见 rewriteRefIdReferences）。
    const targets = Array.isArray(panel.targets) ? panel.targets : []
    // 需要发出的 refId（含被表达式依赖的隐藏输入，多级链一并展开）：Grafana 表达式
    // 按 refId 取依赖，少一条输入它就会静默命中另一面板的同名查询（错误数值）。
    const required = requiredRefIdsOf(targets)
    const pending = []
    for (const target of targets) {
      if (!target || typeof target !== 'object') continue
      const originalRefId = refIdOf(target)
      // 隐藏 target 默认不发；只有被本面板表达式引用时才作为输入带上。
      if (target.hide === true && !required.has(originalRefId)) continue
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
        query = JSON.parse(datasource.type === EXPRESSION_DATASOURCE_TYPE ? raw : interpolateVariablesJson(raw, values, promql ? { promql: true } : undefined))
        // adhoc 条件按数据源类型分发到 target（per-target：ES 拼 lucene、
        // PromQL/LogQL 注入 label matcher、SQL 替换 ${__adhoc} 占位符），
        // 绑定 datasource uid 的 adhoc 变量只作用于匹配的 target。
        applyAdhocFilters(datasource, query, adhocEntries)
      } catch (error) {
        // 单面板替换失败不拖垮整盘：记录并跳过，摘要里说明原因。
        skipTarget(panel, originalRefId, error.message)
        continue
      }
      pending.push({ target, originalRefId, query, datasource, datasourceOrigin })
    }

    // 第二遍：跨面板批量查询时 refId 会撞车，加面板前缀去重（摘要按
    // originalRefId 映射回用户看到的字母）。改名后必须同步改写本面板内的
    // 引用，否则表达式会绑到另一个面板的同名查询上——Grafana 表达式引擎
    // 按 refId 解析依赖，不存在按面板隔离的命名空间。
    const renamed = new Map()
    const localRefIds = new Set()
    for (const item of pending) {
      let refId = item.originalRefId
      if (usedRefIds.has(refId) || localRefIds.has(refId)) {
        refId = `p${panel.id}x${item.originalRefId}`
        let suffix = 2
        while (usedRefIds.has(refId) || localRefIds.has(refId)) {
          refId = `p${panel.id}x${item.originalRefId}_${suffix}`
          suffix += 1
        }
      }
      localRefIds.add(refId)
      usedRefIds.add(refId)
      if (refId !== item.originalRefId) renamed.set(item.originalRefId, refId)
      item.refId = refId
    }
    // 依赖闭包：表达式引用的每条输入都必须在本面板这次请求里。缺一条就跳过该
    // 表达式——留在请求里只会让服务端拿另一面板的同名查询当输入，算出错误的数。
    // 反复收敛到稳定：剔掉一个表达式可能让依赖它的下一级也失效（A→B→C 这类链），
    // 只做一遍会留下断开的引用。
    let ready = pending
    for (let settled = false; !settled;) {
      settled = true
      const available = new Set(ready.map((item) => item.refId))
      for (let index = 0; index < ready.length; index += 1) {
        const item = ready[index]
        if (item.datasource.type !== EXPRESSION_DATASOURCE_TYPE && !isExpressionTarget(item.target)) continue
        const missing = [...expressionDependenciesOf(item.query)]
          .filter((ref) => !available.has(renamed.get(ref) ?? ref))
        if (missing.length === 0) continue
        skipTarget(panel, item.originalRefId, `its input ${missing.map((ref) => JSON.stringify(ref)).join(', ')} is not part of this request (that query is missing, hidden, or was skipped), so this expression would read another panel's query of the same refId`)
        ready = ready.slice(0, index).concat(ready.slice(index + 1))
        settled = false
        break
      }
    }
    for (const item of ready) {
      // 只改写表达式 target：其余 target 的 expression/conditions 不是 refId 引用。
      if (renamed.size > 0 && (item.datasource.type === EXPRESSION_DATASOURCE_TYPE || isExpressionTarget(item.target))) {
        rewriteRefIdReferences(item.query, renamed)
      }
      item.query.refId = item.refId
      shape(item.query, { panel, target: item.target, datasource: item.datasource, refId: item.refId, originalRefId: item.originalRefId })
      queries.push(item.query)
      records.push({ panel, refId: item.refId, originalRefId: item.originalRefId, query: item.query, datasourceOrigin: item.datasourceOrigin })
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
