// lib/runtime.js — 有状态基础设施：配置解析、鉴权 HTTP 客户端与写回快照管理。
// activeConfig 以函数引用传入（settings 注入后会被重新赋值），每次调用时取值。
import {
  APPROVAL_LIVE_TIMEOUT_MS,
  BASE_URL_REF,
  MAX_SNAPSHOTS,
  REQUEST_TIMEOUT_MS,
  RETRYABLE_STATUS,
  SNAPSHOT_TTL_MS,
  UID_PATTERN,
} from './constants.js'
import { abortableDelay, combineSignals, folderUidOf, normalizeBaseUrl, readLimitedText, safeApiErrorDetail } from './util.js'

export function createRuntime(ctx, activeConfig) {
  const snapshots = new Map()

  async function authHeaders() {
    const { tokenRef } = activeConfig()
    const result = await ctx.credentials.resolve(tokenRef)
    if (!result?.value) {
      throw new Error(`Credential ${tokenRef} is not configured. Set it in Settings → Plugins or in the DSH credential store.`)
    }
    return { Authorization: `Bearer ${result.value}` }
  }

  async function resolveBaseUrl() {
    const { allowInsecureHttp, baseUrl } = activeConfig()
    // settings.baseUrl 为权威源；凭证值仅在迁移未完成时兜底。
    const stored = await ctx.credentials.resolve(BASE_URL_REF)
    return normalizeBaseUrl(baseUrl || stored?.value, allowInsecureHttp)
  }

  async function api(path, init = {}, parentSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
    const baseUrl = await resolveBaseUrl()
    const method = String(init.method ?? 'GET').toUpperCase()
    const attempts = method === 'GET' ? 2 : 1

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const signal = combineSignals(parentSignal, timeoutMs)
      let response
      try {
        response = await fetch(`${baseUrl}${path}`, { ...init, redirect: 'error', signal })
      } catch (error) {
        const aborted = signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
        if (aborted) throw new Error(`Grafana API request timed out or was cancelled: ${method} ${path}`)
        if (attempt + 1 < attempts) {
          await abortableDelay(200, parentSignal)
          continue
        }
        throw new Error(`Grafana API request failed: ${method} ${path}: ${error?.message ?? String(error)}`)
      }

      const text = await readLimitedText(response)
      if (response.ok) {
        if (!text) return null
        try { return JSON.parse(text) } catch { return text }
      }
      if (attempt + 1 < attempts && RETRYABLE_STATUS.has(response.status)) {
        await abortableDelay(200, parentSignal)
        continue
      }
      throw new Error(`Grafana API ${response.status} ${method} ${path}: ${safeApiErrorDetail(text)}`)
    }
    throw new Error(`Grafana API request failed unexpectedly: ${method} ${path}`)
  }

  async function authenticatedApi(path, init = {}, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
    return api(path, { ...init, headers: { ...(init.headers ?? {}), ...(await authHeaders()) } }, signal, timeoutMs)
  }

  function rememberSnapshot(dashboard, meta) {
    if (!dashboard || typeof dashboard !== 'object' || !UID_PATTERN.test(String(dashboard.uid ?? ''))) {
      throw new Error('Grafana returned a dashboard without a valid UID.')
    }
    if (!Number.isInteger(dashboard.id) || dashboard.id < 1) throw new Error('Grafana returned a dashboard without a valid existing-dashboard id.')
    if (!Number.isInteger(dashboard.version) || dashboard.version < 0) throw new Error('Grafana returned a dashboard without a valid version number.')
    // 审批文案专用字段：标题与文件夹名清洗换行并截断到 100 字符；
    // folderTitle 缺失时用 folderUid 兜底，两个字段都保存（P3：显示文件夹名）。
    const folderUid = folderUidOf(meta)
    const folderTitle = (typeof meta?.folderTitle === 'string' ? meta.folderTitle : '')
      .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100)
    const snapshot = {
      id: dashboard.id,
      uid: dashboard.uid,
      version: dashboard.version,
      canSave: meta?.canSave,
      fetchedAt: Date.now(),
      title: (typeof dashboard.title === 'string' ? dashboard.title : '')
        .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100),
      folderUid,
      folderTitle: folderTitle || folderUid,
    }
    snapshots.delete(snapshot.uid)
    snapshots.set(snapshot.uid, snapshot)
    while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value)
    return snapshot
  }

  // 审批文案使用的快照查找：与 execute() 相同的时效判定，过期快照按无快照
  // 处理，保证文案「写回会被拒绝」与实际放行逻辑一致。
  function trustedSnapshotFor(uid) {
    if (!uid) return null
    const snapshot = snapshots.get(uid)
    if (!snapshot || Date.now() - snapshot.fetchedAt > SNAPSHOT_TTL_MS) return null
    return snapshot
  }

  function forgetSnapshot(uid) {
    snapshots.delete(uid)
  }

  // 审批弹窗前的实时复核（学 dsh-jumpserver 删除命令过滤规则的做法）：
  // 独立约 5 秒超时；失败不阻断审批，只在文案中注明无法确认。
  async function liveDashboardCheck(uid) {
    try {
      const current = await authenticatedApi(`/api/dashboards/uid/${encodeURIComponent(uid)}`, {}, AbortSignal.timeout(APPROVAL_LIVE_TIMEOUT_MS))
      if (!current || typeof current !== 'object' || !current.dashboard || !current.meta) return { ok: false }
      return { ok: true, current }
    } catch {
      return { ok: false }
    }
  }

  return {
    api,
    authenticatedApi,
    resolveBaseUrl,
    rememberSnapshot,
    trustedSnapshotFor,
    forgetSnapshot,
    liveDashboardCheck,
  }
}
