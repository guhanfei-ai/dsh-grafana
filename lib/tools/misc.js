// lib/tools/misc.js — 辅助工具：grafana_search（检索大盘）、grafana_status（连通性自检）
// 与 grafana_sources（列出已配置的多源站）。search/status 接受可选 source 指定目标源站；
// grafana_sources 只读、无审批，供模型在按名称选源前发现可用源站名。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { TOOL_TIMEOUT_MS } from '../constants.js'
import { textOut } from '../util.js'

const SOURCE_PARAM = { type: 'string', description: 'Optional Grafana source name (call grafana_sources to list configured sources); omit to use the default source.' }

export function defineGrafanaSearchTool(rt) {
  return defineTool({
    name: 'grafana_search',
    description: 'Search Grafana dashboards by title text and optional tag. Returns at most 50 untrusted result rows.',
    parameters: {
      query: { type: 'string', description: 'Optional title query.' },
      tag: { type: 'string', description: 'Optional exact dashboard tag.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      const params = new URLSearchParams({ type: 'dash-db', limit: '50' })
      if (args.query?.trim()) params.set('query', args.query.trim())
      if (args.tag?.trim()) params.set('tag', args.tag.trim())
      const rows = await srt.authenticatedApi(`/api/search?${params.toString()}`, {}, exec.signal)
      if (!Array.isArray(rows) || rows.length === 0) return '(no dashboards found)'
      return rows.slice(0, 50).map((row) => `uid=${JSON.stringify(row.uid)} title=${JSON.stringify(row.title)} url=${JSON.stringify(row.url)}`).join('\n')
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
