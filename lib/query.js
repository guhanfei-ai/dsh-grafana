// lib/query.js — 查询与摘要纯函数：URL/时间解析、模板变量插值、查询结果统计摘要、大盘结构摘要。
import {
  ADHOC_DATASOURCE_SUPPORT_TEXT,
  ADHOC_OPERATORS,
  DEFAULT_DATASOURCE_UID,
  ELASTICSEARCH_DATASOURCE_TYPE,
  LOKI_DATASOURCE_TYPE,
  MAX_FRAMES_PER_QUERY,
  MAX_QUERY_SUMMARY_LINES,
  MAX_SUMMARY_LINES,
  OVERRIDABLE_VARIABLE_TYPES,
  PROMETHEUS_DATASOURCE_TYPE,
  RELATIVE_TIME_PATTERN,
  SQL_DATASOURCE_TYPES,
  SUMMARY_QUERY_KEYS,
  TIMESTAMP_PATTERN,
  VARIABLE_FORMAT_CLAUSE_PATTERN,
  VARIABLE_FORMATS,
  VARIABLE_PATTERN,
} from './constants.js'
import { flattenPanels, folderLabel, folderUidOf, oneLine, parseUid } from './util.js'

export function isValidTimeInput(value) {
  const text = String(value ?? '').trim()
  return RELATIVE_TIME_PATTERN.test(text) || TIMESTAMP_PATTERN.test(text)
}

// 在 parseUid 之外解析浏览器 URL 的查询参数：viewPanel（面板视图）与
// from/to 时间范围。解析不出的参数直接忽略，不报错。
export function parseDashboardUrl(input) {
  const value = String(input ?? '').trim()
  const result = { uid: parseUid(value), viewPanel: null, from: '', to: '' }
  let url
  try {
    url = new URL(value)
  } catch {
    // 裸 UID 或非法 URL：uid 已由 parseUid 校验，其余参数无从解析。
    return result
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return result
  const viewPanel = url.searchParams.get('viewPanel')
  if (viewPanel !== null) {
    // 新版 Grafana scenes 的面板视图地址用 panel-<id>，两种形态都兼容。
    const match = String(viewPanel).match(/^(?:panel-)?(\d+)$/)
    if (match) result.viewPanel = Number(match[1])
  }
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (from && isValidTimeInput(from)) result.from = from.trim()
  if (to && isValidTimeInput(to)) result.to = to.trim()
  return result
}

// 规范化 adhoc filters：校验形状、统一输出 [{ key, operator, value, condition: 'AND' }]。
export function normalizeAdhocFilters(input, variableName) {
  if (!Array.isArray(input)) {
    throw new Error(`adhoc filters for variable "${variableName}" are invalid: expected an array, got ${typeof input}`)
  }
  const result = []
  for (let i = 0; i < input.length; i++) {
    const item = input[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`adhoc filters for variable "${variableName}" are invalid: item at index ${i} is not an object`)
    }
    const key = item.key
    if (typeof key !== 'string' || !key) {
      throw new Error(`adhoc filters for variable "${variableName}" are invalid: item at index ${i} has missing or empty "key"`)
    }
    const operator = item.operator
    if (typeof operator !== 'string' || !ADHOC_OPERATORS.has(operator)) {
      throw new Error(`adhoc filters for variable "${variableName}" are invalid: item at index ${i} has unsupported operator ${JSON.stringify(operator)}`)
    }
    const value = item.value
    if (typeof value !== 'string') {
      throw new Error(`adhoc filters for variable "${variableName}" are invalid: item at index ${i} has non-string "value"`)
    }
    result.push({ key, operator, value, condition: 'AND' })
  }
  return result
}

// Lucene 字段名安全字符：字母数字与 . _ @ -（覆盖 ES 常见字段名，其余拒绝，
// 避免拼出语法被注入或解析歧义）。
const LUCENE_FIELD_PATTERN = /^[A-Za-z0-9_.@-]+$/
// 范围比较仅接受纯数字值（lucene 的 field:>N 语法不支持任意字符串）。
const LUCENE_NUMERIC_PATTERN = /^-?\d+(?:\.\d+)?$/

// Lucene 值转义：双引号包裹，内部 " 与 \ 转义。
function luceneQuoted(value) {
  return `"${String(value).replace(/["\\]/g, (ch) => `\\${ch}`)}"`
}

// 单个 adhoc filter → lucene 条件片段。无法安全映射时抛错，绝不静默忽略：
// `=` → field:"value"；`!=` → NOT field:"value"；`>`/`<` 仅支持数字值；
// `=~`/`!~` → Lucene 正则 field:/pattern/（值内 `/` 转义为 \/；Lucene 正则
// 隐式全串匹配且不支持 \d 等简写，语法错误由 Elasticsearch 显式报错）。
export function adhocFilterToLucene(filter) {
  if (!LUCENE_FIELD_PATTERN.test(filter.key)) {
    throw new Error(`adhoc filter key ${JSON.stringify(filter.key)} cannot be safely mapped to a Lucene query (allowed characters: letters, digits, dot, underscore, at, hyphen)`)
  }
  const key = filter.key
  switch (filter.operator) {
    case '=':
      return `${key}:${luceneQuoted(filter.value)}`
    case '!=':
      return `NOT ${key}:${luceneQuoted(filter.value)}`
    case '>':
    case '<': {
      const numeric = String(filter.value).trim()
      if (!LUCENE_NUMERIC_PATTERN.test(numeric)) {
        throw new Error(`adhoc filter ${key} ${filter.operator} ${JSON.stringify(filter.value)} cannot be mapped to a Lucene query: range comparison only supports numeric values`)
      }
      return `${key}:${filter.operator}${numeric}`
    }
    case '=~':
    case '!~': {
      const pattern = String(filter.value)
      if (!pattern.trim()) {
        throw new Error(`adhoc filter ${key} ${filter.operator} "" cannot be mapped to a Lucene query: the regex pattern is empty`)
      }
      const escaped = pattern.replace(/\//g, '\\/')
      return `${filter.operator === '!~' ? 'NOT ' : ''}${key}:/${escaped}/`
    }
    default:
      throw new Error(`adhoc filter operator ${JSON.stringify(filter.operator)} is not supported for Lucene query expansion in grafana_query (supported: = != numeric > < and regex =~ !~)`)
  }
}

// 计算对指定数据源生效的 adhoc filters（绑定语义：__expr__ 恒空；
// boundUid 为 null（未绑定）或与 datasource.uid 匹配时全部生效）。
export function applicableAdhocFilters(datasource, adhocEntries) {
  if (datasource.type === '__expr__') return []
  const filters = []
  for (const entry of adhocEntries) {
    if (entry.boundUid === null || entry.boundUid === datasource.uid) {
      for (const filter of entry.filters) filters.push(filter)
    }
  }
  return filters
}

// 为 ES 数据源把生效的 adhoc filters 展开为 lucene 条件串（per-target 方案，
// 保证条件真正进入 ES 查询）。无生效条件返回 ''；仅对 ES 语义负责，
// 数据源类型合法性由 applyAdhocFilters 分发器判定。
export function adhocLuceneClause(datasource, adhocEntries) {
  const filters = applicableAdhocFilters(datasource, adhocEntries)
  if (filters.length === 0) return ''
  return filters.map((filter) => adhocFilterToLucene(filter)).join(' AND ')
}

// 把 adhoc 生成的 lucene 条件合并进 ES target 的查询串：原串非空时用括号
// 包裹再 AND（保证语义不受原串中的 OR/NOT 影响）；Grafana 7+ 的 lucene 串在
// target.query，旧版 target.lucene；两者都不是字符串时明确报错。
export function mergeLuceneClause(query, clause) {
  for (const key of ['query', 'lucene']) {
    if (typeof query[key] === 'string') {
      const trimmed = query[key].trim()
      query[key] = trimmed ? `(${trimmed}) AND ${clause}` : clause
      return
    }
  }
  if (query.query !== undefined || query.lucene !== undefined) {
    throw new Error('cannot apply adhoc filters: the Elasticsearch target query field is not a Lucene string')
  }
  query.query = clause
}

// SQL 字段名安全字符：字母数字下划线且不以数字开头（覆盖常见列名，其余拒绝，
// 避免拼出 SQL 片段注入）。值统一单引号字面量，内部 ' 翻倍转义。
const SQL_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// 单个 adhoc filter → SQL 条件片段（Grafana SQL adhoc 惯例）：
// `=` → key = 'v'；`!=` → key <> 'v'；`>`/`<` 仅数字（裸数字比较）；
// `=~`/`!~` → LIKE/NOT LIKE '%v%'（Grafana 对 SQL 正则运算符的标准映射）。
export function adhocFilterToSql(filter) {
  if (!SQL_FIELD_PATTERN.test(filter.key)) {
    throw new Error(`adhoc filter key ${JSON.stringify(filter.key)} cannot be safely mapped to SQL (allowed: letters, digits, underscore; must start with a letter or underscore)`)
  }
  const quoted = (value) => `'${String(value).replace(/'/g, "''")}'`
  switch (filter.operator) {
    case '=':
      return `${filter.key} = ${quoted(filter.value)}`
    case '!=':
      return `${filter.key} <> ${quoted(filter.value)}`
    case '>':
    case '<': {
      const numeric = String(filter.value).trim()
      if (!LUCENE_NUMERIC_PATTERN.test(numeric)) {
        throw new Error(`adhoc filter ${filter.key} ${filter.operator} ${JSON.stringify(filter.value)} cannot be mapped to SQL: range comparison only supports numeric values`)
      }
      return `${filter.key} ${filter.operator} ${numeric}`
    }
    case '=~':
      return `${filter.key} LIKE ${quoted(`%${filter.value}%`)}`
    case '!~':
      return `${filter.key} NOT LIKE ${quoted(`%${filter.value}%`)}`
    default:
      throw new Error(`adhoc filter operator ${JSON.stringify(filter.operator)} is not supported for SQL expansion in grafana_query`)
  }
}

// PromQL/LogQL 标签名：字母数字下划线且不以数字开头。
const LABEL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// 单个 adhoc filter → label matcher 片段：`=`/`!=`/`=~`/`!~` 直接映射
// （正则运算符在 PromQL/LogQL 里原生支持）；`>`/`<` 无法用 label matcher
// 表达数值比较，显式报错。
export function adhocFilterToLabelMatcher(filter) {
  if (!LABEL_NAME_PATTERN.test(filter.key)) {
    throw new Error(`adhoc filter key ${JSON.stringify(filter.key)} cannot be safely mapped to a label matcher (allowed: letters, digits, underscore; must start with a letter or underscore)`)
  }
  const quoted = `"${String(filter.value).replace(/["\\]/g, (ch) => `\\${ch}`)}"`
  switch (filter.operator) {
    case '=':
      return `${filter.key}=${quoted}`
    case '!=':
      return `${filter.key}!=${quoted}`
    case '=~':
      return `${filter.key}=~${quoted}`
    case '!~':
      return `${filter.key}!~${quoted}`
    default:
      throw new Error(`adhoc filter operator ${JSON.stringify(filter.operator)} is not supported for label matchers in grafana_query (supported: = != =~ !~; label selectors cannot express numeric range comparisons)`)
  }
}

// PromQL 保留字：运算符与聚合/匹配修饰词（其后不跟 '(' 的裸标识符若非保留字
// 则视为 metric selector）。start/end 只以函数形式出现，由函数判定覆盖。
const PROMQL_KEYWORDS = new Set([
  'and', 'or', 'unless', 'atan2', 'bool', 'offset',
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
])
// 这些保留字后面的 (...) 是标签名列表（by (a, b) / on (x) group_left (y)），
// 其中的裸标识符不是 metric selector，不得注入 matcher。
const PROMQL_LABEL_LIST_KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
])

// 向查询串的每个 vector selector / stream selector 注入 label matchers。
// transformBareIdentifiers：PromQL 需要把裸 metric 名补上 {matchers} 并向
// 既有 {...} 追加；LogQL 的裸标识符是 pipeline 阶段（json/logfmt 等），
// 只处理 {...} stream selector，不碰裸标识符。
// 保守策略：字符串字面量、$ 前缀内建变量（$__rate_interval / ${__interval}）、
// 数字/时长后缀、函数名与保留字一律不动；括号不配平/花括号不配平直接抛错。
function insertLabelMatchers(expr, matchers, transformBareIdentifiers) {
  let out = ''
  let i = 0
  const n = expr.length
  let braceDepth = 0
  let parenDepth = 0
  let labelListParenDepth = 0
  let lastIdentifier = ''
  // 记录 depth-0 选择器 `{` 的输出起点，闭合时判断括号体是否为空。
  const selectorStack = []
  const prevNonSpaceChar = () => {
    for (let k = out.length - 1; k >= 0; k -= 1) {
      if (!/\s/.test(out[k])) return out[k]
    }
    return ''
  }
  while (i < n) {
    const ch = expr[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < n && expr[j] !== quote) {
        if (expr[j] === '\\') j += 1
        j += 1
      }
      if (j >= n) throw new Error('cannot apply adhoc filters: unterminated string literal in the query')
      out += expr.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '#') {
      // PromQL/LogQL 行注释。
      let j = expr.indexOf('\n', i)
      if (j === -1) j = n
      out += expr.slice(i, j)
      i = j
      continue
    }
    if (ch === '{') {
      // `${__var}` 形态的内建变量占位不是选择器。
      if (braceDepth === 0 && prevNonSpaceChar() !== '$') {
        selectorStack.push(out.length + 1)
      }
      braceDepth += 1
      out += ch
      i += 1
      continue
    }
    if (ch === '}') {
      braceDepth -= 1
      if (braceDepth < 0) throw new Error('cannot apply adhoc filters: unbalanced braces in the query')
      if (braceDepth === 0 && selectorStack.length > 0) {
        const bodyStart = selectorStack.pop()
        const body = out.slice(bodyStart).trim()
        out += (body ? ',' : '') + matchers + '}'
        i += 1
        continue
      }
      out += ch
      i += 1
      continue
    }
    if (ch === '(') {
      parenDepth += 1
      if (labelListParenDepth === 0 && PROMQL_LABEL_LIST_KEYWORDS.has(lastIdentifier)) {
        labelListParenDepth = parenDepth
      }
      out += ch
      i += 1
      continue
    }
    if (ch === ')') {
      if (labelListParenDepth === parenDepth) labelListParenDepth = 0
      parenDepth -= 1
      out += ch
      i += 1
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < n && /[A-Za-z0-9_:]/.test(expr[j])) j += 1
      const ident = expr.slice(i, j)
      let k = j
      while (k < n && /\s/.test(expr[k])) k += 1
      const nextCh = k < n ? expr[k] : ''
      const prev = prevNonSpaceChar()
      // 数字/时长后缀（5m、1e3）、$ 变量名（$__rate_interval）不是 metric。
      // `$` 紧贴的标识符是内建变量占位，同样不注入。
      const attachedToPreviousToken = prev !== '' && (/[A-Za-z0-9_.:]/.test(prev) || prev === '$')
      // 聚合函数签名：sum by (...) / avg without (...) —— 后随 by/without 的是函数不是 metric。
      let nextWord = ''
      if (/[A-Za-z_]/.test(nextCh)) {
        let m = k
        while (m < n && /[A-Za-z0-9_]/.test(expr[m])) m += 1
        nextWord = expr.slice(k, m)
      }
      const followedByAggregationClause = nextWord === 'by' || nextWord === 'without'
      if (
        transformBareIdentifiers &&
        braceDepth === 0 &&
        labelListParenDepth === 0 &&
        !attachedToPreviousToken &&
        nextCh !== '(' &&
        !followedByAggregationClause &&
        !PROMQL_KEYWORDS.has(ident)
      ) {
        if (nextCh === '{') {
          // 已有选择器，matcher 由 '{' 分支在闭合 '}' 前注入。
          out += ident
        } else {
          out += `${ident}{${matchers}}`
        }
        lastIdentifier = ident
        i = j
        continue
      }
      lastIdentifier = ident
      out += ident
      i = j
      continue
    }
    if (/\S/.test(ch)) lastIdentifier = ''
    out += ch
    i += 1
  }
  if (braceDepth !== 0) throw new Error('cannot apply adhoc filters: unbalanced braces in the query')
  return out
}

// SQL target：把 ${__adhoc} / $__adhoc 占位符替换为生成的条件串
// （Grafana SQL 数据源消费 adhoc 的标准方式）。缺占位符时明确报错，
// 禁止静默忽略生效的过滤条件。
const SQL_ADHOC_PLACEHOLDER_PATTERN = /\$\{__adhoc\}|\$__adhoc/g

function applyAdhocToSqlTarget(query, filters) {
  if (typeof query.rawSql !== 'string') {
    throw new Error('cannot apply adhoc filters: the SQL target has no rawSql string')
  }
  const clause = filters.map((filter) => adhocFilterToSql(filter)).join(' AND ')
  if (!/\$\{__adhoc\}|\$__adhoc/.test(query.rawSql)) {
    throw new Error('cannot apply adhoc filters: the SQL query does not contain the ${__adhoc} placeholder (add it to the WHERE clause, or clear the adhoc variable)')
  }
  query.rawSql = query.rawSql.replace(SQL_ADHOC_PLACEHOLDER_PATTERN, clause)
}

// adhoc 条件按数据源类型分发应用（per-target，就地修改 query）：
// - elasticsearch：拼进 lucene 查询串（query/lucene 字段）；
// - prometheus：label matcher 注入每个 vector selector（含裸 metric 名）；
// - loki：label matcher 注入每个 stream selector（{...}，不动 pipeline 阶段）；
// - SQL 类：替换 rawSql 里的 ${__adhoc} 占位符；
// - 其余类型：显式报错并给出支持矩阵。__expr__ 恒跳过。
export function applyAdhocFilters(datasource, query, adhocEntries) {
  const filters = applicableAdhocFilters(datasource, adhocEntries)
  if (filters.length === 0) return
  const type = datasource.type
  if (type === ELASTICSEARCH_DATASOURCE_TYPE) {
    const clause = filters.map((filter) => adhocFilterToLucene(filter)).join(' AND ')
    mergeLuceneClause(query, clause)
    return
  }
  if (type === PROMETHEUS_DATASOURCE_TYPE || type === LOKI_DATASOURCE_TYPE) {
    if (typeof query.expr !== 'string') {
      throw new Error(`cannot apply adhoc filters: the ${type} target has no expr string`)
    }
    const matchers = filters.map((filter) => adhocFilterToLabelMatcher(filter)).join(',')
    query.expr = insertLabelMatchers(query.expr, matchers, type === PROMETHEUS_DATASOURCE_TYPE)
    return
  }
  if (SQL_DATASOURCE_TYPES.has(type)) {
    applyAdhocToSqlTarget(query, filters)
    return
  }
  throw new Error(`adhoc filters are not supported for datasource type "${type}" in grafana_query. Supported: ${ADHOC_DATASOURCE_SUPPORT_TEXT}.`)
}

// target 是否携带可执行的查询内容。row 面板（布局容器）在保存时会残留
// {datasource, refId} 形状的空 target——Grafana UI 从不执行 row 的 target，
// 但它们若被原样发给 /api/ds/query，Prometheus 会因空 expr 报 400
// "no expression found in input"。判定规则：
// - 字符串键（SUMMARY_QUERY_KEYS）：非空 trim 后算有内容（ES 的 lucene 串
//   允许为空串，但 empty 串可由 metrics/bucketAggs 兜底）；
// - 聚合数组：elasticsearch 的 metrics/bucketAggs（Lucene 串合法为空）、
//   __expr__ threshold 的 conditions。
export function targetHasQueryPayload(target) {
  for (const key of SUMMARY_QUERY_KEYS) {
    const value = target?.[key]
    if (typeof value === 'string' && value.trim()) return true
    if (typeof value === 'number' && Number.isFinite(value)) return true
  }
  for (const key of ['metrics', 'bucketAggs', 'conditions']) {
    if (Array.isArray(target?.[key]) && target[key].length > 0) return true
  }
  return false
}

// 发请求前的整体预校验（绑定感知）：对将被查询的每种数据源 dry-run 一遍
// 翻译，无法映射直接整工具报错，绝不带病发请求、绝不静默忽略。
export function validateAdhocFiltersForDatasource(datasource, adhocEntries) {
  const filters = applicableAdhocFilters(datasource, adhocEntries)
  if (filters.length === 0) return
  const type = datasource.type
  if (type === ELASTICSEARCH_DATASOURCE_TYPE) {
    for (const filter of filters) adhocFilterToLucene(filter)
  } else if (type === PROMETHEUS_DATASOURCE_TYPE || type === LOKI_DATASOURCE_TYPE) {
    for (const filter of filters) adhocFilterToLabelMatcher(filter)
  } else if (SQL_DATASOURCE_TYPES.has(type)) {
    for (const filter of filters) adhocFilterToSql(filter)
  } else {
    throw new Error(`adhoc filters are not supported for datasource type "${type}" in grafana_query. Supported: ${ADHOC_DATASOURCE_SUPPORT_TEXT}.`)
  }
}

// /api/datasources 列表 → 索引：uid / 旧版数据源名 → {type, uid}，另记默认数据源。
// 服务账号无 datasources:read 权限时调用方拿到 null，走原 uid 透传路径。
export function buildDatasourceIndex(list) {
  const byUid = new Map()
  const byName = new Map()
  let defaultEntry = null
  for (const ds of Array.isArray(list) ? list : []) {
    if (!ds || typeof ds !== 'object' || typeof ds.uid !== 'string' || !ds.uid) continue
    if (typeof ds.type !== 'string' || !ds.type) continue
    const entry = { type: ds.type, uid: ds.uid }
    byUid.set(ds.uid, entry)
    if (typeof ds.name === 'string' && ds.name) byName.set(ds.name, entry)
    if (ds.isDefault === true && !defaultEntry) defaultEntry = entry
  }
  return { byUid, byName, defaultEntry }
}

// uid 引用 datasource 型模板变量（$datasource / ${datasource} 整体引用）：
// 保存值可能是 uid 字符串、"default"、或 {type, uid} 对象（不同版本 Grafana 形状不一）。
function expandDatasourceVariableUid(uid, values) {
  const match = uid.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/)
  if (!match) return { uid: interpolateVariables(uid, values), type: undefined }
  const name = match[1] ?? match[2]
  const value = values.get(name)
  if (value === undefined) {
    throw new Error(`Unresolved Grafana template variable ${JSON.stringify(name)} referenced by the panel datasource uid. Pass it via the variables argument.`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.uid === 'string' && value.uid.trim()) {
      return {
        uid: value.uid.trim(),
        type: typeof value.type === 'string' && value.type.trim() ? value.type.trim() : undefined,
      }
    }
    throw new Error(`datasource variable ${JSON.stringify(name)} has a value that cannot be used as a datasource reference: ${oneLine(JSON.stringify(value), 60)}`)
  }
  if (typeof value === 'string' && value.trim()) return { uid: value.trim(), type: undefined }
  if (typeof value === 'number') return { uid: String(value), type: undefined }
  throw new Error(`datasource variable ${JSON.stringify(name)} has value ${JSON.stringify(value)} which cannot be used as a datasource uid`)
}

// 把面板/目标的数据源引用解析为 /api/ds/query 需要的 {type, uid}。支持三类形状：
// - {type, uid}：现代格式（uid 可引用 $datasource 变量）；
// - {uid}：缺 type 的引用（datasource 型模板变量的典型产物）；
// - 纯字符串：旧版大盘的 uid（或数据源名）引用。
// 解析失败抛带原因的错误（调用方记录为面板级 skip）；索引查不到类型时返回
// passthrough 形状（{uid} 原样透传，由 Grafana 自行解析）。
export function resolveDatasourceRef(ref, values, index) {
  let uid
  let type
  if (typeof ref === 'string') {
    uid = ref.trim()
    if (!uid) throw new Error('the panel datasource is an empty string')
  } else if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
    if (typeof ref.type === 'string' && ref.type.trim()) type = ref.type.trim()
    if (typeof ref.uid !== 'string' || !ref.uid.trim()) {
      throw new Error(`the panel datasource object ${oneLine(JSON.stringify(ref), 60)} has no uid`)
    }
    uid = ref.uid.trim()
  } else {
    throw new Error('the panel has no datasource reference')
  }
  if (uid.startsWith('$')) {
    const expanded = expandDatasourceVariableUid(uid, values)
    uid = expanded.uid
    type = type ?? expanded.type
  }
  // Grafana 保留伪 uid "default"：映射到索引中 isDefault 的数据源（/api/ds/query
  // 不接受 "default"，直发会 404）。
  if (uid === DEFAULT_DATASOURCE_UID && index?.defaultEntry) {
    uid = index.defaultEntry.uid
    type = type ?? index.defaultEntry.type
  }
  if (type) return { datasource: { type, uid }, passthrough: false }
  const found = index ? (index.byUid.get(uid) ?? index.byName.get(uid)) : null
  if (found) return { datasource: { type: found.type, uid: found.uid }, passthrough: false }
  // 索引不可用（权限）或查无此源：带原 uid 透传。实测 Grafana 对裸 uid 能自行
  // 解析；若 uid 无效会返回明确的 404/400 错误，绝不静默。
  return { datasource: { uid }, passthrough: true }
}

export function variableValuesOf(dashboard, overrides) {
  const values = new Map()
  const variableTypes = new Map()
  const variableIndex = new Map()
  const list = Array.isArray(dashboard?.templating?.list) ? dashboard.templating.list : []
  for (const variable of list) {
    if (!variable || typeof variable !== 'object' || typeof variable.name !== 'string' || !variable.name) continue
    variableIndex.set(variable.name, variable)
    const type = typeof variable.type === 'string' ? variable.type : ''
    variableTypes.set(variable.name, type)
    if (type === 'adhoc') {
      // Grafana 10 把 adhoc 保存态存在 variable.filters；旧版本/部分导出用
      // current.value。两者都兼容，filters 优先。
      const raw = Array.isArray(variable.filters) ? variable.filters : variable.current?.value
      if (Array.isArray(raw) && raw.length > 0) {
        values.set(variable.name, normalizeAdhocFilters(raw, variable.name))
      } else {
        values.set(variable.name, [])
      }
    } else if (variable.current?.value !== undefined && variable.current.value !== null) {
      values.set(variable.name, variable.current.value)
    }
  }
  // 参数覆盖校验与赋值（先校验再写入，整工具直接失败）。
  if (overrides && typeof overrides === 'object') {
    for (const [name, value] of Object.entries(overrides)) {
      if (!variableIndex.has(name)) {
        throw new Error(`Variable "${name}" does not exist on this dashboard. Available variables: ${[...variableIndex.keys()].join(', ') || '(none)'}`)
      }
      const type = variableTypes.get(name)
      if (!OVERRIDABLE_VARIABLE_TYPES.has(type)) {
        throw new Error(`Variable "${name}" has type "${type}" which is not supported for override. Supported types: ${[...OVERRIDABLE_VARIABLE_TYPES].join(', ')}`)
      }
      if (type === 'adhoc') {
        values.set(name, normalizeAdhocFilters(value, name))
      } else if (type === 'datasource') {
        // datasource 型变量按数据源 uid 覆盖（字符串或 {uid} 对象），
        // 会插值进面板 datasource 引用，实现整盘切换数据源。
        if (typeof value === 'string' && value.trim()) {
          values.set(name, value.trim())
        } else if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.uid === 'string' && value.uid.trim()) {
          values.set(name, value.uid.trim())
        } else {
          throw new Error(`Variable "${name}" is a datasource variable; override it with a datasource uid string (or {"uid": "..."} object), got ${oneLine(JSON.stringify(value) ?? String(value), 60)}`)
        }
      } else {
        values.set(name, value)
      }
    }
  }
  // 构建 scopedVars：Grafana ScopedVar 形状 { [name]: { text, value } }。
  const scopedVars = {}
  for (const [name, value] of values) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null && 'key' in value[0]) {
      scopedVars[name] = {
        text: value.map((f) => `${f.key} ${f.operator} ${f.value}`).join(' AND '),
        value,
      }
    } else if (Array.isArray(value)) {
      scopedVars[name] = { text: value.map(String).join(','), value }
    } else {
      scopedVars[name] = { text: String(value), value }
    }
  }
  return { values, scopedVars }
}

// 正则特殊字符转义（Grafana :regex 格式语义：值按字面量参与正则）。
function escapeRegexChars(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Lucene 特殊字符转义（Grafana :lucene 格式语义）。
function escapeLuceneChars(value) {
  return String(value).replace(/[+\-!(){}[\]^"~*?:\\]/g, '\\$&')
}

// adhoc 变量值不能作文本插值（无文本语义），统一在此报错。
function assertNotAdhocValue(name, value) {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null && 'key' in value[0]) {
    throw new Error(`Variable "${name}" is an adhoc filter variable and cannot be interpolated as text. Adhoc filters are applied to query filters directly, not through string substitution.`)
  }
}

// 按 Grafana 标准格式修饰符把变量值展开为文本。单值变量的默认路径
// （无修饰符）保持逐字节等价于 String(value)；多值默认逗号连接。
// 未知格式在 interpolateVariables 入口统一报错，此处只处理已校验格式。
function formatVariableValue(name, value, format) {
  assertNotAdhocValue(name, value)
  const parts = Array.isArray(value) ? value.map(String) : [String(value)]
  switch (format) {
    case undefined:
    case 'csv':
      return parts.join(',')
    case 'raw':
      // 无格式化：单值原样，多值逗号连接（与 Grafana raw 一致）。
      return parts.join(',')
    case 'pipe':
      return parts.join('|')
    case 'doublequote':
      return parts.map((part) => `"${part}"`).join(',')
    case 'singlequote':
      return parts.map((part) => `'${part}'`).join(',')
    case 'sqlstring':
      // 单引号包裹，内部 ' 翻倍转义（Grafana :sqlstring 语义，防注入）。
      return parts.map((part) => `'${part.replace(/'/g, "''")}'`).join(',')
    case 'json':
      return JSON.stringify(Array.isArray(value) ? parts : parts[0])
    case 'percent':
      return parts.map((part) => encodeURIComponent(part)).join(',')
    case 'querystring':
      return parts.map((part) => `${name}=${encodeURIComponent(part)}`).join('&')
    case 'regex':
      return parts.map(escapeRegexChars).join('|')
    case 'lucene':
      return parts.map(escapeLuceneChars).join(' ')
    default:
      throw new Error(`Unsupported Grafana variable format ${JSON.stringify(`:${format}`)}. Supported formats: ${[...VARIABLE_FORMATS].join(', ')}.`)
  }
}

// 模板变量替换：处理 ${var} / ${var:format} / $var 三种形式；$__interval 等
// 全局内建变量原样透传，由 Grafana/数据源根据请求时间范围自行计算。
// ${var:format} 按 Grafana 标准格式展开（csv/doublequote/singlequote/json/raw/
// pipe/percent/querystring/regex/lucene/sqlstring），未知格式显式报错。
// 替换后残留非内建变量同样报错。
export function interpolateVariables(input, values) {
  return interpolateVariablesImpl(String(input ?? ''), values, false)
}

// JSON 文本内的变量替换（target JSON 整体替换路径专用）：替换值按 JSON 字符串
// 规则转义（\ 与 " 等），否则 regex/lucene 等格式产生的反斜杠会让 JSON.parse
// 回读失败（"Bad escaped character"）。普通字符串路径不受影响。
// options.promql：Prometheus/Loki target 专用——裸 $var 的多值渲染为 (a|b)
// （Grafana Prometheus 插件语义：label matcher 里的多值必须是正则或形式）。
export function interpolateVariablesJson(input, values, options) {
  return interpolateVariablesImpl(String(input ?? ''), values, true, options)
}

function jsonEscapeText(text) {
  return JSON.stringify(text).slice(1, -1)
}

function interpolateVariablesImpl(text, values, jsonEscape, options) {
  const promql = options?.promql === true
  // 先统一校验全部 ${var:...} 形状：内建（__ 前缀）透传；用户变量的格式
  // 修饰符必须在支持列表内，否则显式报错（包括空格式与非字母格式）。
  for (const match of text.matchAll(VARIABLE_FORMAT_CLAUSE_PATTERN)) {
    const [, name, format] = match
    if (name.startsWith('__')) continue
    if (!VARIABLE_FORMATS.has(format)) {
      throw new Error(`Unsupported Grafana variable format ${JSON.stringify(`{${name}:${format}}`)}. Supported formats: ${[...VARIABLE_FORMATS].join(', ')}. Pass a plain value via the variables argument instead.`)
    }
  }
  const substituted = text.replace(VARIABLE_PATTERN, (match, braced, bracedFormat, bare) => {
    const name = braced ?? bare
    if (name.startsWith('__')) return match
    const value = values.get(name)
    if (value === undefined) return match
    let formatted
    if (promql && bracedFormat === undefined && Array.isArray(value) && value.length > 1) {
      // 多值裸引用在 label matcher 里必须是 (a|b) 形式（逗号连接在 =~"..." 内
      // 是字面逗号，会静默匹配不到任何序列）。值保持原样不转义：PromQL 双引号
      // 字符串里 \. 是非法转义（需 \\.），Grafana 自身渲染多值 matcher 时同样
      // 不转义；需要精确匹配时用显式 ${var:regex} 修饰符。
      assertNotAdhocValue(name, value)
      formatted = `(${value.map((item) => String(item)).join('|')})`
    } else {
      formatted = formatVariableValue(name, value, bracedFormat)
    }
    return jsonEscape ? jsonEscapeText(formatted) : formatted
  })
  const leftover = substituted.match(/\$\{?(?!__)([A-Za-z_][A-Za-z0-9_]*)/)
  if (leftover) {
    throw new Error(`Unresolved Grafana template variable ${JSON.stringify(leftover[1])}. Pass it via the variables argument.`)
  }
  return substituted
}

function formatNumber(value) {
  return String(Number(value.toPrecision(4)))
}

function numericStats(values) {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let count = 0
  let last = null
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    min = Math.min(min, value)
    max = Math.max(max, value)
    sum += value
    last = value
    count += 1
  }
  if (count === 0) return null
  return { min, max, avg: sum / count, last }
}

function recentPoints(values, timeIndex, labelIndex, numberIndex, count) {
  const times = timeIndex >= 0 && Array.isArray(values[timeIndex]) ? values[timeIndex] : null
  const labels = labelIndex >= 0 && Array.isArray(values[labelIndex]) ? values[labelIndex] : null
  const numbers = values[numberIndex]
  const entries = []
  for (let index = numbers.length - 1; index >= 0 && entries.length < count; index -= 1) {
    const value = numbers[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    // 时序帧用时间做标签；表格帧（terms 聚合等）用键列做标签，
    // 桶名是排行榜类面板的核心数据，不能退化成 "?"。
    let key = '?'
    if (times && typeof times[index] === 'number') key = new Date(times[index]).toISOString().slice(11, 19)
    else if (labels && labels[index] !== undefined && labels[index] !== null) key = oneLine(String(labels[index]), 40)
    entries.push(`${key}=${formatNumber(value)}`)
  }
  return entries.join(' ')
}

function frameLabel(frame) {
  const fields = Array.isArray(frame?.schema?.fields) ? frame.schema.fields : []
  const withLabels = fields.find((field) => field?.labels && typeof field.labels === 'object')
  if (withLabels) {
    const pairs = Object.entries(withLabels.labels).map(([key, value]) => `${key}=${value}`)
    if (pairs.length > 0) return oneLine(pairs.join(', '), 80)
  }
  const name = typeof frame?.schema?.name === 'string' ? frame.schema.name.trim() : ''
  return name ? oneLine(name, 80) : '(unnamed series)'
}

function summarizeFrame(frame) {
  const fields = Array.isArray(frame?.schema?.fields) ? frame.schema.fields : []
  const values = Array.isArray(frame?.data?.values) ? frame.data.values : []
  const pointCount = Array.isArray(values[0]) ? values[0].length : 0
  const label = JSON.stringify(frameLabel(frame))
  const numberIndex = fields.findIndex((field) => field?.type === 'number')
  const timeIndex = fields.findIndex((field) => field?.type === 'time')
  // 表格帧的键列：第一个既非时间也非数值的字段列（如 terms 聚合的桶名列）。
  let labelIndex = -1
  for (let index = 0; index < fields.length; index += 1) {
    if (index === timeIndex || index === numberIndex) continue
    if (Array.isArray(values[index])) {
      labelIndex = index
      break
    }
  }
  if (numberIndex >= 0 && Array.isArray(values[numberIndex])) {
    const stats = numericStats(values[numberIndex])
    if (!stats) return `${label}: ${pointCount} points (no numeric values)`
    // 表格帧（terms 聚合等，无时间列但有键列）：桶名是核心数据，不能退化成
    // "(unnamed series) N pts"。按桶逐条展示头部桶（terms 聚合默认按值降序，
    // 从头部取即最大桶），并用键列字段名说明分组维度。
    if (timeIndex < 0 && labelIndex >= 0) {
      const labelName = typeof fields[labelIndex]?.name === 'string' && fields[labelIndex].name ? fields[labelIndex].name : 'key'
      const base = label === '"(unnamed series)"' ? 'table' : label
      const entries = []
      for (let index = 0; index < values[numberIndex].length && entries.length < 5; index += 1) {
        const value = values[numberIndex][index]
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        const bucket = values[labelIndex][index]
        if (bucket === undefined || bucket === null) continue
        entries.push(`${oneLine(String(bucket), 40)}=${formatNumber(value)}`)
      }
      return `${base} by ${labelName}: ${pointCount} rows, min=${formatNumber(stats.min)} max=${formatNumber(stats.max)} last=${formatNumber(stats.last)}${entries.length > 0 ? `; top: ${entries.join(', ')}` : ''}`
    }
    const recent = recentPoints(values, timeIndex, labelIndex, numberIndex, 3)
    return `${label}: ${pointCount} pts, min=${formatNumber(stats.min)} max=${formatNumber(stats.max)} avg=${formatNumber(stats.avg)} last=${formatNumber(stats.last)}${recent ? `; recent: ${recent}` : ''}`
  }
  // 非数值帧（日志、表格等）：行数 + 末值截断展示。
  const firstColumn = values.find(Array.isArray)
  const lastValue = firstColumn && firstColumn.length > 0 ? oneLine(firstColumn[firstColumn.length - 1], 60) : ''
  return `${label}: ${pointCount} rows${lastValue ? `, last=${JSON.stringify(lastValue)}` : ''}`
}

// 纯函数：按面板分组产出有界的数据摘要；单条查询报错不影响其余。
// records: [{ panel, refId, originalRefId }]；results 来自 /api/ds/query 响应。
export function summarizeFrames(records, results) {
  const lines = []
  let currentPanel = null
  for (const record of records) {
    if (record.panel !== currentPanel) {
      currentPanel = record.panel
      const title = oneLine(record.panel.title ?? '', 60)
      lines.push(title ? `panel id=${record.panel.id} ${JSON.stringify(title)}:` : `panel id=${record.panel.id}:`)
    }
    // 降级逐面板重试后仍失败的面板：逐条记录失败，不影响其余。
    if (record.failed) {
      lines.push(`  query ${record.originalRefId}: failed: ${record.failed}`)
      continue
    }
    const result = results && typeof results === 'object' ? results[record.refId] : null
    if (result?.error) {
      lines.push(`  query ${record.originalRefId}: failed: ${oneLine(result.error, 150)}`)
      continue
    }
    const frames = Array.isArray(result?.frames) ? result.frames : []
    if (frames.length === 0) {
      lines.push(`  query ${record.originalRefId}: no data`)
      continue
    }
    const shown = frames.slice(0, MAX_FRAMES_PER_QUERY)
    for (const frame of shown) lines.push(`  query ${record.originalRefId}: ${summarizeFrame(frame)}`)
    if (frames.length > shown.length) lines.push(`  query ${record.originalRefId}: …${frames.length - shown.length} more series not shown`)
  }
  if (lines.length > MAX_QUERY_SUMMARY_LINES) {
    const hidden = lines.length - MAX_QUERY_SUMMARY_LINES
    return [...lines.slice(0, MAX_QUERY_SUMMARY_LINES), `…${hidden} more line(s) not shown.`]
  }
  return lines
}

// 大盘结构摘要：只保留解读所需的骨架（面板、查询、阈值、变量），降低超大
// 盘 JSON 的上下文成本；只读输出，不记录写快照。
export function dashboardSummary(dashboard, meta) {
  const lines = []
  lines.push(`dashboard uid=${dashboard.uid} ${JSON.stringify(oneLine(dashboard.title ?? '', 100))} version=${dashboard.version} folder=${folderLabel(meta?.folderTitle, folderUidOf(meta))}`)
  const templating = Array.isArray(dashboard.templating?.list) ? dashboard.templating.list : []
  const variables = templating
    .filter((variable) => variable && typeof variable === 'object' && typeof variable.name === 'string' && variable.name)
    .map((variable) => `${variable.name}(${oneLine(variable.type ?? '?', 20)})`)
  if (variables.length > 0) lines.push(`variables: ${variables.join(', ')}`)

  for (const panel of flattenPanels(dashboard).values()) {
    const title = oneLine(panel.title ?? '', 60)
    lines.push(title
      ? `panel id=${panel.id} ${JSON.stringify(title)} type=${oneLine(panel.type ?? '?', 30)}`
      : `panel id=${panel.id} type=${oneLine(panel.type ?? '?', 30)}`)
    const datasource = panel.datasource
    if (datasource && typeof datasource === 'object') {
      lines.push(`  datasource: ${oneLine(datasource.type ?? '?', 40)} uid=${oneLine(datasource.uid ?? '?', 40)}`)
    } else if (typeof datasource === 'string') {
      lines.push(`  datasource: ${oneLine(datasource, 80)}`)
    }
    for (const target of Array.isArray(panel.targets) ? panel.targets : []) {
      if (!target || typeof target !== 'object' || target.hide === true) continue
      const text = SUMMARY_QUERY_KEYS.map((key) => target[key]).find((value) => typeof value === 'string' && value.trim())
      if (!text) continue
      const refId = typeof target.refId === 'string' && target.refId ? target.refId : 'A'
      lines.push(`  query ${refId}: ${oneLine(text, 300)}`)
    }
    const steps = panel.fieldConfig?.defaults?.thresholds?.steps
    if (Array.isArray(steps) && steps.length > 0) {
      const rendered = steps.map((step) => `${step?.value ?? 'base'}=${oneLine(step?.color ?? '?', 20)}`).join(', ')
      lines.push(`  thresholds: ${oneLine(rendered, 120)}`)
    }
    const overrideCount = Array.isArray(panel.fieldConfig?.overrides) ? panel.fieldConfig.overrides.length : 0
    if (overrideCount > 0) lines.push(`  overrides: ${overrideCount} rule(s)`)
  }

  if (lines.length > MAX_SUMMARY_LINES) {
    const hidden = lines.length - MAX_SUMMARY_LINES
    return [...lines.slice(0, MAX_SUMMARY_LINES), `…${hidden} more line(s) not shown.`].join('\n')
  }
  return lines.join('\n')
}
