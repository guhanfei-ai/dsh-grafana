// dsh-grafana — Grafana 大盘编辑插件
// 流程：用户贴大盘 URL → AI 用 grafana_get 拉 JSON → 对话微调 → grafana_push 写回 → 用户刷新
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'grafana'
export const inject = ['tools', 'systemPrompt', 'credentials']

const GUIDANCE = `## Grafana 大盘编辑（dsh-grafana 插件）

用户在 Grafana 里贴大盘地址即可微调大盘，无需截图。工作流：
 1. 用户粘贴大盘 URL（如 http://grafana.example.com/d/<uid>/<slug>?orgId=1）或直接给 UID。
2. 调用 grafana_get 拉取 dashboard JSON（唯一真相源，含 meta 与 dashboard）。
3. 按用户要求修改 panels/targets/阈值/布局/变量等 JSON 字段，用 grafana_push 写回（overwrite 覆盖原盘；folderUid 用 meta 里提供的值可保持文件夹位置）。
4. 提醒用户刷新大盘页面查看效果，不满意继续对话微调。

安全原则：写回前把改动摘要（改了哪些面板/查询）讲给用户听；对生产大盘的大改动先征得用户同意。不要在聊天里输出 token。`

export const Config = Schema.object({
  baseUrl: Schema.string().default('http://grafana.example.com').description('Grafana 根地址'),
  tokenRef: Schema.string().default('GRAFANA_TOKEN').description('凭证引用名：对应 ~/.dsh/.credentials.yaml 中的键，值为 Service Account token'),
})

function parseUid(input) {
  const s = String(input).trim()
  if (/^[A-Za-z0-9_-]{6,64}$/.test(s)) return s
  const m = s.match(/\/d\/([A-Za-z0-9_-]+)/)
  if (m) return m[1]
  throw new Error(`无法从 "${s}" 解析出大盘 UID；请贴完整 URL（/d/<uid>/<slug>）或裸 UID`)
}

function textOut(value) {
  return [{ type: 'text', text: value }]
}

export function apply(ctx, config) {
  ctx.systemPrompt.section({ name: 'tool:grafana', order: 107, text: GUIDANCE })

  async function authHeaders() {
    const r = await ctx.credentials.resolve(config.tokenRef)
    if (!r) throw new Error(`未配置凭证 ${config.tokenRef}：请在 ~/.dsh/.credentials.yaml 写入（键名 ${config.tokenRef}，值为 Service Account token）`)
    return { Authorization: `Bearer ${r.value}` }
  }

  async function api(path, init = {}) {
    const res = await fetch(`${config.baseUrl}${path}`, init)
    const text = await res.text()
    if (!res.ok) throw new Error(`Grafana API ${res.status} ${path}: ${text.slice(0, 600)}`)
    try { return JSON.parse(text) } catch { return text }
  }

  ctx.tools.register(defineTool({
    name: 'grafana_get',
    description: '按浏览器 URL 或 UID 拉取 Grafana 大盘完整 JSON（含 meta 与 dashboard），作为微调的编辑对象。',
    parameters: {
      urlOrUid: { type: 'string', required: true, description: '大盘浏览器地址（如 http://grafana.xxx/d/abc123/slug?orgId=1）或裸 UID' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => textOut(v) },
    async execute(args) {
      const uid = parseUid(args.urlOrUid)
      const data = await api(`/api/dashboards/uid/${encodeURIComponent(uid)}`, { headers: await authHeaders() })
      return JSON.stringify({ meta: data.meta, dashboard: data.dashboard }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grafana_push',
    description: '把修改后的 dashboard JSON 写回 Grafana（POST /api/dashboards/db，overwrite 覆盖原盘）。dashboardJson 必须是完整 dashboard 对象（grafana_get 返回的 dashboard 部分）。',
    parameters: {
      dashboardJson: { type: 'string', required: true, description: '完整 dashboard JSON 字符串（修改后的）' },
      overwrite: { type: 'boolean', description: '是否覆盖已存在版本，默认 true' },
      folderUid: { type: 'string', description: '目标文件夹 UID；不填则用大盘当前文件夹（新盘进 General）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => textOut(v) },
    async execute(args) {
      let dash
      try { dash = JSON.parse(args.dashboardJson) } catch (e) { throw new Error(`dashboardJson 不是合法 JSON: ${e.message}`) }
      if (!dash || typeof dash !== 'object' || !Array.isArray(dash.panels)) throw new Error('dashboardJson 必须是含 panels 数组的 dashboard 对象')
      const body = { dashboard: dash, overwrite: args.overwrite ?? true }
      if (args.folderUid) body.folderUid = args.folderUid
      const out = await api('/api/dashboards/db', {
        method: 'POST',
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return `✅ 已写回：uid=${out.uid} status=${out.status} version=${out.version} url=${out.url}\n请提醒用户在浏览器刷新该大盘查看效果。`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grafana_search',
    description: '在 Grafana 中搜索大盘（GET /api/search），支持按标题关键词/标签过滤，返回 uid/title/url，便于定位要修改的大盘。',
    parameters: {
      query: { type: 'string', description: '标题关键词，不填返回全部' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => textOut(v) },
    async execute(args) {
      const q = args.query ? `&query=${encodeURIComponent(args.query)}` : ''
      const rows = await api(`/api/search?type=dash-db${q}`, { headers: await authHeaders() })
      if (!Array.isArray(rows) || rows.length === 0) return '(未找到大盘)'
      return rows.slice(0, 50).map((r) => `uid=${r.uid} title=${r.title} url=${r.url}`).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grafana_health',
    description: '检查 Grafana 连通性与凭证是否可用（/api/health + 带凭证的 /api/search）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => textOut(v) },
    async execute() {
      const h = await api('/api/health')
      const rows = await api('/api/search?type=dash-db&limit=3', { headers: await authHeaders() })
      return `health=${h.status ?? 'ok'}; 凭证有效，可搜索到大盘 ${Array.isArray(rows) ? rows.length : '?'} 个`
    },
  }))
}
