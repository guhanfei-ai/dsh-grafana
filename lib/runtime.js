// lib/runtime.js — 有状态基础设施：多源站解析、鉴权 HTTP 客户端与写回快照管理。
// activeConfig 以函数引用传入（settings 注入后会被重新赋值），每次调用时取值。
// 源站模型：settings.sources 为权威列表；为空时用 legacy 单源配置合成一个隐式默认
// 源站，保持既有单源行为与迁移前窗口可用。工具经 forSource(resolveSource(arg)) 得到
// 绑定到某一台源站的客户端视图；写快照按 (源站 id, 大盘 uid) 复合键存储，避免跨源站串号。
import {
  APPROVAL_LIVE_TIMEOUT_MS,
  BASE_URL_REF,
  DEFAULT_SOURCE_NAME,
  MAX_SNAPSHOTS,
  REQUEST_TIMEOUT_MS,
  RETRYABLE_STATUS,
  SNAPSHOT_TTL_MS,
  TOKEN_REF,
  UID_PATTERN,
} from './constants.js'
import { translateApiFailure } from './failures.js'
import { abortableDelay, combineSignals, folderUidOf, normalizeBaseUrl, oneLine, readLimitedText, redactSecrets, safeApiErrorDetail, tokenRefForId } from './util.js'

export function createRuntime(ctx, activeConfig) {
  const snapshots = new Map()
  // 审批绑定：宿主对同一次调用复用同一个 exec 对象（pre-execute → execute），
  // 故按 exec 记录审批时解析出的源站；执行时若解析结果与之不符就拒绝写入，
  // 而不是把用户批准过的写入发到另一台源站。只存非敏感的源站标识，不存凭证。
  const approvalBindings = new WeakMap()

  // 生效源站列表：settings.sources 非空时以其为准（逐项补齐派生 tokenRef）；
  // 否则用 legacy 单源字段合成一个隐式默认源站（id=null 标记 legacy）。
  function effectiveSources() {
    const cfg = activeConfig()
    const raw = Array.isArray(cfg.sources) ? cfg.sources : []
    const list = []
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      if (!id || !name) continue
      list.push({
        id,
        name,
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
        tokenRef: (typeof entry.tokenRef === 'string' && entry.tokenRef) ? entry.tokenRef : tokenRefForId(id),
        legacy: false,
      })
    }
    if (list.length > 0) return list
    return [{
      id: null,
      name: DEFAULT_SOURCE_NAME,
      baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
      tokenRef: (typeof cfg.tokenRef === 'string' && cfg.tokenRef) ? cfg.tokenRef : TOKEN_REF,
      legacy: true,
    }]
  }

  // 生效默认源站 id：显式 defaultSource 命中优先，否则唯一源站即默认（隐式源站 id=null）。
  function defaultSourceId(sources) {
    const cfg = activeConfig()
    if (typeof cfg.defaultSource === 'string' && cfg.defaultSource && sources.some((s) => s.id === cfg.defaultSource)) {
      return cfg.defaultSource
    }
    return sources.length === 1 ? sources[0].id : null
  }

  // 按名称（首选）或 id 解析源站；省略时用默认源站。无法确定则抛错并列出可选名称。
  function resolveSource(sourceArg) {
    const sources = effectiveSources()
    const key = String(sourceArg ?? '').trim()
    if (key) {
      const byName = sources.find((s) => s.name === key)
      if (byName) return byName
      const byId = sources.find((s) => s.id === key)
      if (byId) return byId
      const names = sources.map((s) => JSON.stringify(s.name)).join(', ')
      throw new Error(`Unknown Grafana source ${JSON.stringify(key)}. Configured sources: ${names || '(none)'}. Call grafana_sources to list them.`)
    }
    const defaultId = defaultSourceId(sources)
    const def = sources.find((s) => s.id === defaultId)
    if (def) return def
    const names = sources.map((s) => JSON.stringify(s.name)).join(', ')
    throw new Error(`Multiple Grafana sources are configured (${names}) but none is the default and no source was specified. Pass the source name, or set a default in Settings → Plugins.`)
  }

  // 记住审批时解析出的源站。exec 为宿主传给 tools/pre-execute 与工具 execute 的
  // 同一个对象；非对象（测试直接构造的空壳）时跳过绑定，行为与未审批一致。
  function bindApproval(exec, src) {
    if (!exec || typeof exec !== 'object' || !src) return
    approvalBindings.set(exec, { identity: sourceIdentity(src), name: src.name })
  }

  // 写操作的源站解析：审批后到执行前默认源站可能被改掉（另一个设置页、另一次
  // 配置更新）。此时拒绝写入——用户批准的是审批文案里那一台，不是执行时随手
  // 解析到的那一台。
  function resolveApprovedSource(sourceArg, exec) {
    const resolved = resolveSource(sourceArg)
    const bound = exec && typeof exec === 'object' ? approvalBindings.get(exec) : null
    if (!bound) return resolved
    if (bound.identity !== sourceIdentity(resolved)) {
      throw new Error(`The Grafana source this write was approved for has changed: approval named ${JSON.stringify(bound.name)}, the call now resolves to ${JSON.stringify(resolved.name)}. Nothing was written — run the tool again so the approval matches the source it will actually write to.`)
    }
    return resolved
  }

  // 供 grafana_sources 工具列出：附带令牌是否已配（只读布尔，绝不回显明文）与是否默认。
  async function listSources() {
    const sources = effectiveSources()
    const defaultId = defaultSourceId(sources)
    const out = []
    for (const source of sources) {
      let tokenConfigured = false
      try { tokenConfigured = Boolean((await ctx.credentials.resolve(source.tokenRef))?.value) } catch { tokenConfigured = false }
      let baseUrl = source.baseUrl
      if (!baseUrl && source.legacy) {
        try { baseUrl = (await ctx.credentials.resolve(BASE_URL_REF))?.value || '' } catch { baseUrl = '' }
      }
      out.push({ id: source.id, name: source.name, baseUrl, tokenConfigured, isDefault: source.id === defaultId })
    }
    return out
  }

  // 源站身份：id + 地址 + 令牌引用。地址或凭证上下文变了就是另一台（或另一个
  // 身份），旧快照不得继续写回——相同 id/uid/version 并不能证明数据来自同一实例。
  // 只含非敏感字段：URL 与凭证 ref 名，绝不含令牌明文。
  function sourceIdentity(src) {
    return `${src?.id ?? 'legacy'}\u0000${String(src?.baseUrl ?? '')}\u0000${String(src?.tokenRef ?? '')}`
  }

  // 快照复合键：源站身份 + 大盘 uid，避免不同源站（或改址后的同一源站）的同
  // uid 大盘互相覆盖。
  function snapshotKey(src, uid) {
    return `${sourceIdentity(src)}\u0000${uid}`
  }

  // 绑定到单台源站的客户端视图：以下所有方法都作用于 forSource 时确定的 src。
  function forSource(src) {
    async function authHeaders() {
      const result = await ctx.credentials.resolve(src.tokenRef)
      if (!result?.value) {
        throw new Error(`Credential ${src.tokenRef} is not configured for Grafana source ${JSON.stringify(src.name)}. Set it in Settings → Plugins or in the DSH credential store.`)
      }
      return { Authorization: `Bearer ${result.value}` }
    }

    async function resolveBaseUrl() {
      const { allowInsecureHttp } = activeConfig()
      // 源站 baseUrl 为权威源；仅隐式 legacy 源站在其为空时兜底读凭证值（迁移未完成窗口）。
      let raw = src.baseUrl
      if (!raw && src.legacy) {
        const stored = await ctx.credentials.resolve(BASE_URL_REF)
        raw = stored?.value
      }
      return normalizeBaseUrl(raw, allowInsecureHttp)
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

        // 读响应体也在同一超时信号下：服务端返回了头部但 body 流式停滞到超时的
        // 场景，abort 会传导给 body reader——必须在这里转成与 fetch 相同的文案，
        // 否则模型看到的是平台原生 "This operation was aborted"，无从定位。
        let text
        try {
          text = await readLimitedText(response)
        } catch (error) {
          const aborted = signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
          if (aborted) throw new Error(`Grafana API request timed out or was cancelled: ${method} ${path}`)
          throw error
        }
        if (response.ok) {
          if (!text) return null
          // 成功响应必须是 JSON：代理/登录网关常常把 API 请求拦成 HTTP 200 的
          // 登录页，返回原始文本会让调用方把「拦截页」当成写入成功或凭证有效。
          // 无法确认时报错，绝不带着默认值生成成功结论。
          try {
            return JSON.parse(text)
          } catch {
            // 正文来自上游，可能回显请求凭证（拦截页、代理诊断页都会）：与 HTTP
            // 错误正文同一套规则，先脱敏再截断，绝不原样插进错误文案。
            throw new Error(`Grafana API ${method} ${path} returned HTTP ${response.status} with a non-JSON body (${oneLine(redactSecrets(text), 120) || 'empty'}); expected JSON. If this source sits behind a login gateway or proxy, check that API paths reach Grafana unchanged.`)
          }
        }
        if (attempt + 1 < attempts && RETRYABLE_STATUS.has(response.status)) {
          await abortableDelay(200, parentSignal)
          continue
        }
        // 报错文案经 translateApiFailure 按状态码补一句可执行诊断（401/403 指名源站与
        // 缺失权限，400 透传上游可自修的查询错误，404 区分 uid 写错与端点未启用）。
        // 前缀与 detail 的取值与改造前逐字一致，只是尾部追加；body 传原始正文，因为
        // detail 经 safeApiErrorDetail 收敛后已丢掉 400 的 errorType/error 字段。
        throw new Error(translateApiFailure({
          status: response.status,
          method,
          path,
          detail: safeApiErrorDetail(text),
          body: text,
          sourceName: src.name,
        }))
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
        sourceId: src.id,
        sourceName: src.name,
      }
      const key = snapshotKey(src, snapshot.uid)
      snapshots.delete(key)
      snapshots.set(key, snapshot)
      while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value)
      return snapshot
    }

    // 审批文案使用的快照查找：与 execute() 相同的时效判定，过期快照按无快照
    // 处理，保证文案「写回会被拒绝」与实际放行逻辑一致。
    function trustedSnapshotFor(uid) {
      if (!uid) return null
      const snapshot = snapshots.get(snapshotKey(src, uid))
      if (!snapshot || Date.now() - snapshot.fetchedAt > SNAPSHOT_TTL_MS) return null
      return snapshot
    }

    function forgetSnapshot(uid) {
      snapshots.delete(snapshotKey(src, uid))
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
      source: src,
      api,
      authenticatedApi,
      resolveBaseUrl,
      rememberSnapshot,
      trustedSnapshotFor,
      forgetSnapshot,
      liveDashboardCheck,
    }
  }

  return {
    resolveSource,
    resolveApprovedSource,
    bindApproval,
    listSources,
    forSource,
  }
}
