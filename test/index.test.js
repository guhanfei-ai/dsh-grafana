import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, internals } from '../index.js'

function execution() {
  return { signal: new AbortController().signal }
}

function createContext({ baseUrl = 'https://grafana.example.com', token = 'test-token' } = {}) {
  const tools = []
  const listeners = new Map()
  const sections = []
  const ctx = {
    credentials: {
      async resolve(ref) {
        if (ref === 'GRAFANA_BASE_URL') return baseUrl ? { value: baseUrl } : undefined
        if (ref === 'GRAFANA_TOKEN') return token ? { value: token } : undefined
        return undefined
      },
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  apply(ctx, {})
  return { listeners, sections, tools }
}

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('parseUid accepts Grafana-compatible UIDs and dashboard URLs', () => {
  assert.equal(internals.parseUid('abc'), 'abc')
  assert.equal(internals.parseUid('https://grafana.example.com/d/abc_123/overview?orgId=1'), 'abc_123')
  assert.throws(() => internals.parseUid('x'.repeat(41)), /1-40 character UID/)
  assert.throws(() => internals.parseUid('not/a/dashboard'), /Cannot parse/)
})

test('normalizeBaseUrl allows HTTP out of the box and can enforce HTTPS only', () => {
  assert.equal(internals.normalizeBaseUrl('https://grafana.example.com/'), 'https://grafana.example.com')
  assert.equal(internals.normalizeBaseUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000')
  assert.equal(internals.normalizeBaseUrl('http://grafana.internal/'), 'http://grafana.internal')
  assert.equal(internals.normalizeBaseUrl('http://grafana.internal/', true), 'http://grafana.internal')
  assert.throws(() => internals.normalizeBaseUrl('http://grafana.internal/', false), /Plain HTTP is disabled/)
  assert.throws(() => internals.normalizeBaseUrl('https://user:pass@grafana.example.com'), /embedded credentials/)
  assert.throws(() => internals.normalizeBaseUrl('https://grafana.example.com?target=x'), /query string or fragment/)
})

test('readLimitedText rejects oversized responses', async () => {
  await assert.rejects(
    internals.readLimitedText(new Response('12345'), 4),
    /exceeds the 4-byte limit/,
  )
})

test('API error details expose only bounded status and message fields', () => {
  const detail = internals.safeApiErrorDetail(JSON.stringify({
    status: 'version-mismatch',
    message: 'changed elsewhere',
    token: 'must-not-leak',
  }))
  assert.equal(detail, 'version-mismatch: changed elsewhere')
})

test('apply registers four tools and a hard approval gate for writes', async () => {
  const { listeners, sections, tools } = createContext()
  assert.deepEqual(tools.map((tool) => tool.name), [
    'grafana_get',
    'grafana_push',
    'grafana_search',
    'grafana_health',
  ])
  assert.equal(sections.length, 1)

  const gate = listeners.get('tools/pre-execute')
  assert.equal(typeof gate, 'function')
  assert.deepEqual(
    await gate({ name: 'grafana_get', arguments: {} }, async () => ({ kind: 'allow' })),
    { kind: 'allow' },
  )
  const decision = await gate({
    name: 'grafana_push',
    arguments: {
      dashboardJson: JSON.stringify({ uid: 'abc', title: 'Overview' }),
      changeSummary: 'Adjust CPU threshold',
    },
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /Adjust CPU threshold/)
})

test('grafana_push preserves the current folder and disables overwrite by default', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const dashboard = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (init.method === 'POST') {
      return jsonResponse({ uid: 'abc123', status: 'success', version: 4, url: '/d/abc123/overview' })
    }
    return jsonResponse({ meta: { folderUid: 'folder1', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    const get = toolByName(tools, 'grafana_get')
    const push = toolByName(tools, 'grafana_push')
    const fetched = JSON.parse(await get.execute({ urlOrUid: 'abc123' }, execution()))
    fetched.dashboard.title = 'Overview v2'
    const output = await push.execute({
      dashboardJson: JSON.stringify(fetched.dashboard),
      changeSummary: 'Rename the dashboard',
      message: 'Rename dashboard through dsh-grafana',
    }, execution())

    assert.match(output, /Dashboard updated/)
    assert.equal(calls.length, 3)
    const request = JSON.parse(calls[2].init.body)
    assert.equal(request.folderUid, 'folder1')
    assert.equal(request.overwrite, false)
    assert.equal(request.message, 'Rename dashboard through dsh-grafana')
    assert.equal(calls[2].init.headers.Authorization, 'Bearer test-token')
    assert.equal(calls[2].init.redirect, 'error')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_push rejects concurrent edits before POST', async () => {
  const originalFetch = globalThis.fetch
  let getCount = 0
  let postCount = 0
  const initial = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === 'POST') {
      postCount += 1
      return jsonResponse({ status: 'success' })
    }
    getCount += 1
    const dashboard = getCount === 1 ? initial : { ...initial, version: 4 }
    return jsonResponse({ meta: { folderUid: 'folder1', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    await assert.rejects(
      toolByName(tools, 'grafana_push').execute({
        dashboardJson: JSON.stringify(initial),
        changeSummary: 'Change one panel',
        message: 'Update panel',
      }, execution()),
      /Dashboard version conflict/,
    )
    assert.equal(postCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_push requires an explicit flag before moving folders', async () => {
  const originalFetch = globalThis.fetch
  let postCount = 0
  const dashboard = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === 'POST') {
      postCount += 1
      return jsonResponse({ status: 'success' })
    }
    return jsonResponse({ meta: { folderUid: 'folder1', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    await assert.rejects(
      toolByName(tools, 'grafana_push').execute({
        dashboardJson: JSON.stringify(dashboard),
        changeSummary: 'Move dashboard',
        message: 'Move dashboard',
        folderUid: 'folder2',
      }, execution()),
      /allowFolderMove: true/,
    )
    assert.equal(postCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
