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
    description: 'Search Grafana dashboards by title text and optional tag. Returns at most 50 untrusted result rows; anything dropped past the cap is disclosed on a final budget line.',
    parameters: {
      query: { type: 'string', description: 'Optional title query.' },
      tag: { type: 'string', description: 'Optional exact dashboard tag.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      const params = new URLSearchParams({ type: 'dash-db', limit: String(MAX_SEARCH_ROWS) })
      if (args.query?.trim()) params.set('query', args.query.trim())
      if (args.tag?.trim()) params.set('tag', args.tag.trim())
      const rows = await srt.authenticatedApi(`/api/search?${params.toString()}`, {}, exec.signal)
      if (!Array.isArray(rows) || rows.length === 0) return '(no dashboards found)'
      const shown = rows.slice(0, MAX_SEARCH_ROWS)
      const lines = shown.map((row) => `uid=${JSON.stringify(row.uid)} title=${JSON.stringify(row.title)} url=${JSON.stringify(row.url)}`)
      if (rows.length > shown.length) {
        const budget = createBudget()
        budget.spend(rows.length - shown.length, 'dashboard(s)', shown.length)
        const note = budgetLine(budget)
        if (note) lines.push(note)
      }
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
