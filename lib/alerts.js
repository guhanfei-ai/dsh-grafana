// lib/alerts.js — 告警只读的解析与渲染：把 Grafana 内置 Alertmanager v2 的活跃告警
// 载荷与 provisioning 的规则定义，收敛成有界、单行、可直接读的输出行。
//
// 载荷形状（Grafana 9+ 统一告警）：每条告警是
//   { labels, annotations, status: { state, silencedBy[], inhibitedBy[] },
//     startsAt, endsAt, fingerprint, generatorURL }
// 规则定义是 { uid, title, folderUID, condition, for, labels, annotations, data[] }。
// 解析处处容错：字段缺失或类型不对时降级成占位值而不是抛错——载荷来自上游，一条
// 畸形记录不该让整个工具失败。annotations 与 labels 全部按不可信数据对待：每个
// 写进输出的值都先过 oneLine，压掉换行，免得告警文本伪造出一行输出。
import { SUMMARY_QUERY_KEYS } from './constants.js'
import { oneLine, parseUid } from './util.js'

// 对象字段的宽容取法：上游给成 null / 数组 / 字符串时都退回空对象。
function bag(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// parseUid 对解析不了的输入抛错——那服务的是「用户传错参数要报清楚」的场景。
// 这里是在不可信载荷里逐个探测候选字段，探不到就换下一个，故吞掉异常返回 null。
function uidOr(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  try {
    return parseUid(text)
  } catch {
    return null
  }
}

function namesOf(list) {
  return (Array.isArray(list) ? list : []).map((name) => oneLine(name, 60)).filter(Boolean)
}

function suppressionOf(alert) {
  const status = bag(alert?.status)
  return { silencedBy: namesOf(status.silencedBy), inhibitedBy: namesOf(status.inhibitedBy) }
}

// 活跃告警的三态。静默/抑制优先于 state 字段：AM 会把已被静默的告警仍标成
// firing，而模型要问的是「现在还有没有人在被叫」，两者不一致时以前者为准。
// unprocessed 是 AM 自己的第三态（还没走完抑制判定），如实报出不猜。
export function alertState(alert) {
  const { silencedBy, inhibitedBy } = suppressionOf(alert)
  if (silencedBy.length > 0 || inhibitedBy.length > 0) return 'suppressed'
  const raw = String(bag(alert?.status).state ?? '').trim().toLowerCase()
  return raw === 'firing' || raw === 'suppressed' || raw === 'unprocessed' ? raw : 'unknown'
}

// 大盘 uid 在 AM 载荷里的落点不止一处，且键名随 Grafana 版本漂移（generatorURL /
// generatorsURL；annotations 里的 dashboardUid / __dashboardUid__ / panelURL /
// dashboardURL）。按候选顺序逐个试解析，取第一个能解析出的，全落空返回 null。
const DASHBOARD_UID_KEYS = ['dashboardUid', '__dashboardUid__']
const DASHBOARD_URL_KEYS = ['generatorURL', 'generatorsURL', 'panelURL', 'dashboardURL']

export function alertDashboardUid(alert) {
  const annotations = bag(alert?.annotations)
  for (const key of DASHBOARD_UID_KEYS) {
    const uid = uidOr(annotations[key])
    if (uid) return uid
  }
  for (const key of DASHBOARD_URL_KEYS) {
    const uid = uidOr(alert?.[key]) ?? uidOr(annotations[key])
    if (uid) return uid
  }
  return null
}

// Grafana 把文件夹名放进 labels.grafana_folder；provisioning 规则那边只有
// folderUID，故两段各自取自己能拿到的那个（见 filterAlertRules）。
function alertFolder(alert) {
  return String(bag(alert?.labels).grafana_folder ?? '').trim()
}

// labelContains 的匹配面：labels 与 annotations 两侧的键值全部序列化进一段文本。
// 这里不做单行清洗——它只参与子串匹配，不写进输出。
function searchText(owner) {
  const parts = []
  for (const field of ['labels', 'annotations']) {
    for (const [key, value] of Object.entries(bag(owner?.[field]))) parts.push(`${key}=${value}`)
  }
  return parts.join(' ').toLowerCase()
}

export function filterAlerts(list, { state, folderContains, labelContains, dashboardUid } = {}) {
  const wanted = String(state ?? '').trim().toLowerCase() || 'firing'
  const folder = String(folderContains ?? '').trim().toLowerCase()
  const needle = String(labelContains ?? '').trim().toLowerCase()
  const uid = String(dashboardUid ?? '').trim()
  const rows = []
  for (const alert of Array.isArray(list) ? list : []) {
    if (!alert || typeof alert !== 'object' || Array.isArray(alert)) continue
    if (wanted !== 'all' && alertState(alert) !== wanted) continue
    if (folder && !alertFolder(alert).toLowerCase().includes(folder)) continue
    if (needle && !searchText(alert).includes(needle)) continue
    if (uid && alertDashboardUid(alert) !== uid) continue
    rows.push(alert)
  }
  return rows
}

// 输出行：定长列一律在场（缺值写 ?），只有结构上不适用的两列按需出现——
// silencedBy/inhibitedBy 仅在 suppressed 时有意义，dashboard 仅在载荷里真的
// 带着大盘引用时才有意义。summary 缺失时退回 description：Grafana 告警规则
// 更常写后者，两列都空着会让这一段输出失去大半用处。
export function formatAlertRows(list) {
  return (Array.isArray(list) ? list : []).map((alert) => {
    const labels = bag(alert?.labels)
    const annotations = bag(alert?.annotations)
    const { silencedBy, inhibitedBy } = suppressionOf(alert)
    const uid = alertDashboardUid(alert)
    const name = labels.alertname ?? annotations.alertname ?? ''
    const summary = annotations.summary ?? annotations.description ?? ''
    return [
      `alert ${JSON.stringify(oneLine(name, 120) || '(unnamed alert)')}`,
      `state=${alertState(alert)}`,
      silencedBy.length > 0 ? `silencedBy=${JSON.stringify(oneLine(silencedBy.join(', '), 120))}` : null,
      inhibitedBy.length > 0 ? `inhibitedBy=${JSON.stringify(oneLine(inhibitedBy.join(', '), 120))}` : null,
      `since=${oneLine(alert?.startsAt ?? '', 40) || '?'}`,
      `severity=${oneLine(labels.severity ?? '?', 40) || '?'}`,
      `folder=${JSON.stringify(oneLine(alertFolder(alert) || '?', 60))}`,
      uid ? `dashboard=uid=${uid}` : null,
      `summary=${JSON.stringify(oneLine(summary, 120))}`,
    ].filter((part) => part !== null).join(' ')
  })
}

// 规则定义里的查询文本：data[] 是 Grafana 的查询/条件步骤数组，逐个步骤按
// SUMMARY_QUERY_KEYS 取第一个命中的键（与大盘摘要用的是同一份候选键表）。
export function ruleQueryText(rule) {
  for (const step of Array.isArray(rule?.data) ? rule.data : []) {
    const model = bag(step?.model)
    for (const key of SUMMARY_QUERY_KEYS) {
      const value = model[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return ''
}

// 规则与大盘的关联只可能藏在 data[].model 里（Grafana 生成的查询或条件可能引用
// dashboardUid）。整体序列化后找 uid 子串，比逐个键名猜要稳：键名随版本漂移。
function ruleReferencesDashboard(rule, uid) {
  if (uidOr(bag(rule?.annotations).dashboardUid) === uid) return true
  try {
    return JSON.stringify(Array.isArray(rule?.data) ? rule.data : []).includes(uid)
  } catch {
    return false
  }
}

export function filterAlertRules(list, { folderContains, labelContains, dashboardUid } = {}) {
  const folder = String(folderContains ?? '').trim().toLowerCase()
  const needle = String(labelContains ?? '').trim().toLowerCase()
  const uid = String(dashboardUid ?? '').trim()
  const rows = []
  for (const rule of Array.isArray(list) ? list : []) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue
    // provisioning 只返回 folderUID（不含文件夹名），故同一个 folderContains 在
    // 这一段匹配的是 uid，在活跃告警那一段匹配的是名字。参数描述里写明了这点。
    if (folder && !String(rule.folderUID ?? '').toLowerCase().includes(folder)) continue
    if (needle && !searchText(rule).includes(needle)) continue
    if (uid && !ruleReferencesDashboard(rule, uid)) continue
    rows.push(rule)
  }
  return rows
}

export function formatAlertRuleRows(list) {
  return (Array.isArray(list) ? list : []).map((rule) => [
    `rule uid=${JSON.stringify(oneLine(rule?.uid ?? '', 40) || '?')}`,
    `title=${JSON.stringify(oneLine(rule?.title ?? '', 120))}`,
    `folder=${JSON.stringify(oneLine(rule?.folderUID ?? '', 60) || '?')}`,
    `condition=${oneLine(rule?.condition ?? '', 40) || '?'}`,
    `for=${oneLine(rule?.for ?? '', 20) || '?'}`,
    `query=${JSON.stringify(oneLine(ruleQueryText(rule), 300))}`,
  ].join(' '))
}
