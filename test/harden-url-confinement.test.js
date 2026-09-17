// Correctness hardening — Bug C: saved/clone dashboard URL origin confinement.
// 复现并锁定：Grafana 可能返回一个绝对 http(s) URL。相对路径与同源绝对 URL
// 照常处理；跨源绝对 URL（含 hostname 前缀伪装与自定义端口）必须省略，绝不能
// 把不可信链接冒充成用户自己 Grafana 的可信链接返回。
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDashboardUrl } from '../lib/util.js'
import { createRuntime } from '../lib/runtime.js'
import { defineGrafanaGetTool, defineGrafanaPushTool } from '../lib/tools/dashboard.js'

// C1 — 相对路径（根部署）。
test('C1 relative URL on root deployment resolves against base origin', () => {
  assert.equal(resolveDashboardUrl('https://grafana.example.com', '/d/abc'), 'https://grafana.example.com/d/abc')
})

// C2 — 相对路径 + 子路径部署不重复拼接。
test('C2 relative URL on sub-path deployment keeps the sub-path once', () => {
  assert.equal(
    resolveDashboardUrl('https://grafana.example.com/grafana', '/grafana/d/abc'),
    'https://grafana.example.com/grafana/d/abc',
  )
})

// C3 — 同源绝对 URL 允许。
test('C3 absolute same-origin URL is allowed', () => {
  assert.equal(
    resolveDashboardUrl('https://grafana.example.com', 'https://grafana.example.com/d/abc'),
    'https://grafana.example.com/d/abc',
  )
})

// C4 — 跨源绝对 URL 省略（返回 null）。
test('C4 absolute cross-origin URL is omitted', () => {
  assert.equal(resolveDashboardUrl('https://grafana.example.com', 'https://evil.example.com/d/abc'), null)
})

// C5 — hostname 前缀伪装（grafana.example.com.evil.com）必须被 origin 比较拒绝。
test('C5 hostname-prefix trick does not bypass the origin check', () => {
  assert.equal(resolveDashboardUrl('https://grafana.example.com', 'https://grafana.example.com.evil.com/d/abc'), null)
})

// C6 — 自定义端口构成不同 origin。
test('C6 custom port makes a different origin and is omitted', () => {
  assert.equal(resolveDashboardUrl('https://grafana.example.com', 'https://grafana.example.com:8443/d/abc'), null)
})

// 端到端：grafana_push 拿到跨源 URL 时省略它，且绝不把恶意主机名写进输出。
async function pushWithUrl(crossUrl) {
  const originalFetch = globalThis.fetch
  const dashboard = { id: 7, uid: 'fixture-dash', version: 3, title: 'Example', panels: [] }
  const input = { dashboardJson: JSON.stringify(dashboard), changeSummary: 'Example update', message: 'Example update' }
  const config = {
    sources: [{ id: 'alpha', name: 'alpha', baseUrl: 'https://grafana.example.com', tokenRef: 'TOKEN_alpha' }],
    defaultSource: 'alpha',
    allowInsecureHttp: true,
  }
  const rt = createRuntime({ credentials: { resolve: async () => ({ value: 'fixture-token' }) } }, () => config)
  const exec = { signal: new AbortController().signal }
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method ?? 'GET').toUpperCase() === 'POST') {
      return new Response(JSON.stringify({ uid: dashboard.uid, status: 'success', version: 4, url: crossUrl }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ dashboard, meta: { canSave: true, folderUid: 'fixture-folder' } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    await defineGrafanaGetTool(rt).execute({ urlOrUid: dashboard.uid }, exec)
    // 必须 await push 完成后再让 finally 还原 fetch，否则预写检查 GET 会落到真实网络。
    return await defineGrafanaPushTool(rt).execute(input, exec)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('grafana_push omits a cross-origin dashboard URL instead of presenting it as trusted', async () => {
  const out = await pushWithUrl('https://evil.example.com/d/fixture-dash')
  assert.match(out, /^Dashboard updated:/)
  assert.match(out, /url=omitted/)
  assert.doesNotMatch(out, /evil\.example\.com/)
})

test('grafana_push keeps a same-origin absolute dashboard URL', async () => {
  const out = await pushWithUrl('https://grafana.example.com/d/fixture-dash')
  assert.match(out, /url=https:\/\/grafana\.example\.com\/d\/fixture-dash/)
  assert.doesNotMatch(out, /omitted/)
})
