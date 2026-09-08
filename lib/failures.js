// lib/failures.js — 失败可诊断化：把上游 HTTP 状态码翻译成「下一步该怎么办」。
// 既有报错只透传 Grafana 返回的 message，模型看到 "access denied" 无从下手：既不知道
// 缺哪一条权限、该去哪个源站的哪个设置项，也不知道大盘 uid 是不是压根写错了。这里按
// 状态码补一句可执行诊断，并把 400 的上游原文结构化提取出来——PromQL/LogQL 的语法
// 错误位置、数据源类型不支持的原因都写在里面，那是模型唯一能自行改对查询的线索。
// 诊断文本一律先脱敏再单行清洗：上游正文属于不可信数据，可能夹带换行（伪造输出行）
// 或被回显的凭证。
import { MAX_SOURCE_NAME_CHARS, UPSTREAM_DIAGNOSIS_CHARS } from './constants.js'
import { oneLine, redactSecrets, safeApiErrorDetail } from './util.js'

// detail 由 safeApiErrorDetail 产出，本身已受 300 字符与单行约束；这里按同一上限再
// 清洗一次，使本模块对「调用方直接塞原始正文当 detail」也保持同样的输出保证。
const DETAIL_MAX_CHARS = 300

// 端点 → 该端点所需的 Grafana 权限（service account scope）。按前缀匹配，数组顺序
// 即优先级：更具体的前缀放在能覆盖它的前缀之前。scope 为 null 表示该端点无需鉴权，
// 403 时不指名权限——否则会把维护者引向一条加了也没用的 scope。
// 表内容依 Grafana HTTP API 的权限模型自行整理，只覆盖本插件实际调用的端点。
// 注意 /api/folders/* 不在表内：本插件从不请求它——写入目标文件夹的 uid 取自大盘
// 自身的 meta.folderUid，随 POST /api/dashboards/db 的 body 一起发出，故文件夹相关的
// 403 会以 /api/dashboards/db 的路径出现在这里，诊断为 dashboards:write。
export const ENDPOINT_SCOPES = [
  ['/api/datasources', 'GET', 'datasources:read'],
  ['/api/ds/query', 'POST', 'datasources:query'],
  ['/api/dashboards/uid/', 'GET', 'dashboards:read'],
  ['/api/dashboards/db', 'POST', 'dashboards:write'],
  ['/api/search', 'GET', 'dashboards:read'],
  // 内置 Alertmanager 的 /alerts 读的是告警实例，权限是 alert.instances:read
  // （固定角色 alerting.instances:reader）；alert.rule:read 读的是规则本体，
  // 写错 scope 会把维护者引向一条加了也没用的权限。
  ['/api/alertmanager/grafana/api/v2/alerts', 'GET', 'alert.instances:read'],
  ['/api/v1/provisioning/alert-rules', 'GET', 'alert.provisioning:read'],
  ['/api/health', 'GET', null],
]

export function scopeForEndpoint(path, method) {
  // 去掉查询串再比前缀：/api/search?query=node 与 /api/search 是同一条权限要求。
  const route = String(path ?? '').split('?')[0]
  const verb = String(method ?? 'GET').toUpperCase()
  for (const [prefix, expected, scope] of ENDPOINT_SCOPES) {
    if (verb === expected && route.startsWith(prefix)) return scope
  }
  return null
}

// 400 正文的三种已知形状：Prometheus {status:'error',errorType,error}、
// Loki {message,error}、Grafana 本体 {message}。errorType 与 error 同时在场时拼成
// 「类型: 详情」（类型告诉模型是语法错还是数据错，详情给出出错位置）；否则 error 优先
// 于 message（Loki 把真正的原因放在 error 里，message 只是 "bad request"）。
// 解析失败或字段全缺时返回 null，由调用方回退到通用的受界描述。
function badRequestReason(text) {
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const error = typeof parsed.error === 'string' ? parsed.error.trim() : ''
    const errorType = typeof parsed.errorType === 'string' ? parsed.errorType.trim() : ''
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''
    if (error && errorType) return `${errorType}: ${error}`
    return error || message || null
  } catch {
    return null
  }
}

export function upstreamDiagnosis(status, text) {
  const raw = String(text ?? '')
  // 只对 400 做结构化提取：那是「请求本身写错了」的状态码，正文里有可自修的信息。
  // 其余状态码的正文多是鉴权/路由层的模板文本，结构化提取只会拿到无用的 "error"，
  // 反而把 safeApiErrorDetail 的受界描述给替换掉。
  const picked = Number(status) === 400 ? badRequestReason(raw) : null
  const bounded = oneLine(redactSecrets(picked ?? safeApiErrorDetail(raw)), UPSTREAM_DIAGNOSIS_CHARS)
  return bounded || 'no error details'
}

// 诊断句要点名是哪一台源站的令牌出了问题，否则多源站场景下模型不知道该改哪个凭证。
// 名称缺失时换成不指名的说法，而不是渲染一对空引号。
function tokenPhrase(sourceName) {
  const name = oneLine(sourceName, MAX_SOURCE_NAME_CHARS)
  return name ? `the token for source ${JSON.stringify(name)}` : 'the configured token'
}

// status/method/path/detail 与既有报错的取值一一对应；body 是上游原始正文（可选），
// 只有它能还原 400 的 errorType/error 字段——detail 经 safeApiErrorDetail 收敛后只剩
// status 与 message，Prometheus 的 {status:'error',errorType,error} 会被压成 "error"。
export function translateApiFailure({ status, method, path, detail, body, sourceName } = {}) {
  const code = Number(status)
  const verb = String(method ?? 'GET').toUpperCase()
  const route = String(path ?? '')
  // code 不是有限数时（缺参或调用方传了非数值状态）渲染 unknown，不把 NaN 写进
  // 给人看的错误文案；此时下面所有分支都不命中，走最后一条原样透传。
  const head = `Grafana API ${Number.isFinite(code) ? code : 'unknown'} ${verb} ${route}:`
  // detail 来自上游正文（经 safeApiErrorDetail 收敛），任何状态码都可能把凭证回显
  // 回来，故一律先脱敏再拼进文案；400 分支的 upstreamDiagnosis 已在自身内部脱敏。
  const safe = oneLine(redactSecrets(detail), DETAIL_MAX_CHARS) || 'no error details'
  const who = tokenPhrase(sourceName)

  // 400：诊断取代 detail，因为 detail 恰好丢掉了可修的那部分。
  if (code === 400) {
    return `${head} ${upstreamDiagnosis(400, typeof body === 'string' ? body : detail)}`
  }
  if (code === 401) {
    return `${head} ${safe} — ${who} is missing, expired, or invalid; set it in Settings → Plugins.`
  }
  if (code === 403) {
    const scope = scopeForEndpoint(route, verb)
    return scope
      ? `${head} ${safe} — ${who} lacks the Grafana permission ${scope} (grant it on the service account, or use a token with the Viewer basic role).`
      : `${head} ${safe} — ${who} was refused for this endpoint; grant the permission it needs on the service account, or use a token with the Viewer basic role.`
  }
  // 404：同是「找不到」，大盘 uid 写错与实例根本没开内置告警 API 是两件完全不同的事，
  // 前者要模型改参数重试，后者要模型换一条能力路径。其余路径不追加，避免噪音。
  if (code === 404) {
    const clean = route.split('?')[0]
    if (clean.startsWith('/api/dashboards/uid/')) {
      return `${head} ${safe} — the dashboard uid does not exist on this source.`
    }
    if (clean.startsWith('/api/alertmanager/')) {
      return `${head} ${safe} — this Grafana build does not expose the built-in Alertmanager API (Grafana 9 or newer with unified alerting is required).`
    }
  }
  // 其它状态码（含 5xx、409、412）：前缀与 detail 原样保留，既有断言与人工排查习惯不变。
  return `${head} ${safe}`
}
