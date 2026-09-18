// Correctness hardening — Bug C: saved/clone dashboard URL origin confinement.
// 复现并锁定：Grafana 可能返回一个绝对 http(s) URL。根相对路径与同源绝对 URL
// 照常处理；其余形态（跨源、hostname 前缀伪装、自定义端口、用户名密码、
// javascript:/data:/ftp: 等非 HTTP(S) scheme、非根相对路径）一律省略——绝不把
// 不可信链接冒充成用户自己 Grafana 的可信链接返回。
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDashboardUrl } from '../lib/util.js'
import { createRuntime } from '../lib/runtime.js'
import { defineGrafanaCloneTool, defineGrafanaGetTool, defineGrafanaPushTool } from '../lib/tools/dashboard.js'

// C1 — 根相对路径（根部署）。
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

// C6b — 端口相同则仍是同源：拒绝的是「不同 origin」，不是「出现端口」。
test('C6b absolute URL carrying the base port explicitly stays same-origin', () => {
  assert.equal(
    resolveDashboardUrl('https://grafana.example.com:8443', 'https://grafana.example.com:8443/d/abc'),
    'https://grafana.example.com:8443/d/abc',
  )
})

// C7 — 非 HTTP(S) scheme：Grafana 的 url 字段不可能是这些形态，原样返回会被
// 宿主链接化（javascript: 点开即执行）。
test('C7 non-HTTP schemes are omitted instead of passed through', () => {
  for (const hostile of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'ftp://grafana.example.com/d/abc', 'vbscript:msgbox(1)']) {
    assert.equal(resolveDashboardUrl('https://grafana.example.com', hostile), null, `expected ${JSON.stringify(hostile)} to be omitted`)
  }
})

// C8 — 带用户名密码的 URL：origin 比较看不见 userinfo，必须单独拒。
// https://user:pass@host/ 会把凭证回显进输出；https://host@evil/ 的 origin 其实
// 是 evil，伪装成同源。
test('C8 userinfo URLs are omitted even when the host matches the base', () => {
  assert.equal(resolveDashboardUrl('https://grafana.example.com', 'https://admin:secret@grafana.example.com/d/abc'), null)
  assert.equal(resolveDashboardUrl('https://grafana.example.com', 'https://grafana.example.com@evil.example.com/d/abc'), null)
})

// C9 — 非根相对的相对路径（可能带 ./ .. 或 scheme 相对形态）不参与拼接，省略。
test('C9 only root-relative paths are resolved against the base', () => {
  assert.equal(resolveDashboardUrl('https://grafana.example.com', 'd/abc'), null)
  assert.equal(resolveDashboardUrl('https://grafana.example.com', './d/abc'), null)
  assert.equal(resolveDashboardUrl('https://grafana.example.com', '../d/abc'), null)
})

// 共享 setup：一台源站 + 假 fetch。POST（保存或克隆的确认响应）返回给定的
// { uid, url }，GET 返回 fixture 大盘。两条写回流程只差在确认响应的 uid 与跑什么。
async function withSavedResponse({ uid, url: savedUrl }, run) {
  const originalFetch = globalThis.fetch
  const dashboard = { id: 7, uid: 'fixture-dash', version: 3, title: 'Example', panels: [] }
  const config = {
    sources: [{ id: 'alpha', name: 'alpha', baseUrl: 'https://grafana.example.com', tokenRef: 'TOKEN_alpha' }],
    defaultSource: 'alpha',
    allowInsecureHttp: true,
  }
  const rt = createRuntime({ credentials: { resolve: async () => ({ value: 'fixture-token' }) } }, () => config)
  const exec = { signal: new AbortController().signal }
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method ?? 'GET').toUpperCase() === 'POST') {
      return new Response(JSON.stringify({ uid, status: 'success', version: 4, url: savedUrl }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ dashboard, meta: { canSave: true, folderUid: 'fixture-folder' } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    // 必须 await run 完成后再让 finally 还原 fetch，否则预写检查 GET 会落到真实网络。
    return await run({ rt, exec, dashboard })
  } finally {
    globalThis.fetch = originalFetch
  }
}

// grafana_push：先 grafana_get 拿到可信快照，再写回（写回响应携带不可信 url）。
function pushWithUrl(url) {
  return withSavedResponse({ uid: 'fixture-dash', url }, async ({ rt, exec, dashboard }) => {
    await defineGrafanaGetTool(rt).execute({ urlOrUid: dashboard.uid }, exec)
    return defineGrafanaPushTool(rt).execute({
      dashboardJson: JSON.stringify(dashboard),
      changeSummary: 'Example update',
      message: 'Example update',
    }, exec)
  })
}

// grafana_clone：GET 源大盘（取 meta/folder/title）→ POST 建副本。
function cloneWithUrl(url) {
  return withSavedResponse({ uid: 'new-clone-uid', url }, ({ rt, exec }) =>
    defineGrafanaCloneTool(rt).execute({ sourceUrlOrUid: 'fixture-dash' }, exec))
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

test('grafana_clone omits a cross-origin dashboard URL instead of presenting it as trusted', async () => {
  const out = await cloneWithUrl('https://evil.example.com/d/new-clone-uid')
  assert.match(out, /^Dashboard cloned:/)
  assert.match(out, /uid=new-clone-uid/)
  assert.match(out, /url=omitted/)
  assert.doesNotMatch(out, /evil\.example\.com/)
})

test('grafana_clone keeps a same-origin absolute dashboard URL', async () => {
  const out = await cloneWithUrl('https://grafana.example.com/d/new-clone-uid')
  assert.match(out, /url=https:\/\/grafana\.example\.com\/d\/new-clone-uid/)
  assert.doesNotMatch(out, /omitted/)
})

test('grafana_clone keeps a relative dashboard URL on root deployment', async () => {
  const out = await cloneWithUrl('/d/new-clone-uid')
  assert.match(out, /url=https:\/\/grafana\.example\.com\/d\/new-clone-uid/)
  assert.doesNotMatch(out, /omitted/)
})

// 端到端：非 HTTP(S) scheme 与 userinfo 形态同样不得进入输出，且不留下可点击的
// 痕迹（宿主把输出链接化时拿不到任何 URL）。
for (const [label, hostileUrl] of [
  ['javascript scheme', 'javascript:alert(1)'],
  ['data scheme', 'data:text/html,<a href=https://evil.example.com>x</a>'],
  ['userinfo on the configured host', 'https://admin:secret@grafana.example.com/d/fixture-dash'],
]) {
  test(`grafana_push omits an unsafe dashboard URL (${label})`, async () => {
    const out = await pushWithUrl(hostileUrl)
    assert.match(out, /url=omitted/)
    assert.doesNotMatch(out, /javascript:|data:|secret@|admin/)
    assert.doesNotMatch(out, /href=/)
  })

  test(`grafana_clone omits an unsafe dashboard URL (${label})`, async () => {
    const out = await cloneWithUrl(hostileUrl)
    assert.match(out, /url=omitted/)
    assert.doesNotMatch(out, /javascript:|data:|secret@|admin/)
    assert.doesNotMatch(out, /href=/)
  })
}
