import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'
import { writeApprovalDecision } from '../lib/write-approval.js'

function createApprovalContext(config = {}) {
  const tools = new Map()
  const listeners = new Map()
  const sections = []
  const state = { mode: 'workspace-write', policy: 'ask', override: undefined }
  const services = new Map([
    ['sandboxPolicy', { resolve: () => ({ mode: state.mode }) }],
    ['approval', { config: { get policy() { return state.policy } }, overrideOf: () => state.override }],
  ])
  const ctx = {
    get: (name) => services.get(name),
    credentials: { async resolve() { return { value: 'test-token' } } },
    inject() {},
    on(name, listener) { listeners.set(name, listener) },
    systemPrompt: { section(value) { sections.push(value) } },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }
  apply(ctx, { baseUrl: 'https://grafana.example.com', ...config })
  return { ctx, state, services, tools, sections, gate: listeners.get('tools/pre-execute') }
}

function writeExecution(name, session = { id: 'session-a' }) {
  return {
    name,
    agent: { session },
    signal: new AbortController().signal,
    arguments: name === 'grafana_push'
      ? { dashboardJson: '{"uid":"fixture-dash","panels":[]}', changeSummary: 'Example update', message: 'Example update' }
      : { sourceUrlOrUid: 'fixture-dash' },
  }
}

for (const name of ['grafana_push', 'grafana_clone']) {
  test(`${name} skips its extra prompt under explicit full access, even with prompts disabled`, async (t) => {
    const h = createApprovalContext()
    h.state.mode = 'danger-full-access'
    h.state.policy = 'never'
    const exec = writeExecution(name)
    const resolve = t.mock.method(h.services.get('sandboxPolicy'), 'resolve', ({ session }) => {
      assert.equal(session, exec.agent.session)
      return { mode: h.state.mode }
    })
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request') })
    const upstream = { kind: 'allow' }
    assert.equal(await h.gate(exec, async () => upstream), upstream)
    assert.deepEqual(resolve.mock.calls[0].arguments, [{ session: exec.agent.session }])
    assert.equal(fetch.mock.callCount(), 0)
  })
}

test('disabled approval prompts without full access deny accurately, not as a human rejection', async () => {
  const h = createApprovalContext()
  h.state.policy = 'never'
  const decision = await h.gate(writeExecution('grafana_clone'), async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /approval prompts are disabled/i)
  assert.match(decision.reason, /automatic policy denial/i)
  assert.doesNotMatch(decision.reason, /user rejected/i)
})

test('write approval follows live session permission changes instead of caching full access', async () => {
  const h = createApprovalContext()
  const exec = writeExecution('grafana_clone')
  const upstream = { kind: 'allow' }
  assert.equal((await h.gate(exec, async () => upstream)).kind, 'ask')
  h.state.mode = 'danger-full-access'
  assert.equal(await h.gate(exec, async () => upstream), upstream)
  h.state.mode = 'read-only'
  assert.equal((await h.gate(exec, async () => upstream)).kind, 'ask')
})

test('full access never replaces an upstream denial, question or cancellation', async (t) => {
  const h = createApprovalContext()
  h.state.mode = 'danger-full-access'
  const resolve = t.mock.method(h.services.get('sandboxPolicy'), 'resolve')
  for (const kind of ['deny', 'ask', 'cancel']) {
    const upstream = { kind, reason: 'Another gate applies' }
    assert.equal(await h.gate(writeExecution('grafana_push'), async () => upstream), upstream)
  }
  assert.equal(resolve.mock.callCount(), 0)
})

test('cancellation during next remains cancellation, not an automatic policy denial', async (t) => {
  for (const name of ['grafana_push', 'grafana_clone']) {
    for (const mode of ['workspace-write', 'danger-full-access']) {
      await t.test(`${name} ${mode}`, async (t) => {
        const h = createApprovalContext()
        h.state.mode = mode
        h.state.policy = 'never'
        const exec = writeExecution(name)
        const controller = new AbortController()
        exec.signal = controller.signal
        const fetch = t.mock.method(globalThis, 'fetch', async () => { assert.fail('cancelled call must not reach Grafana') })
        const resolve = t.mock.method(h.services.get('sandboxPolicy'), 'resolve')
        const decision = await h.gate(exec, async () => {
          controller.abort()
          return { kind: 'allow' }
        })
        assert.deepEqual(decision, { kind: 'cancel' })
        assert.equal(fetch.mock.callCount(), 0)
        assert.equal(resolve.mock.callCount(), 0)
      })
    }
  }
})

test('plugin read-only mode still denies both writes under full access', async () => {
  const h = createApprovalContext({ readOnly: true })
  h.state.mode = 'danger-full-access'
  for (const name of ['grafana_push', 'grafana_clone']) {
    assert.equal(h.tools.has(name), false)
    const decision = await h.gate(writeExecution(name), async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /Read-only mode/)
  }
})

test('turning read-only on after tool registration still blocks full-access writes', async (t) => {
  let readOnly = false
  // Host volatile fields expose live settings through get(), not a startup copy.
  const h = createApprovalContext({ readOnly: { [Symbol.for('cosmokit.volatile.write')]: true, get: () => readOnly } })
  h.state.mode = 'danger-full-access'
  const resolve = t.mock.method(h.services.get('sandboxPolicy'), 'resolve')
  const fetch = t.mock.method(globalThis, 'fetch', async () => { assert.fail('read-only call must not reach Grafana') })
  readOnly = true
  for (const name of ['grafana_push', 'grafana_clone']) {
    assert.equal(h.tools.has(name), true)
    const decision = await h.gate(writeExecution(name), async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /Read-only mode/)
  }
  assert.equal(resolve.mock.callCount(), 0)
  assert.equal(fetch.mock.callCount(), 0)
})

test('the copyable adapter preserves upstream decisions independently of its caller', () => {
  const h = createApprovalContext()
  h.state.mode = 'danger-full-access'
  for (const kind of ['deny', 'ask', 'cancel']) {
    const upstream = { kind, reason: 'Another gate applies' }
    assert.equal(writeApprovalDecision(h.ctx, writeExecution('example_write'), upstream), upstream)
  }
})

test('only the exact full-access mode grants a prompt exemption', () => {
  const h = createApprovalContext()
  const exec = writeExecution('grafana_clone')
  // Model-supplied policy-shaped fields are untrusted, never permissions.
  exec.arguments.mode = 'danger-full-access'
  exec.arguments.sandbox_permissions = 'danger-full-access'
  exec.arguments.approval = 'never'
  for (const policy of [undefined, null, {}, [], { mode: 'read-only' }, { mode: 'workspace-write' },
    { mode: 'unknown' }, { mode: 'full-access' }, { mode: true }, { mode: 'DANGER-FULL-ACCESS' }]) {
    h.services.set('sandboxPolicy', { resolve: () => policy })
    assert.equal(writeApprovalDecision(h.ctx, exec, { kind: 'allow' }).kind, 'ask')
  }
})

test('absent or broken optional policy capabilities keep native approval', () => {
  const exec = writeExecution('grafana_clone')
  const contexts = [
    {},
    { get() { throw new Error('service unavailable') } },
    { get: () => undefined },
    { get: () => ({}) },
    { get: () => ({ resolve: 42 }) },
    { get: () => ({ resolve() { throw new Error('policy unavailable') } }) },
  ]
  for (const ctx of contexts) {
    assert.deepEqual(writeApprovalDecision(ctx, exec, { kind: 'allow' }), { kind: 'ask' })
  }
})

test('a global full-access default cannot exempt an agentless or malformed-session call', () => {
  const h = createApprovalContext()
  h.state.mode = 'danger-full-access'
  for (const agent of [undefined, {}, { session: 'not-a-session' }, { session: [] }, { id: 'not-found' }]) {
    assert.deepEqual(writeApprovalDecision(h.ctx, { agent }, { kind: 'allow' }), { kind: 'ask' })
  }
})

test('session lookup supports legacy agent ids and prefers the direct session', () => {
  const h = createApprovalContext()
  const direct = { id: 'direct' }
  const legacy = { id: 'legacy' }
  let resolved
  h.ctx.sessions = { get: (id) => id === legacy.id ? legacy : undefined }
  h.services.set('sandboxPolicy', { resolve({ session }) { resolved = session; return { mode: 'danger-full-access' } } })
  const upstream = { kind: 'allow' }
  assert.equal(writeApprovalDecision(h.ctx, { agent: { id: legacy.id } }, upstream), upstream)
  assert.equal(resolved, legacy)
  // Newer optional-service lookup and older property lookup have the same shape.
  h.services.set('sessions', h.ctx.sessions)
  assert.equal(writeApprovalDecision(h.ctx, { agent: { id: legacy.id } }, upstream), upstream)
  assert.equal(resolved, legacy)
  assert.equal(writeApprovalDecision(h.ctx, { agent: { session: direct, id: legacy.id } }, upstream), upstream)
  assert.equal(resolved, direct)
  h.services.set('sessions', { get() { throw new Error('session unavailable') } })
  assert.deepEqual(writeApprovalDecision(h.ctx, { agent: { id: legacy.id } }, upstream), { kind: 'ask' })
})

test('permission resolution stays isolated between calling sessions', () => {
  const h = createApprovalContext()
  const full = { id: 'full' }
  const confined = { id: 'confined' }
  h.services.set('sandboxPolicy', {
    resolve({ session }) { return { mode: session === full ? 'danger-full-access' : 'workspace-write' } },
  })
  const upstream = { kind: 'allow' }
  assert.equal(writeApprovalDecision(h.ctx, { agent: { session: full } }, upstream), upstream)
  assert.deepEqual(writeApprovalDecision(h.ctx, { agent: { session: confined } }, upstream), { kind: 'ask' })
})

test('approval-policy diagnostics honor session overrides and never guess over unknown data', () => {
  const h = createApprovalContext()
  const exec = writeExecution('grafana_clone')
  h.state.policy = 'never'
  h.state.override = 'ask'
  assert.equal(writeApprovalDecision(h.ctx, exec, { kind: 'allow' }).kind, 'ask')
  h.state.policy = 'ask'
  h.state.override = 'never'
  assert.equal(writeApprovalDecision(h.ctx, exec, { kind: 'allow' }).kind, 'deny')
  h.state.policy = 'never'
  for (const override of [null, false, 'future-policy']) {
    h.state.override = override
    assert.equal(writeApprovalDecision(h.ctx, exec, { kind: 'allow' }).kind, 'ask')
  }
  for (const approval of [undefined, {}, { config: { policy: 'never' } }, {
    config: { policy: 'never' }, overrideOf() { throw new Error('override unavailable') },
  }]) {
    h.services.set('approval', approval)
    assert.equal(writeApprovalDecision(h.ctx, exec, { kind: 'allow' }).kind, 'ask')
  }
  // Full access is enough to skip our prompt without inspecting approval policy.
  h.state.mode = 'danger-full-access'
  let approvalReads = 0
  h.services.set('approval', { overrideOf() { approvalReads += 1; throw new Error('approval unavailable') } })
  const upstream = { kind: 'allow' }
  assert.equal(writeApprovalDecision(h.ctx, exec, upstream), upstream)
  assert.equal(approvalReads, 0)
})

test('non-write tools do not consult write approval or file policy', async (t) => {
  const h = createApprovalContext()
  const get = t.mock.method(h.ctx, 'get', () => { throw new Error('unexpected policy lookup') })
  const upstream = { kind: 'allow' }
  assert.equal(await h.gate({ name: 'grafana_get', arguments: {} }, async () => upstream), upstream)
  assert.equal(get.mock.callCount(), 0)
})

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}

const DASHBOARD = { id: 7, uid: 'fixture-dash', title: 'Overview', version: 3, panels: [] }
const META = { folderUid: 'folder-a', canEdit: true, canSave: true }

test('known-disabled approval denies a push with a trusted snapshot before fetching its preview', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => jsonResponse({ dashboard: DASHBOARD, meta: META }))
  const h = createApprovalContext()
  h.state.policy = 'never'
  const exec = writeExecution('grafana_push')
  exec.arguments.dashboardJson = JSON.stringify(DASHBOARD)
  await h.tools.get('grafana_get').execute({ urlOrUid: DASHBOARD.uid }, exec)
  assert.equal(fetch.mock.callCount(), 1)
  const decision = await h.gate(exec, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /automatic policy denial/)
  assert.equal(fetch.mock.callCount(), 1)
})

test('full-access push and clone complete against mocked Grafana without an approval-only live read', async (t) => {
  for (const name of ['grafana_push', 'grafana_clone']) {
    await t.test(name, async (t) => {
      const calls = []
      t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
        calls.push({ method: init.method ?? 'GET', body: init.body })
        if (init.method === 'POST') {
          const uid = name === 'grafana_push' ? DASHBOARD.uid : 'fixture-copy'
          return jsonResponse({ uid, version: name === 'grafana_push' ? 4 : 1, status: 'success', url: `/d/${uid}/overview` })
        }
        return jsonResponse({ dashboard: DASHBOARD, meta: META })
      })
      const h = createApprovalContext()
      h.state.mode = 'danger-full-access'
      h.state.policy = 'never'
      const exec = writeExecution(name)
      if (name === 'grafana_push') {
        await h.tools.get('grafana_get').execute({ urlOrUid: DASHBOARD.uid }, exec)
        exec.arguments.dashboardJson = JSON.stringify({ ...DASHBOARD, title: 'Updated' })
      }
      assert.equal((await h.gate(exec, async () => ({ kind: 'allow' }))).kind, 'allow')
      const output = await h.tools.get(name).execute(exec.arguments, exec)
      assert.match(output, name === 'grafana_push' ? /Dashboard updated/ : /Dashboard cloned/)
      assert.deepEqual(calls.map(({ method }) => method), name === 'grafana_push' ? ['GET', 'GET', 'POST'] : ['GET', 'POST'])
      const body = JSON.parse(calls.at(-1).body)
      assert.equal(body.folderUid, META.folderUid)
      assert.equal(body.overwrite, false)
      if (name === 'grafana_clone') {
        assert.equal(body.dashboard.id, null)
        assert.equal(body.dashboard.uid, undefined)
        assert.equal(body.dashboard.version, undefined)
      }
    })
  }
})

test('full-access push still enforces all write-side checks before any POST', async (t) => {
  const cases = [
    { name: 'missing snapshot', noSnapshot: true, error: /No recent trusted snapshot/ },
    { name: 'invalid JSON', json: 'not-json', error: /not valid JSON/ },
    { name: 'changed identity', proposed: { id: 8 }, error: /id differs/ },
    { name: 'changed version field', proposed: { version: 4 }, error: /version was changed/ },
    { name: 'concurrent edit', current: { version: 4 }, error: /version conflict/ },
    { name: 'Grafana cannot save', meta: { canSave: false }, error: /cannot save/ },
    { name: 'unconfirmed folder move', args: { folderUid: 'folder-b' }, error: /allowFolderMove: true/ },
    { name: 'unknown source', args: { source: 'missing' }, error: /Unknown Grafana source/ },
  ]
  for (const fixture of cases) {
    await t.test(fixture.name, async (t) => {
      let reads = 0
      const posts = []
      t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
        if (init.method === 'POST') { posts.push(String(url)); assert.fail('write must be rejected before POST') }
        reads += 1
        return jsonResponse({
          dashboard: reads > 1 ? { ...DASHBOARD, ...fixture.current } : DASHBOARD,
          meta: { ...META, ...fixture.meta },
        })
      })
      const h = createApprovalContext()
      h.state.mode = 'danger-full-access'
      h.state.policy = 'never'
      const exec = writeExecution('grafana_push')
      exec.arguments = {
        ...exec.arguments,
        dashboardJson: fixture.json ?? JSON.stringify({ ...DASHBOARD, ...fixture.proposed }),
        ...fixture.args,
      }
      if (!fixture.noSnapshot) await h.tools.get('grafana_get').execute({ urlOrUid: DASHBOARD.uid }, exec)
      assert.equal((await h.gate(exec, async () => ({ kind: 'allow' }))).kind, 'allow')
      await assert.rejects(h.tools.get('grafana_push').execute(exec.arguments, exec), fixture.error)
      assert.deepEqual(posts, [])
    })
  }
})

test('full access retains target-source binding for both writes', async (t) => {
  for (const name of ['grafana_push', 'grafana_clone']) {
    await t.test(name, async (t) => {
      const fetch = t.mock.method(globalThis, 'fetch', async () => { assert.fail('changed source must not be contacted') })
      const sources = [{ id: 'source-a', name: 'Primary', baseUrl: 'https://alpha.example.com' }]
      const h = createApprovalContext({ sources, defaultSource: 'source-a' })
      h.state.mode = 'danger-full-access'
      const exec = writeExecution(name)
      assert.equal((await h.gate(exec, async () => ({ kind: 'allow' }))).kind, 'allow')
      sources[0].baseUrl = 'https://beta.example.com'
      await assert.rejects(h.tools.get(name).execute(exec.arguments, exec), /approved for has changed/)
      assert.equal(fetch.mock.callCount(), 0)
    })
  }
})

test('model guidance and write tool descriptions state the full-access exception', () => {
  const h = createApprovalContext()
  assert.match(h.sections[0].text, /explicit danger-full-access skips this plugin's extra approval prompt/)
  assert.match(h.sections[0].text, /does not mean the user clicked Reject/)
  assert.doesNotMatch(h.sections[0].text, /Every write requires a native user-approval prompt|always requires native user approval/)
  for (const name of ['grafana_push', 'grafana_clone']) {
    assert.match(h.tools.get(name).description, /unless the calling session has explicit danger-full-access/)
    assert.doesNotMatch(h.tools.get(name).description, /always requires/i)
  }
})
