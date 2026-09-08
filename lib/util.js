// lib/util.js — 与 Grafana 业务无关的通用纯函数：输入校验、受限 IO 读取、文本清洗与面板遍历。
import { CREDENTIAL_REF_PATTERN, MAX_RESPONSE_BYTES, MAX_SOURCE_NAME_CHARS, REQUEST_TIMEOUT_MS, TOKEN_REF_PREFIX, UID_PATTERN } from './constants.js'

export function parseUid(input) {
  const value = String(input ?? '').trim()
  if (UID_PATTERN.test(value)) return value
  const match = value.match(/\/d\/([A-Za-z0-9_-]+)/)
  if (match && UID_PATTERN.test(match[1])) return match[1]
  throw new Error(`Cannot parse a Grafana dashboard UID from ${JSON.stringify(value)}. Use a 1-40 character UID or a /d/<uid>/<slug> URL.`)
}

export function normalizeBaseUrl(input, allowInsecureHttp = true) {
  const value = String(input ?? '').trim()
  if (!value) throw new Error('Grafana base URL is not configured. Set it in Settings → Plugins or provide baseUrl in the plugin configuration.')

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Grafana base URL must be an absolute HTTP(S) URL.')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Grafana base URL must use https:// or http://.')
  if (url.username || url.password) throw new Error('Grafana base URL must not contain embedded credentials.')
  if (url.search || url.hash) throw new Error('Grafana base URL must not contain a query string or fragment.')

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && !loopback && !allowInsecureHttp) {
    throw new Error('Plain HTTP is disabled for non-loopback Grafana hosts. Use HTTPS or explicitly set allowInsecureHttp: true.')
  }
  return url.toString().replace(/\/+$/, '')
}

export function byteLength(value) {
  return new TextEncoder().encode(value).byteLength
}

export function validateCredentialRef(ref) {
  if (!CREDENTIAL_REF_PATTERN.test(ref)) throw new Error(`Invalid credential reference: ${JSON.stringify(ref)}`)
  return ref
}

// 源站 id：全球唯一、系统生成、只读。优先 crypto.randomUUID（Node 20+ / 安全上下文
// 浏览器），退化到 getRandomValues 拼装 v4 UUID，再退化到时间+随机串（仍足够唯一）。
export function generateSourceId() {
  const c = globalThis.crypto
  if (c?.randomUUID) return String(c.randomUUID())
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// 由源站 id 派生令牌凭证 ref：剥离横线等非法字符后加固定前缀（保证以字母开头，
// 满足 CREDENTIAL_REF_PATTERN）。同一 id 恒定映射到同一 ref，改名不影响令牌。
export function tokenRefForId(id) {
  const clean = String(id ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64)
  return validateCredentialRef(`${TOKEN_REF_PREFIX}${clean}`)
}

// 源站名称：必填、非空、限长；trim 后返回（唯一性由调用方按集合校验）。
export function normalizeSourceName(name) {
  const value = String(name ?? '').trim()
  if (!value) throw new Error('Each Grafana source must have a non-empty name.')
  if (value.length > MAX_SOURCE_NAME_CHARS) throw new Error(`Grafana source name must not exceed ${MAX_SOURCE_NAME_CHARS} characters.`)
  return value
}

export function combineSignals(parentSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal
}

export async function abortableDelay(ms, signal) {
  // 宿主可能以非 Error 值 abort（signal.reason 为字符串等），统一包成 Error，
  // 不让裸值穿透到只预期 Error 的调用方。
  const reasonOf = (s) => (s?.reason instanceof Error ? s.reason : new Error(String(s?.reason ?? 'aborted')))
  if (signal?.aborted) throw reasonOf(signal)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(reasonOf(signal))
    }, { once: true })
  })
}

export async function readLimitedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    // 提前拒绝时主动释放响应体，避免连接挂到超时才关闭。
    try { await response.body?.cancel?.() } catch { /* 释放失败忽略即可 */ }
    throw new Error(`Grafana response is too large (${contentLength} bytes; limit ${maxBytes} bytes).`)
  }

  if (!response.body?.getReader) {
    const text = await response.text()
    if (byteLength(text) > maxBytes) throw new Error(`Grafana response exceeds the ${maxBytes}-byte limit.`)
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`Grafana response exceeds the ${maxBytes}-byte limit.`)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export function safeApiErrorDetail(text) {
  try {
    const parsed = JSON.parse(text)
    const values = [parsed?.status, parsed?.message].filter((value) => typeof value === 'string')
    if (values.length > 0) return values.join(': ').replace(/[\r\n\t]+/g, ' ').slice(0, 300)
  } catch {
    // 解析失败时回退为受长度限制的单行描述。
  }
  return String(text).replace(/[\r\n\t]+/g, ' ').slice(0, 300) || 'no error details'
}

export function textOut(value) {
  return [{ type: 'text', text: String(value) }]
}

// 上游错误正文可能把凭证回显回来（例如把 Authorization 头原样打印进 message），
// 因此诊断透传前必须先脱敏：压掉 Bearer 令牌、Grafana 服务账户令牌（glsa_）与
// OAuth 客户端令牌（glc_），以及长度 ≥ 20 的连续 base64 形态串。正常 PromQL/LogQL
// 文本不会被误伤——标识符被下划线、点号与括号切成短段，凑不出 20 字符连续串。
const SECRET_PATTERNS = [
  /Bearer\s+\S+/gi,
  /\bglsa_[A-Za-z0-9_-]+/g,
  /\bglc_[A-Za-z0-9_-]+/g,
  /\b[A-Za-z0-9+/]{20,}={0,2}/g,
]

export function redactSecrets(text) {
  let out = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

export function requireBoundedText(value, field, maxLength) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${field} is required.`)
  if (text.length > maxLength) throw new Error(`${field} must not exceed ${maxLength} characters.`)
  return text
}

// requireBoundedText 的整数版：观测工具的数值参数（采样点数、series 上限、行数上限）
// 共用这一句带上下限的报错，免得一边写 "must be" 一边写 "should be"。小数与字符串
// 一律拒绝：静默取整会让模型以为自己请求的采样密度生效了。类型完全不对（把 60
// 传成 "60"）在到达这里之前已被工具框架的 schema 校验拦下，两层各管一段。
export function requireBoundedInteger(value, field, min, max, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`)
  }
  return value
}

export function folderUidOf(meta) {
  return typeof meta?.folderUid === 'string' ? meta.folderUid : ''
}

export function folderLabel(title, uid) {
  const name = String(title ?? '').trim() || String(uid ?? '').trim() || 'General'
  return JSON.stringify(name)
}

// 审批文案单行清洗：压掉换行/制表符并截断，防止 JSON 内容伪造审批行。
export function oneLine(value, maxLength) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength)
}

export function flattenPanels(dashboard) {
  const byId = new Map()
  const walk = (panels) => {
    if (!Array.isArray(panels)) return
    for (const panel of panels) {
      if (!panel || typeof panel !== 'object' || Array.isArray(panel)) continue
      if (Number.isInteger(panel.id)) byId.set(panel.id, panel)
      // row 面板内嵌的 panels 一并展开，避免嵌套改动漏报。
      if (Array.isArray(panel.panels)) walk(panel.panels)
    }
  }
  walk(dashboard?.panels)
  return byId
}
