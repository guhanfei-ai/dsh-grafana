// lib/tools/misc.js — 辅助工具：grafana_search（检索大盘）、grafana_status（连通性自检）
// 与 grafana_sources（列出已配置的多源站）。search/status 接受可选 source 指定目标源站；
// grafana_sources 只读、无审批，供模型在按名称选源前发现可用源站名。
// 末尾的 grafana_health 是 0.12.0 改名后保留的旧名转发 stub：只报错并指向新名。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { budgetLine, createBudget } from '../budget.js'
import { MAX_SEARCH_ROWS, SOURCE_PARAM, TOOL_TIMEOUT_MS } from '../constants.js'
import { textOut } from '../util.js'

export function defineGrafanaSearchTool(rt) {
  return defineTool({
    name: 'grafana_search',
    description: 'Search Grafana dashboards by title text and optional tag. Returns at most 50 untrusted result rows. Grafana serves /api/search in pages of the requested limit, so when the first page comes back full a second page is fetched to learn how many results exist past the cap; anything dropped is disclosed on a final budget line, which states plainly when the follow-up page itself could not be fetched.',
    parameters: {
      query: { type: 'string', description: 'Optional title query.' },
      tag: { type: 'string', description: 'Optional exact dashboard tag.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      const searchUrl = (page) => {
        const params = new URLSearchParams({ type: 'dash-db', limit: String(MAX_SEARCH_ROWS), page: String(page) })
        if (args.query?.trim()) params.set('query', args.query.trim())
        if (args.tag?.trim()) params.set('tag', args.tag.trim())
        return `/api/search?${params.toString()}`
      }
      const rows = await srt.authenticatedApi(searchUrl(1), {}, exec.signal)
      if (!Array.isArray(rows) || rows.length === 0) return '(no dashboards found)'
      const shown = rows.slice(0, MAX_SEARCH_ROWS)
      const lines = shown.map((row) => `uid=${JSON.stringify(row.uid)} title=${JSON.stringify(row.title)} url=${JSON.stringify(row.url)}`)
      const budget = createBudget()
      if (rows.length > MAX_SEARCH_ROWS) {
        // 防御：不合契约的超限单页（真实服务端按 limit 截断响应）仍如实披露。
        budget.spend(rows.length - shown.length, 'dashboard(s)', shown.length)
      } else if (rows.length === MAX_SEARCH_ROWS) {
        // 满页：/api/search 的 limit 是页大小而非总量上限，真实服务端会先把响应
        // 截到 limit，本地永远看不到第 51 条——只有取第二页才知道有没有丢弃、
        // 丢了多少。探测失败时如实说「未能确认」，不假装恰好一页。
        let hidden = null
        try {
          const next = await srt.authenticatedApi(searchUrl(2), {}, exec.signal)
          hidden = Array.isArray(next) ? next.length : 0
        } catch (error) {
          // 宿主取消或工具级超时（exec.signal 已 abort）不得被探测降级吞掉：
          // 调用方既然要求停止，就必须收到取消失败，而不是一份看起来完整的
          // 部分结果。探测自身的故障（超时、5xx）才是可容忍的降级。
          if (exec?.signal?.aborted) throw error
          hidden = null
        }
        if (hidden === null) {
          lines.push(`budget: ${MAX_SEARCH_ROWS} of ${MAX_SEARCH_ROWS}+ dashboard(s) shown; more may be hidden — the follow-up page could not be fetched (raise limit to include them)`)
        } else if (hidden >= MAX_SEARCH_ROWS) {
          // 第二页也满页：总数至少两页，继续翻页没有上限，披露为下界。
          lines.push(`budget: ${MAX_SEARCH_ROWS} of ${MAX_SEARCH_ROWS + hidden}+ dashboard(s) shown; ${hidden}+ hidden (raise limit to include them)`)
        } else if (hidden > 0) {
          budget.spend(hidden, 'dashboard(s)', MAX_SEARCH_ROWS)
        }
        // hidden === 0：总数恰好一页，无丢弃、无披露行。
      }
      const note = budgetLine(budget)
      if (note) lines.push(note)
      return lines.join('\n')
    },
  })
}

export function defineGrafanaStatusTool(rt) {
  return defineTool({
    name: 'grafana_status',
    description: 'Check Grafana connectivity and validate the configured service-account credential for one source.',
    parameters: {
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      // Grafana 的 /api/health 返回 { commit, database, version }，没有 status
      // 字段；database 才是健康状态（ok / failing）。
      const health = await srt.api('/api/health', {}, exec.signal)
      const rows = await srt.authenticatedApi('/api/search?type=dash-db&limit=3', {}, exec.signal)
      return `health=${health?.database ?? 'unknown'}; credential=valid; sampleDashboards=${Array.isArray(rows) ? rows.length : '?'}`
    },
  })
}

export function defineGrafanaSourcesTool(rt) {
  return defineTool({
    name: 'grafana_sources',
    description: 'List the configured Grafana sources: each source name, its read-only UID, base URL, whether its token is configured, and which one is the default. Use it to discover valid source names before calling other grafana tools with the source argument. Read-only; never returns token values.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute() {
      const sources = await rt.listSources()
      if (sources.length === 0) return '(no Grafana sources configured)'
      return sources.map((s) => [
        `${s.isDefault ? '(default) ' : ''}name=${JSON.stringify(s.name)}`,
        `uid=${JSON.stringify(s.id ?? '')}`,
        `url=${JSON.stringify(s.baseUrl || '(not set)')}`,
        `token=${s.tokenConfigured ? 'configured' : 'missing'}`,
      ].join(' ')).join('\n')
    },
  })
}

// 旧名转发 stub：0.12.0 把 grafana_health 改名为 grafana_status。存量会话与自定义
// prompt 仍可能按旧名调用——宿主对未注册工具的报错不指路，模型会停在原地反复重试；
// 这里注册一个只报错的同名 stub，把新名写进报错，模型一跳即可自愈。stub 不发请求、
// 不进审批门（写操作判定只匹配 push/clone）、不记快照，也无需 runtime。
export function defineGrafanaHealthAliasTool() {
  return defineTool({
    name: 'grafana_health',
    description: 'Deprecated name, do not call: grafana_health was renamed to grafana_status in 0.12.0 (same parameters, same output). This stub exists only so existing sessions learn the new name; every call fails with a pointer to it.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    async execute() {
      throw new Error('grafana_health was renamed to grafana_status in 0.12.0. The parameters and output are unchanged — call grafana_status with the same arguments.')
    },
  })
}
