import assert from 'node:assert/strict'
import test from 'node:test'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import { apply } from '../index.js'

const UID = 'fixture-dash-0001'

function execution(extra = {}) {
  return { signal: new AbortController().signal, ...extra }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function dashboard(version = 3) {
  return {
    id: 7,
    uid: UID,
    version,
    title: 'Overview',
    panels: [
      { id: 1, type: 'timeseries', title: 'CPU', gridPos: { x: 0, y: 0, w: 12, h: 8 }, targets: [{ refId: 'A', expr: 'up' }] },
      { id: 2, type: 'stat', title: 'Requests', gridPos: { x: 12, y: 0, w: 12, h: 8 }, targets: [{ refId: 'A', expr: 'requests' }] },
    ],
    templating: { list: [{ name: 'env', type: 'custom', query: 'prod,stage' }] },
  }
}

function workspaceFs(files) {
  const normalize = (value) => resolvePath(value)
  return {
    async resolve(value, { cwd = '/workspace' } = {}) {
      const path = normalize(isAbsolute(String(value)) ? String(value) : resolvePath(cwd, String(value)))
      return { targetKey: path, displayPath: path }
    },
    contains(parent, child) {
      return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`)
    },
    async stat(target) {
      if (!Object.hasOwn(files, target.targetKey)) return undefined
      return { type: 'file', size: Buffer.byteLength(files[target.targetKey]), version: '1' }
    },
    async readText(target) {
      if (!Object.hasOwn(files, target.targetKey)) throw new Error('not found')
      return files[target.targetKey]
    },
  }
}

function createHarness({ files = null, fetchImpl = null } = {}) {
  const tools = []
  const listeners = new Map()
  const state = { current: dashboard(), posts: [], restores: [], versions: [] }
  const ctx = {
    credentials: {
      async resolve(ref) {
        if (ref === 'GRAFANA_BASE_URL') return { value: 'https://grafana.example.com' }
        if (ref === 'GRAFANA_TOKEN') return { value: 'test-token' }
        return undefined
      },
    },
    inject() {},
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    systemPrompt: { section() {} },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    get(name) {
      if (name === 'fs' && files) return workspaceFs(files)
      if (name === 'workingDirectory' && files) return { get: () => '/workspace' }
      return undefined
    },
  }
  apply(ctx, {})
  const defaultFetch = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname
    const method = String(init.method ?? 'GET').toUpperCase()
    if (path === `/api/dashboards/uid/${UID}` && method === 'GET') {
      return jsonResponse({ dashboard: structuredClone(state.current), meta: { folderUid: 'folder-1', folderTitle: 'Operations', canSave: true } })
    }
    if (path === `/api/dashboards/uid/${UID}/versions` && method === 'GET') return jsonResponse(state.versions)
    if (path === `/api/dashboards/uid/${UID}/restore` && method === 'POST') {
      const body = JSON.parse(init.body)
      state.restores.push(body)
      state.current = { ...state.current, version: state.current.version + 1 }
      return jsonResponse({ status: 'success', uid: UID, version: state.current.version, url: `/d/${UID}/overview` })
    }
    if (path === '/api/dashboards/db' && method === 'POST') {
      const body = JSON.parse(init.body)
      state.posts.push(body)
      state.current = { ...structuredClone(body.dashboard), version: state.current.version + 1 }
      return jsonResponse({ status: 'success', uid: UID, version: state.current.version, url: `/d/${UID}/overview` })
    }
    if (path === '/api/datasources') return jsonResponse([])
    return jsonResponse({ message: `unexpected ${method} ${path}` }, 404)
  }
  return {
    tools,
    listeners,
    state,
    async fetch(url, init) { return (fetchImpl ?? defaultFetch)(url, init) },
  }
}

function toolByName(harness, name) {
  const tool = harness.tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

async function approveAndExecute(harness, name, args, { session = true } = {}) {
  const exec = execution(session ? { agent: { session: { id: 'session-1' } } } : {})
  exec.name = name
  exec.arguments = args
  const decision = await harness.listeners.get('tools/pre-execute')(
    exec,
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'ask', decision.reason)
  return { decision, output: await toolByName(harness, name).execute(args, exec), exec }
}

async function getSnapshot(harness) {
  await toolByName(harness, 'grafana_get').execute({ urlOrUid: UID }, execution())
}

test('grafana_push reads a workspace file and keeps the existing snapshot and save contract', async () => {
  const proposed = { ...dashboard(), title: 'From file' }
  const files = { '/workspace/dashboard.json': JSON.stringify(proposed) }
  const harness = createHarness({ files })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => harness.fetch(url, init)
  try {
    await getSnapshot(harness)
    const { decision, output } = await approveAndExecute(harness, 'grafana_push', {
      dashboardFile: 'dashboard.json', changeSummary: 'Use the reviewed file', message: 'update title',
    })
    assert.match(decision.reason, /Write Grafana dashboard uid=fixture-dash-0001/)
    assert.match(decision.reason, /~ field title/)
    assert.equal(harness.state.posts.length, 1)
    assert.equal(harness.state.posts[0].dashboard.title, 'From file')
    assert.equal(harness.state.posts[0].dashboard.id, 7)
    assert.equal(harness.state.posts[0].dashboard.version, 3)
    assert.match(output, /Dashboard updated: uid=fixture-dash-0001 status=success version=4/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('dashboardFile is confined to the workspace, exclusive with dashboardJson, and rebound after approval', async () => {
  const proposed = JSON.stringify({ ...dashboard(), title: 'Reviewed' })
  const files = { '/workspace/dashboard.json': proposed, '/outside.json': proposed }
  const harness = createHarness({ files })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => harness.fetch(url, init)
  try {
    await getSnapshot(harness)
    const push = toolByName(harness, 'grafana_push')
    const base = { changeSummary: 's', message: 'm' }
    await assert.rejects(push.execute({ ...base, dashboardJson: proposed, dashboardFile: 'dashboard.json' }, execution({ agent: { session: {} } })), /exactly one/)
    await assert.rejects(push.execute({ ...base, dashboardFile: '/outside.json' }, execution({ agent: { session: {} } })), /inside the session working directory/)
    await assert.rejects(push.execute({ ...base, dashboardFile: '../outside.json' }, execution({ agent: { session: {} } })), /inside the session working directory/)
    await assert.rejects(push.execute({ ...base, dashboardFile: 'missing.json' }, execution({ agent: { session: {} } })), /does not exist/)
    await assert.rejects(push.execute({ ...base, dashboardFile: 'dashboard.json' }, execution()), /needs the host filesystem|session working directory/)

    const exec = execution({ agent: { session: { id: 'session-1' } } })
    const args = { ...base, dashboardFile: 'dashboard.json' }
    exec.name = 'grafana_push'
    exec.arguments = args
    const decision = await harness.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'ask')
    // 批准后替换文件：执行必须拒绝，且不能发出 POST。
    files['/workspace/dashboard.json'] = JSON.stringify({ ...dashboard(), title: 'Changed after approval' })
    await assert.rejects(push.execute(args, exec), /changed after the approval prompt/)
    assert.equal(harness.state.posts.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_patch applies only the requested difference and returns structured change details', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => harness.fetch(url, init)
  try {
    await getSnapshot(harness)
    const { decision, output } = await approveAndExecute(harness, 'grafana_patch', {
      urlOrUid: UID,
      ops: [
        { op: 'replace', path: '/title', value: 'Patched' },
        { op: 'add', path: '/panels/-', value: { id: 3, type: 'text', title: 'Notes' } },
      ],
      changeSummary: 'Rename and add notes', message: 'patch dashboard',
    })
    assert.match(decision.reason, /Operations: 2/)
    assert.match(decision.reason, /\+ panel id=3/)
    assert.equal(harness.state.posts.length, 1)
    const written = harness.state.posts[0].dashboard
    assert.equal(written.title, 'Patched')
    assert.equal(written.panels.length, 3)
    assert.equal(written.id, 7)
    assert.equal(written.uid, UID)
    assert.equal(written.version, 3)
    assert.match(output, /version=4/)
    assert.match(output, /Changed paths: .*\/title/)
    assert.match(output, /Operations applied: 2/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_patch rejects an invalid operation as a whole and refuses identity or version edits', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => harness.fetch(url, init)
  try {
    await getSnapshot(harness)
    const patch = toolByName(harness, 'grafana_patch')
    const base = { urlOrUid: UID, changeSummary: 's', message: 'm' }
    await assert.rejects(patch.execute({ ...base, ops: [
      { op: 'replace', path: '/title', value: 'would otherwise apply' },
      { op: 'remove', path: '/panels/99' },
    ] }, execution()), /ops\[1\].*does not exist/)
    await assert.rejects(patch.execute({ ...base, ops: [{ op: 'replace', path: '/version', value: 99 }] }, execution()), /must not change the dashboard id, uid or version/)
    await assert.rejects(patch.execute({ ...base, ops: [{ op: 'replace', path: '/uid', value: 'other' }] }, execution()), /must not change the dashboard id, uid or version/)
    assert.equal(harness.state.posts.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_patch reports a version conflict before writing and recognizes a no-op', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => harness.fetch(url, init)
  try {
    await getSnapshot(harness)
    harness.state.current.version = 4
    const patch = toolByName(harness, 'grafana_patch')
    const args = { urlOrUid: UID, ops: [{ op: 'replace', path: '/title', value: 'new' }], changeSummary: 's', message: 'm' }
    await assert.rejects(patch.execute(args, execution()), /Dashboard version conflict: fetched version 3, current version 4/)
    assert.equal(harness.state.posts.length, 0)

    harness.state.current.version = 3
    const output = await patch.execute({ ...args, ops: [{ op: 'replace', path: '/title', value: 'Overview' }] }, execution())
    assert.match(output, /^No change:/)
    assert.equal(harness.state.posts.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_upsert_panel and grafana_variable_upsert use the same checked commit path', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => harness.fetch(url, init)
  try {
    await getSnapshot(harness)
    const added = await approveAndExecute(harness, 'grafana_upsert_panel', {
      urlOrUid: UID, afterPanelId: 1, panel: { type: 'text', title: 'Notes' }, changeSummary: 'Add notes', message: 'add panel',
    })
    assert.match(added.decision.reason, /Edit a panel/)
    assert.match(added.output, /panelIds=\[3\]/)
    assert.equal(harness.state.posts[0].dashboard.panels[1].title, 'Notes')
    assert.equal(harness.state.posts[0].dashboard.panels[0].gridPos.x, 0)

    await getSnapshot(harness)
    const changed = await approveAndExecute(harness, 'grafana_variable_upsert', {
      urlOrUid: UID, name: 'env', variable: { label: 'Environment' }, changeSummary: 'Label variable', message: 'edit variable',
    })
    assert.match(changed.decision.reason, /Edit a template variable/)
    assert.match(changed.output, /variable="env"/)
    assert.equal(harness.state.posts[1].dashboard.templating.list[0].label, 'Environment')
    assert.equal(harness.state.posts[1].dashboard.templating.list[0].query, 'prod,stage')

    await getSnapshot(harness)
    const removed = await approveAndExecute(harness, 'grafana_upsert_panel', {
      urlOrUid: UID, panelId: 3, delete: true, changeSummary: 'Remove notes', message: 'remove panel',
    })
    assert.match(removed.output, /action=delete/)
    assert.equal(harness.state.posts[2].dashboard.panels.some((panel) => panel.id === 3), false)

    await getSnapshot(harness)
    const variableRemoved = await approveAndExecute(harness, 'grafana_variable_upsert', {
      urlOrUid: UID, name: 'env', delete: true, changeSummary: 'Remove variable', message: 'remove variable',
    })
    assert.match(variableRemoved.output, /action=delete/)
    assert.equal(harness.state.posts[3].dashboard.templating.list.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_version_list is read-only and grafana_restore_version writes a reviewed new version', async () => {
  const harness = createHarness()
  harness.state.versions = [
    { version: 3, created: '2026-11-16T10:00:00Z', createdBy: 'user@example.com', message: 'current' },
    { version: 2, created: '2026-11-15T10:00:00Z', createdBy: 'user@example.com', message: 'before' },
  ]
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => harness.fetch(url, init)
  try {
    const listed = await toolByName(harness, 'grafana_version_list').execute({ urlOrUid: UID }, execution())
    assert.match(listed, /version=3 .*message="current"/)
    assert.match(listed, /version=2 .*message="before"/)
    await getSnapshot(harness)
    const restored = await approveAndExecute(harness, 'grafana_restore_version', {
      urlOrUid: UID, version: 2, changeSummary: 'Return to the reviewed version',
    })
    assert.match(restored.decision.reason, /Restore Grafana dashboard to version 2/)
    assert.deepEqual(harness.state.restores, [{ version: 2 }])
    assert.match(restored.output, /version=4/)
    assert.match(restored.output, /Restored content of version 2/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_restore_version refuses restoring the current version or writing over a conflict', async () => {
  const harness = createHarness()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => harness.fetch(url, init)
  try {
    await getSnapshot(harness)
    const restore = toolByName(harness, 'grafana_restore_version')
    const args = { urlOrUid: UID, version: 3, changeSummary: 's' }
    await assert.rejects(restore.execute(args, execution()), /already the current version/)
    assert.equal(harness.state.restores.length, 0)
    harness.state.current.version = 4
    await assert.rejects(restore.execute({ ...args, version: 2 }, execution()), /Dashboard version conflict/)
    assert.equal(harness.state.restores.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
