// lib/util.js — 与 Grafana 业务无关的通用纯函数：输入校验、受限 IO 读取、文本清洗与面板遍历。
import { CREDENTIAL_REF_PATTERN, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, UID_PATTERN } from './constants.js'

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

export function combineSignals(parentSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal
}

export async function abortableDelay(ms, signal) {
  if (signal?.aborted) throw signal.reason
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
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

export function requireBoundedText(value, field, maxLength) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${field} is required.`)
  if (text.length > maxLength) throw new Error(`${field} must not exceed ${maxLength} characters.`)
  return text
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
