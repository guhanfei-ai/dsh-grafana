// lib/tools/misc.js — 辅助工具：grafana_search（检索大盘）与 grafana_health（连通性自检）。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { TOOL_TIMEOUT_MS } from '../constants.js'
import { textOut } from '../util.js'

export function defineGrafanaSearchTool(rt) {
  return defineTool({
    name: 'grafana_search',
    description: 'Search Grafana dashboards by title text and optional tag. Returns at most 50 untrusted result rows.',
    parameters: {
      query: { type: 'string', description: 'Optional title query.' },
      tag: { type: 'string', description: 'Optional exact dashboard tag.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const params = new URLSearchParams({ type: 'dash-db', limit: '50' })
      if (args.query?.trim()) params.set('query', args.query.trim())
      if (args.tag?.trim()) params.set('tag', args.tag.trim())
      const rows = await rt.authenticatedApi(`/api/search?${params.toString()}`, {}, exec.signal)
      if (!Array.isArray(rows) || rows.length === 0) return '(no dashboards found)'
      return rows.slice(0, 50).map((row) => `uid=${JSON.stringify(row.uid)} title=${JSON.stringify(row.title)} url=${JSON.stringify(row.url)}`).join('\n')
    },
  })
}

export function defineGrafanaHealthTool(rt) {
  return defineTool({
    name: 'grafana_health',
    description: 'Check Grafana connectivity and validate the configured service-account credential.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(_args, exec) {
      // Grafana 的 /api/health 返回 { commit, database, version }，没有 status
      // 字段；database 才是健康状态（ok / failing）。
      const health = await rt.api('/api/health', {}, exec.signal)
      const rows = await rt.authenticatedApi('/api/search?type=dash-db&limit=3', {}, exec.signal)
      return `health=${health?.database ?? 'unknown'}; credential=valid; sampleDashboards=${Array.isArray(rows) ? rows.length : '?'}`
    },
  })
}
