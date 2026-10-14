import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// 在 vm 沙箱里加载浏览器 bundle：注入 URL、window.__ModuleLoader__ 与 crypto
// （generateSourceId 走 crypto.randomUUID 路径需要它）。返回 { definition, runtime }。
function loadBrowserModule(react = {}, browserGlobals = {}) {
  let definition
  const window = { __ModuleLoader__: { load(value) { definition = value } }, confirm: () => true }
  vm.runInNewContext(
    readFileSync(new URL('../client.js', import.meta.url), 'utf8'),
    { URL, window, crypto: globalThis.crypto, ...browserGlobals },
  )
  const runtime = definition.factory((id) => {
    // jsx/jsxs 返回可遍历的节点：组件级用例要按 type/children 找到按钮与输入框。
    if (id === 'react/jsx-runtime') {
      const node = (type, props) => ({ type, props })
      return { jsx: node, jsxs: node }
    }
    if (id === 'react') return { createElement: (type, props) => ({ type, props }), ...react }
    throw new Error(`Unexpected browser dependency: ${id}`)
  })
  return { definition, runtime }
}

function loadBrowserRuntime(react, browserGlobals) {
  return loadBrowserModule(react, browserGlobals).runtime
}

// 装配 face 并挂上可变的 settings/credentials mock。所有跨 realm 对象一律用
// JSON.stringify 比较（vm 沙箱造出的对象原型链与本 realm 不同源，deepStrictEqual 会误报）。
//
// mock 的形状以 dsh 0.1.2-rc.1 真机取证 + 官方包调用点为准，不以本仓库的旧假设为准：
//   · 门面是 remote.<ns> 服务（dsh-api-gateway 挂载），不是 connection.api —— 后者在
//     0.1.2-rc.1 的 connection handle 上根本不存在（键集只有 isLoopback/generation/
//     state/rpc/reconnect/registerGenerationSource/start）。
//   · 参数一律位置传递：describe() / describe(refs) / set(ref, value) / unset(ref) /
//     mutate(ns, ops, revision?) / update(ns, patch, revision?)。
//   · arity 严格：网关按声明的参数个数校验实传个数，第三参即使取 void 0 也必须显式传
//     （0.1.2-rc.1 真机报错原文 `client api: settings/mutate expected 3 argument(s), got 2`）。
//     因此 mock 一律用 rest 参数记录实传个数；若用具名形参再拼数组，会把 arity 抹平、
//     正好漏掉这类缺陷。
//   · 应答一律 { ok, value } 或 { ok:false, error:{ message } }，没有 result.value 外层。
//   · settings.describe 的 value 是聚合格 { writable, hasDocument, namespaces[] }。
// remote:false 模拟没有 remote.* 命名空间服务的旧宿主；fail 按方法名注入 { ok:false }
// 应答（例如 { 'credentials.describe': '...' }），用于验证失败不会被静默吞掉。
function buildBackend({ sources = [], defaultSource = '', creds = {}, credentialStore = null, locale = 'zh', fail = {}, readOnly = false } = {}) {
  const calls = []
  // state 是后端的可变权威：多个卡片（多个设置页）可以共享同一份，用来复现并发保存。
  const credState = credentialStore ?? { ...creds }
  const state = { sources: sources.map((s) => ({ ...s })), defaultSource, readOnly, revision: 0, creds: credState, writes: [] }
  // 可变副本：用例可以在运行期摘掉某条失败注入，模拟「故障恢复」。
  const failState = { ...fail }
  const rejected = (what) => (failState[what] ? { ok: false, error: { message: failState[what] } } : null)
  // 真机 describe 应答里每个命名空间描述符的完整键集。
  const descriptor = (ns, value) => ({ ns, schema: null, value, base: {}, user: {}, applies: 'live', secrets: [], revision: state.revision })
  const credentials = {
    async describe(...args) {
      calls.push(['credentials.describe', args])
      const refs = args[0]
      const bad = rejected('credentials.describe')
      if (bad) return bad
      const value = {}
      for (const ref of refs ?? []) value[ref] = { configured: Boolean(credState[ref]), writable: true }
      return { ok: true, value }
    },
    async set(...args) {
      calls.push(['credentials.set', args])
      const [ref, value] = args
      const bad = rejected('credentials.set')
      if (bad) return bad
      credState[ref] = value
      return { ok: true }
    },
    async unset(...args) {
      calls.push(['credentials.unset', args])
      const [ref] = args
      const bad = rejected('credentials.unset')
      if (bad) return bad
      delete credState[ref]
      return { ok: true }
    },
  }
  const settings = {
    async describe(...args) {
      calls.push(['settings.describe', args])
      const bad = rejected('settings.describe')
      if (bad) return bad
      return { ok: true, value: { writable: true, hasDocument: true, namespaces: [
        descriptor('grafana', { sources: state.sources.map((s) => ({ ...s })), defaultSource: state.defaultSource, readOnly: state.readOnly }),
        descriptor('locale', { preference: locale }),
      ] } }
    },
    async update(...args) {
      calls.push(['settings.update', args])
      const [ns, patch] = args
      const bad = rejected('settings.update')
      if (bad) return bad
      if (ns === 'grafana' && patch) {
        if (patch.sources !== undefined) state.sources = patch.sources.map((s) => ({ ...s }))
        if (patch.defaultSource !== undefined) state.defaultSource = patch.defaultSource
      }
      return { ok: true, value: descriptor('grafana', { ...state }) }
    },
    // 与宿主一致的乐观并发语义：带过期 expectedRevision 的写入以冲突拒绝。
    async mutate(...args) {
      calls.push(['settings.mutate', args])
      const [ns, ops, expectedRevision] = args
      const bad = rejected('settings.mutate')
      if (bad) return bad
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        return { ok: false, error: { message: 'revision conflict' } }
      }
      state.writes.push({ expectedRevision })
      // 与宿主 dsh-settings 的 applyPathOp 语义一致：set 对目标路径整体赋值。
      for (const op of ops ?? []) {
        if (ns !== 'grafana' || !op?.op) continue
        if (op.op === 'set' && op.path?.[0] === 'sources') state.sources = (op.value ?? []).map((s) => ({ ...s }))
        if (op.op === 'set' && op.path?.[0] === 'defaultSource') state.defaultSource = op.value
        if (op.op === 'set' && op.path?.[0] === 'readOnly') state.readOnly = op.value === true
        if (op.op === 'unset' && op.path?.[0] === 'sources') state.sources = []
      }
      state.revision += 1
      return { ok: true, value: descriptor('grafana', { ...state }) }
    },
  }
  return { calls, state, credState, fail: failState, settings, credentials }
}

const SETTINGS_SPECS = {
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.plugins.tab': { kind: 'list', scope: 'root' },
  'settings.plugin.item': { kind: 'keyed', scope: 'root' },
}

// 模拟真实声明生命周期：未知槽等待，撤销立即清空注册，重声明创建新的生命周期。
// 微任务可手动 flush，覆盖同 tick 撤销/重挂及 fiber 卸载早于控制器清理的竞态。
function slotHarness({ declared = Object.keys(SETTINGS_SPECS), probe = true, failInject = '' } = {}) {
  const specs = new Map(declared.map((name) => [name, SETTINGS_SPECS[name]]))
  const entries = new Map()
  const controllers = new Set()
  const effects = []
  const pending = []
  const injected = []
  const registered = []
  let unloading = false
  let maxEntries = 0
  const inactive = () => Object.assign(new Error('fiber is unloading'), { code: 'INACTIVE_EFFECT' })
  const once = (fn) => {
    let stopped = false
    return () => { if (!stopped) { stopped = true; fn?.() } }
  }
  const slots = {
    ...(probe ? { spec: (name) => specs.get(name) } : {}),
    inject(name, callback) {
      assert.ok(name in SETTINGS_SPECS, `unexpected slot: ${name}`)
      injected.push(name)
      if (name === failInject) throw new Error('slot injection failed')
      const controller = { name, active: false, cleanup: null }
      controller.enter = () => {
        if (!specs.has(name) || controller.active) return
        controller.active = true
        controller.cleanup = callback()
      }
      controller.leave = () => {
        if (!controller.active) return
        controller.active = false
        const cleanup = controller.cleanup
        controller.cleanup = null
        cleanup?.()
      }
      controllers.add(controller)
      controller.enter()
      return once(() => { controllers.delete(controller); controller.leave() })
    },
    register(specification, card) {
      if (unloading) throw inactive()
      assert.ok(specs.has(specification.name), 'cannot register into an undeclared slot')
      if (specification.name === 'settings.plugin.item') {
        assert.equal(specification.key, 'grafana')
        assert.equal('id' in specification, false)
        assert.equal('order' in specification, false)
      } else {
        assert.equal(specification.id, 'grafana')
        assert.equal(typeof specification.order, 'number')
        assert.equal(specification.label, 'Grafana')
      }
      assert.equal(typeof card, 'function')
      const key = `${specification.name}/${specification.id ?? specification.key}`
      assert.equal(entries.has(key), false, 'duplicate slot registration')
      const entry = { specification, card }
      entries.set(key, entry)
      registered.push(entry)
      maxEntries = Math.max(maxEntries, entries.size)
      return once(() => { if (entries.get(key) === entry) entries.delete(key) })
    },
  }
  const ctx = {
    slots,
    effect(callback) {
      if (unloading) throw inactive()
      const dispose = once(callback())
      effects.push(dispose)
      return dispose
    },
  }
  return {
    ctx, slots, entries, controllers, injected, registered,
    queueMicrotask: (callback) => pending.push(callback),
    flush() { while (pending.length) pending.shift()() },
    maxEntries: () => maxEntries,
    declare(name, spec = SETTINGS_SPECS[name]) {
      assert.equal(specs.has(name), false, 'slot is already declared')
      specs.set(name, spec)
      for (const controller of [...controllers]) if (controller.name === name) controller.enter()
    },
    collapse(name) {
      specs.delete(name)
      for (const [key, entry] of entries) if (entry.specification.name === name) entries.delete(key)
      for (const controller of [...controllers]) if (controller.name === name) controller.leave()
    },
    beginUnload() { unloading = true },
    resume() { unloading = false },
    dispose() {
      unloading = true
      for (const dispose of effects.toReversed()) dispose()
      for (const controller of [...controllers]) { controllers.delete(controller); controller.leave() }
      entries.clear()
    },
  }
}

// backend：传入已建好的后端即可让多个卡片共享同一份权威状态（复现并发保存）。
function setup({ backend = null, react = null, remote = true, browserGlobals = {}, slot = 'settings.plugin.item', ...backendOptions } = {}) {
  const built = backend ?? buildBackend(backendOptions)
  const services = remote ? { 'remote.settings': built.settings, 'remote.credentials': built.credentials } : {}
  const lifecycle = slotHarness({ declared: [slot] })
  const runtime = loadBrowserRuntime(react ?? {}, { ...browserGlobals, queueMicrotask: lifecycle.queueMicrotask })
  runtime.apply({
    ...lifecycle.ctx,
    // 刻意不提供 connection；远端门面缺席时 ctx.get 返回 undefined。
    get(name) { return services[name] },
  })
  lifecycle.flush()
  assert.equal(lifecycle.entries.size, 1)
  const { specification, card } = [...lifecycle.entries.values()][0]
  const element = specification.name === 'settings.plugin.item' ? null : card()
  const props = element?.props ?? specification.inject()
  const component = element?.type ?? card
  return { ...built, face: props.grafanaCard, props, component }
}

// 并发用例的共享后端：一个已落库的源站 + 一枚已生效的令牌，带版本检查的 mutate。
function sharedBackendOptions() {
  return {
    sources: [{ id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }],
    defaultSource: 'id-a',
    creds: { GRAFANA_TOKEN_ida: 'demo-token-original' },
  }
}

function sharedBackend(options = {}) {
  return buildBackend({
    locale: 'en',
    sources: [{ id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }],
    defaultSource: 'id-a',
    creds: { GRAFANA_TOKEN_ida: 'demo-token-original' },
    ...options,
  })
}

// 组件级用例：用最小 React 替身（useState 按调用顺序存取、useEffect 只在挂载时
// 收集）跑真实的 GrafanaCard 闭包——保存、回读与事件处理都来自未修改的 client.js。
// 这不是 DOM/浏览器验收，只覆盖状态与远端调用序列。
function cardHarness(options = {}) {
  const states = []
  const effects = []
  let cursor = 0
  let mounted = false
  const react = {
    createElement: (type, props) => ({ type, props }),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (value) => {
        states[index] = typeof value === 'function' ? value(states[index]) : value
      }]
    },
    useEffect(effect) { if (!mounted) effects.push(effect) },
  }
  // 传入 backend 时多个卡片共用同一份权威状态，用来复现两个设置页的并发保存。
  const { backend = null, ...rest } = options
  const harness = setup({ ...rest, backend, react })
  const render = () => { cursor = 0; return harness.component(harness.props) }
  render()
  mounted = true
  for (const effect of effects) effect()
  const nodes = (tree) => (!tree || typeof tree !== 'object' ? [] : [
    tree, ...[tree.props?.children].flat().flatMap(nodes),
  ])
  const buttons = () => nodes(render()).filter((node) => node.type === 'button')
  const inputs = () => nodes(render()).filter((node) => node.type === 'input')
  // 模式开关：卡顶的 role=switch 按钮（children 是 thumb 节点，不能按文案找）。
  const switchButton = () => {
    const node = buttons().find((n) => n.props.role === 'switch')
    assert.ok(node, 'no role="switch" button on the card')
    return node
  }
  return {
    ...harness,
    states,
    render,
    buttons,
    inputs,
    switchButton,
    // 等首次 describe 落地；独立页已展开，兼容卡片才需要点击展开。
    async ready() {
      await new Promise(setImmediate)
      const header = buttons().find((node) => node.props['aria-expanded'] !== undefined)
      if (!header.props['aria-expanded']) header.props.onClick()
    },
    change(type, value) {
      const input = inputs().find((node) => node.props.type === type)
      assert.ok(input, `no input of type ${type}`)
      input.props.onChange({ target: { value } })
    },
    click(label) {
      const button = buttons().find((node) => node.props.children === label)
      assert.ok(button, `no button labelled ${label}`)
      return button.props.onClick()
    },
  }
}

function mountSettings(lifecycle) {
  const module = loadBrowserModule({}, { queueMicrotask: lifecycle.queueMicrotask })
  module.runtime.apply({ ...lifecycle.ctx, get: () => undefined })
  return module
}

const onlyEntry = (lifecycle) => {
  assert.equal(lifecycle.entries.size, 1)
  return [...lifecycle.entries.values()][0]
}

test('browser module keeps slots-only injection and registers one independent Grafana settings section', () => {
  const lifecycle = slotHarness()
  const { definition, runtime } = mountSettings(lifecycle)
  assert.equal(definition.id, 'dsh-grafana')
  // 远端服务缺席不能阻止插件挂载；旧宿主应显示明确的升级提示。
  assert.deepEqual(Array.from(runtime.inject), ['slots'])
  lifecycle.flush()
  assert.deepEqual(lifecycle.injected, ['settings.section', 'settings.plugins.tab', 'settings.plugin.item'])
  const entry = onlyEntry(lifecycle)
  assert.equal(entry.specification.name, 'settings.section')
  assert.equal(entry.specification.id, 'grafana')
  assert.equal(entry.specification.order, 16)
  assert.equal(entry.specification.label, 'Grafana')
  assert.equal('key' in entry.specification, false)
  const { grafanaCard: face, defaultOpen } = entry.card().props
  assert.equal(defaultOpen, true)
  for (const method of ['describe', 'writeSources', 'writeReadOnly', 'setToken', 'unsetToken', 'localePreference']) {
    assert.equal(typeof face[method], 'function', `face.${method} must be a function`)
  }
  assert.equal(lifecycle.maxEntries(), 1)
})

for (const declared of [
  ['settings.section'],
  ['settings.section', 'settings.plugins.tab'],
  ['settings.plugins.tab', 'settings.plugin.item'],
  ['settings.plugins.tab'],
  ['settings.plugin.item'],
]) {
  test(`settings entry selects the first supported route from ${declared.join(', ')}`, () => {
    const lifecycle = slotHarness({ declared })
    mountSettings(lifecycle)
    lifecycle.flush()
    assert.equal(onlyEntry(lifecycle).specification.name, declared[0])
    assert.equal(lifecycle.maxEntries(), 1)
    lifecycle.dispose()
    lifecycle.flush()
    assert.equal(lifecycle.entries.size, 0)
    assert.equal(lifecycle.controllers.size, 0)
  })
}

test('late declarations upgrade and downgrade one settings entry without duplicates', () => {
  const lifecycle = slotHarness({ declared: [] })
  mountSettings(lifecycle)
  lifecycle.flush()
  assert.equal(lifecycle.entries.size, 0)
  for (const name of ['settings.plugin.item', 'settings.plugins.tab', 'settings.section']) {
    lifecycle.declare(name)
    lifecycle.flush()
    assert.equal(onlyEntry(lifecycle).specification.name, name)
  }
  lifecycle.collapse('settings.section')
  lifecycle.flush()
  assert.equal(onlyEntry(lifecycle).specification.name, 'settings.plugins.tab')
  lifecycle.collapse('settings.plugins.tab')
  lifecycle.flush()
  assert.equal(onlyEntry(lifecycle).specification.name, 'settings.plugin.item')
  lifecycle.collapse('settings.plugin.item')
  lifecycle.flush()
  assert.equal(lifecycle.entries.size, 0)
  assert.equal(lifecycle.maxEntries(), 1)
})

test('same-tick declarations choose the section without registering temporary fallbacks', () => {
  const lifecycle = slotHarness({ declared: [] })
  mountSettings(lifecycle)
  lifecycle.declare('settings.plugin.item')
  lifecycle.declare('settings.plugins.tab')
  lifecycle.declare('settings.section')
  lifecycle.flush()
  assert.equal(lifecycle.registered.length, 1)
  assert.equal(onlyEntry(lifecycle).specification.name, 'settings.section')
})

test('same-name same-tick redeclaration replaces the stale registration lifetime', () => {
  const lifecycle = slotHarness()
  mountSettings(lifecycle)
  lifecycle.flush()
  const original = onlyEntry(lifecycle)
  lifecycle.collapse('settings.section')
  lifecycle.declare('settings.section')
  lifecycle.flush()
  assert.notEqual(onlyEntry(lifecycle), original)
  assert.equal(onlyEntry(lifecycle).specification.name, 'settings.section')
  assert.equal(lifecycle.maxEntries(), 1)
})

test('collapse of a non-winning slot does not remount the section or discard its local state', () => {
  const lifecycle = slotHarness()
  mountSettings(lifecycle)
  lifecycle.flush()
  const original = onlyEntry(lifecycle)
  lifecycle.collapse('settings.plugins.tab')
  lifecycle.declare('settings.plugins.tab')
  lifecycle.flush()
  assert.equal(onlyEntry(lifecycle), original)
})

for (const spec of [{ kind: 'keyed', scope: 'root' }, { kind: 'list', scope: 'session' }]) {
  test(`an incompatible section declaration falls back safely (${spec.kind}/${spec.scope})`, () => {
    const lifecycle = slotHarness({ declared: ['settings.plugins.tab'] })
    mountSettings(lifecycle)
    lifecycle.declare('settings.section', spec)
    lifecycle.flush()
    assert.equal(onlyEntry(lifecycle).specification.name, 'settings.plugins.tab')
  })
}

for (const beforeFlush of [true, false]) {
  test(`plugin unload cancels waits and queued registration (${beforeFlush ? 'pending' : 'mounted'})`, () => {
    const lifecycle = slotHarness({ declared: [] })
    mountSettings(lifecycle)
    lifecycle.declare('settings.section')
    if (!beforeFlush) lifecycle.flush()
    lifecycle.dispose()
    lifecycle.flush()
    lifecycle.declare('settings.plugins.tab')
    lifecycle.flush()
    assert.equal(lifecycle.entries.size, 0)
    assert.equal(lifecycle.controllers.size, 0)
    assert.equal(lifecycle.registered.length, beforeFlush ? 0 : 1)
  })
}

test('unload before the controller cleanup cannot revive an entry or leak an inactive-effect error', () => {
  const lifecycle = slotHarness()
  mountSettings(lifecycle)
  lifecycle.beginUnload()
  assert.doesNotThrow(() => lifecycle.flush())
  assert.equal(lifecycle.entries.size, 0)
  assert.equal(lifecycle.controllers.size, 0)
  lifecycle.dispose()
})

test('unload and reload in the same registry create one fresh entry without retained controllers', () => {
  const lifecycle = slotHarness()
  mountSettings(lifecycle)
  lifecycle.flush()
  const original = onlyEntry(lifecycle)
  lifecycle.dispose()
  lifecycle.flush()
  assert.equal(lifecycle.controllers.size, 0)
  lifecycle.resume()
  mountSettings(lifecycle)
  lifecycle.flush()
  assert.notEqual(onlyEntry(lifecycle), original)
  assert.equal(onlyEntry(lifecycle).specification.name, 'settings.section')
  assert.equal(lifecycle.controllers.size, 3)
  assert.equal(lifecycle.maxEntries(), 1)
})

test('a host declaring none of the settings slots stays empty and unloads all waits', () => {
  const lifecycle = slotHarness({ declared: [] })
  mountSettings(lifecycle)
  lifecycle.flush()
  assert.equal(lifecycle.entries.size, 0)
  assert.equal(lifecycle.registered.length, 0)
  lifecycle.dispose()
  lifecycle.flush()
  assert.equal(lifecycle.controllers.size, 0)
})

test('partial injection failure cancels queued registration and previously installed waits', () => {
  const lifecycle = slotHarness({ failInject: 'settings.plugins.tab' })
  assert.throws(() => mountSettings(lifecycle), /slot injection failed/)
  lifecycle.flush()
  assert.equal(lifecycle.entries.size, 0)
  assert.equal(lifecycle.controllers.size, 0)
})

test('real registration errors are not swallowed as unload races', () => {
  const lifecycle = slotHarness()
  lifecycle.slots.register = () => { throw new Error('registration failed') }
  mountSettings(lifecycle)
  assert.throws(() => lifecycle.flush(), /registration failed/)
  lifecycle.dispose()
})

for (const slot of ['settings.plugin.item', 'settings.plugins.tab']) {
  test(`hosts without a declaration probe retain the original ${slot} registration`, () => {
    const lifecycle = slotHarness({ declared: [slot], probe: false })
    mountSettings(lifecycle)
    lifecycle.flush()
    assert.deepEqual(lifecycle.injected, ['settings.plugins.tab', 'settings.plugin.item'])
    assert.equal(onlyEntry(lifecycle).specification.name, slot)
    lifecycle.dispose()
    assert.equal(lifecycle.controllers.size, 0)
  })
}

test('describe reads back every source with its token status and the default source id', async () => {
  const { face } = setup({
    sources: [
      { id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' },
      { id: 'id-eu', name: 'eu', baseUrl: 'https://eu.example.com', tokenRef: 'GRAFANA_TOKEN_ideu' },
    ],
    defaultSource: 'id-eu',
    creds: { GRAFANA_TOKEN_idprod: 'secret' },
  })
  const r = await face.describe()
  assert.equal(JSON.stringify(r), JSON.stringify({
    hostUnsupported: false,
    // 载荷结构有效（读到 namespaces 与 grafana 命名空间）：配置基线可放心
    // 把它当权威状态；unconfirmed 只在信封 ok 但业务载荷缺失时为 true。
    unconfirmed: false,
    sources: [
      { id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod', tokenConfigured: true },
      { id: 'id-eu', name: 'eu', baseUrl: 'https://eu.example.com', tokenRef: 'GRAFANA_TOKEN_ideu', tokenConfigured: false },
    ],
    defaultSource: 'id-eu',
    // 只读模式随命名空间 value 明文返回，卡片据此展示权限边界。
    readOnly: false,
    // 配置版本随 describe 一起取回：写入时回传，用于拒绝基于陈旧基线的覆盖。
    revision: 0,
  }))
})

test('every remote call uses positional arguments, not a single payload object', async () => {
  const { face, calls } = setup({
    sources: [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }],
    defaultSource: 'id-prod',
    creds: { GRAFANA_TOKEN_idprod: 'secret' },
  })
  await face.describe()
  // settings.describe() 不收参数；credentials.describe(refs) 收位置参数数组（不是 { refs }）。
  const settingsCall = calls.find(([m]) => m === 'settings.describe')
  const credCall = calls.find(([m]) => m === 'credentials.describe')
  assert.equal(JSON.stringify(settingsCall[1]), '[]')
  assert.equal(JSON.stringify(credCall[1]), JSON.stringify([['GRAFANA_TOKEN_idprod']]))
})

// 网关 dsh-api-gateway 的 prepareInvocation 按声明参数表严格校验 arity：
// expected = descriptor.parameters.length，values.length !== expected 即抛
// `client api: <endpoint> expected N argument(s), got M`（0.1.2-rc.1 真机报错原文）。
// 类型上可选（union([undefined, number()])）不等于 arity 上可省：第三参必须显式传，可为 void 0。
// 声明个数取自 dsh-api-remotes@0.1.2-rc.1 的 <method>_parameter_<i> schema。
test('every remote call passes exactly the declared number of arguments', async () => {
  const source = { id: 'id-a', name: 'a', baseUrl: 'http://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }
  const { face, calls } = setup({ sources: [source], creds: { GRAFANA_TOKEN_ida: true } })
  await face.describe()
  await face.localePreference()
  await face.writeSources([source], 'id-a')
  await face.setToken('GRAFANA_TOKEN_ida', 'v')
  await assert.rejects(() => face.unsetToken('GRAFANA_TOKEN_ida'), /SHARED_CREDENTIAL_CLEANUP_DISABLED/)
  const declared = {
    'settings.describe': 0,
    'settings.mutate': 3,
    'credentials.describe': 1,
    'credentials.set': 2,
  }
  assert.deepEqual([...new Set(calls.map(([m]) => m))].sort(), Object.keys(declared).sort())
  for (const [method, args] of calls) {
    assert.equal(args.length, declared[method], `${method} must pass ${declared[method]} argument(s), got ${args.length}`)
  }
})

test('describe returns an empty list without touching credentials when no source is configured', async () => {
  const { face, calls } = setup()
  const r = await face.describe()
  assert.equal(JSON.stringify(r), JSON.stringify({ hostUnsupported: false, unconfirmed: false, sources: [], defaultSource: '', readOnly: false, revision: 0 }))
  // 无源站 → 无 tokenRef 可查，不应调用 credentials.describe。
  assert.equal(calls.some(([m]) => m === 'credentials.describe'), false)
})

test('writeSources replaces the whole sources array via one atomic mutate with two set ops', async () => {
  const { face, calls } = setup({
    sources: [{ id: 'old', name: 'old', baseUrl: 'https://old.example.com', tokenRef: 'GRAFANA_TOKEN_old' }],
    defaultSource: 'old',
  })
  await face.writeSources(
    [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }],
    'id-prod',
  )
  // 恰好一次 settings.mutate，且不再有第二次写（旧实现是 unset + update 两步，
  // 第二步失败时 sources 已被清空，存量配置会当场丢失）。
  const writes = calls.filter(([m]) => m === 'settings.mutate' || m === 'settings.update')
  assert.equal(writes.length, 1)
  // mutate(ns, ops, expectedRevision?)：位置参数；第三参留空表示不做乐观并发校验。
  assert.equal(JSON.stringify(writes[0][1].slice(0, 2)), JSON.stringify(['grafana', [
    { op: 'set', path: ['sources'], value: [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }] },
    { op: 'set', path: ['defaultSource'], value: 'id-prod' },
  ]]))
  assert.equal(writes[0][1][2], undefined)
  // 写入后旧源站被整体替换，只剩新源站；id 原样保留（只读，不重新生成）。
  const r = await face.describe()
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].id, 'id-prod')
  assert.equal(r.defaultSource, 'id-prod')
})

test('writeSources derives the token ref from the id when a new source omits it', async () => {
  const { face, calls } = setup()
  await face.writeSources([{ id: 'abc-123', name: 'fresh', baseUrl: 'https://fresh.example.com' }], 'abc-123')
  const mutateCall = calls.find(([m]) => m === 'settings.mutate')
  const sourcesOp = mutateCall[1][1].find((op) => op.path?.[0] === 'sources')
  // 新源站未带 tokenRef → 按 id 派生 GRAFANA_TOKEN_<去横线>，与 Host 端解析一致。
  assert.equal(JSON.stringify(sourcesOp.value), JSON.stringify([{ id: 'abc-123', name: 'fresh', baseUrl: 'https://fresh.example.com', tokenRef: 'GRAFANA_TOKEN_abc123' }]))
})

test('setToken uses its reference while the old deletion facade refuses unsafe cleanup', async () => {
  const { face, calls } = setup()
  await face.setToken('GRAFANA_TOKEN_idprod', 'demo-token')
  const setCall = calls.find(([m]) => m === 'credentials.set')
  assert.equal(JSON.stringify(setCall[1]), JSON.stringify(['GRAFANA_TOKEN_idprod', 'demo-token']))
  await assert.rejects(() => face.unsetToken('GRAFANA_TOKEN_idprod'), /SHARED_CREDENTIAL_CLEANUP_DISABLED/)
  assert.equal(calls.some(([m]) => m === 'credentials.unset'), false)
})

test('removing a source updates only its profile and retains the credential', async () => {
  const card = cardHarness({ ...sharedBackendOptions(), locale: 'en' })
  await card.ready()
  await card.click('Remove source')
  assert.equal(card.state.sources.length, 0)
  assert.equal(card.state.defaultSource, '')
  assert.equal(card.credState.GRAFANA_TOKEN_ida, 'demo-token-original')
  assert.equal(card.calls.some(([m]) => m === 'credentials.unset'), false)
  assert.equal(card.states[5], true)
  assert.match(JSON.stringify(card.render()), /not automatically cleared/)
})

test('localePreference reads the locale namespace preference', async () => {
  const { face } = setup({ locale: 'en' })
  assert.equal(await face.localePreference(), 'en')
})

// 同一组件覆盖独立设置页、兼容 tab 与旧内嵌卡片；验证首屏和异步读取后的文案，
// 防止桌面端 navigator 默认为英文时把插件默认语言也带成英文。
function renderedText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderedText).join('\n')
  return node && typeof node === 'object' ? renderedText(node.props?.children) : ''
}

for (const slot of ['settings.section', 'settings.plugin.item', 'settings.plugins.tab']) {
  for (const [label, navigator] of [
    ['English web browser', { language: 'en-US', languages: ['en-US'] }],
    ['desktop renderer with English navigator', { language: 'en-US', languages: ['en-US'], userAgent: 'Electron' }],
    ['Chinese browser', { language: 'zh-CN', languages: ['zh-CN'] }],
    ['missing navigator', undefined],
  ]) {
    test(`${slot} defaults to Chinese with ${label}`, async () => {
      const card = cardHarness({ slot, locale: '', browserGlobals: { navigator } })
      assert.match(renderedText(card.render()), /Grafana 助手/)
      await card.ready()
      const text = renderedText(card.render())
      for (const caption of ['Grafana 助手', '只读模式', '新增源站', '保存全部源站']) {
        assert.ok(text.includes(caption), `missing Chinese caption: ${caption}`)
      }
      assert.doesNotMatch(text, /Grafana assistant|Add source|Read-only mode/)
    })
  }

  for (const locale of ['system', 'auto', 'fr', '']) {
    test(`${slot} keeps the Chinese default for unresolved locale ${JSON.stringify(locale)}`, async () => {
      const card = cardHarness({ slot, locale, browserGlobals: { navigator: { language: 'en-US' } } })
      await card.ready()
      assert.match(renderedText(card.render()), /新增源站/)
    })
  }

  test(`${slot} keeps Chinese when locale settings cannot be read`, async () => {
    const card = cardHarness({
      slot,
      browserGlobals: { navigator: { language: 'en-US' } },
      fail: { 'settings.describe': 'temporary read failure' },
    })
    await card.ready()
    const text = renderedText(card.render())
    assert.match(text, /Grafana 助手/)
    assert.match(text, /temporary read failure/)
    assert.equal(card.calls.some(([method]) => method === 'settings.mutate'), false)
  })

  test(`${slot} keeps Chinese on a host without locale settings`, async () => {
    const card = cardHarness({ slot, remote: false, browserGlobals: { navigator: { language: 'en-US' } } })
    await card.ready()
    assert.match(renderedText(card.render()), /Grafana 助手/)
    assert.match(renderedText(card.render()), /当前 DSH 宿主版本过旧/)
  })

  for (const [locale, caption] of [['zh', '新增源站'], ['en', 'Add source']]) {
    test(`${slot} honors an explicit ${locale} host preference`, async () => {
      const card = cardHarness({ slot, locale, browserGlobals: { navigator: { language: 'en-US' } } })
      await card.ready()
      assert.ok(renderedText(card.render()).includes(caption))
    })
  }
}

test('the independent settings page is expanded on its first render without enabling unread writes', async () => {
  const card = cardHarness({ slot: 'settings.section' })
  assert.equal(card.buttons()[0].props['aria-expanded'], true)
  for (const caption of ['只读模式', '新增源站', '保存全部源站']) {
    assert.ok(renderedText(card.render()).includes(caption), `missing first-render caption: ${caption}`)
  }
  assert.equal(card.switchButton().props.disabled, true)
  assert.equal(card.buttons().find((node) => node.props.children === '保存全部源站').props.disabled, true)
  assert.equal(card.calls.some(([method]) => method === 'settings.mutate'), false)
  await card.ready()
  assert.equal(card.buttons()[0].props['aria-expanded'], true)
  assert.equal(card.switchButton().props.disabled, false)
  card.buttons()[0].props.onClick()
  assert.equal(card.buttons()[0].props['aria-expanded'], false)
  assert.equal(card.calls.some(([method]) => method === 'settings.mutate'), false)
})

for (const slot of ['settings.plugin.item', 'settings.plugins.tab']) {
  test(`the compatibility ${slot} card keeps its collapsed first render`, async () => {
    const card = cardHarness({ slot })
    assert.equal(card.buttons()[0].props['aria-expanded'], false)
    assert.doesNotMatch(renderedText(card.render()), /新增源站|保存全部源站/)
    await card.ready()
    assert.equal(card.buttons()[0].props['aria-expanded'], true)
  })
}

test('the independent page reuses source save, token masking and mode writes without changing stored identities', async () => {
  const backend = sharedBackend()
  const card = cardHarness({ slot: 'settings.section', backend })
  await card.ready()
  const original = { ...backend.state.sources[0] }
  const originalCreds = { ...backend.credState }
  const token = card.inputs().find((node) => node.props.type === 'password')
  assert.match(token.props.value, /^\*+$/)
  assert.notEqual(token.props.value, originalCreds[original.tokenRef])
  card.change('text', 'renamed')
  await card.click('Save this source')
  assert.deepEqual(backend.state.sources, [{ ...original, name: 'renamed' }])
  assert.deepEqual(backend.credState, originalCreds)
  assert.equal(backend.state.defaultSource, original.id)
  await card.switchButton().props.onClick()
  assert.equal(backend.state.readOnly, true)
  assert.deepEqual(backend.state.sources, [{ ...original, name: 'renamed' }])
  assert.deepEqual(backend.credState, originalCreds)
  const writes = card.calls.filter(([method]) => method === 'settings.mutate')
  assert.deepEqual(writes.map(([, args]) => args.length), [3, 3])
  assert.equal(JSON.stringify(writes[1][1][1]), JSON.stringify([{ op: 'set', path: ['readOnly'], value: true }]))
})

test('the independent page exposes a failed initial read and keeps all remote writes blocked', async () => {
  const card = cardHarness({ slot: 'settings.section', fail: { 'settings.describe': 'temporary read failure' } })
  await card.ready()
  assert.equal(card.buttons()[0].props['aria-expanded'], true)
  assert.match(renderedText(card.render()), /temporary read failure/)
  assert.equal(card.switchButton().props.disabled, true)
  assert.equal(card.buttons().find((node) => node.props.children === '保存全部源站').props.disabled, true)
  assert.equal(card.calls.some(([method]) => method === 'settings.mutate'), false)
})

test('internals derive token refs, generate unique read-only ids, normalize and validate source lists', () => {
  const { tokenRefForId, generateSourceId, normalizeSource, validateSources } = loadBrowserRuntime().internals
  // tokenRef：剥离横线、加固定前缀，与 Host 端 lib/util.js 逐字一致。
  assert.equal(tokenRefForId('id-prod'), 'GRAFANA_TOKEN_idprod')
  assert.equal(tokenRefForId('a1b2-c3d4'), 'GRAFANA_TOKEN_a1b2c3d4')
  // id：crypto.randomUUID 形状，两次生成全球唯一。
  const a = generateSourceId()
  const b = generateSourceId()
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.notEqual(a, b)
  // normalizeSource：无 id 丢弃；tokenRef 缺省按 id 派生。
  assert.equal(normalizeSource({ name: 'x' }), null)
  assert.equal(JSON.stringify(normalizeSource({ id: 'abc', name: 'n', baseUrl: 'u' })), JSON.stringify({ id: 'abc', name: 'n', baseUrl: 'u', tokenRef: 'GRAFANA_TOKEN_abc' }))
  // validateSources：数量受限（与 Host MAX_SOURCES 一致）、名称必填、唯一、限长，URL 合法（沿用 new URL 校验）。
  const m = { nameRequired: 'NAME_REQUIRED', nameDuplicate: 'DUP', nameTooLong: 'LONG', invalidUrl: 'BAD_URL', tooManySources: 'TOO_MANY' }
  assert.throws(() => validateSources(Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, name: `s${i}` })), m), /TOO_MANY/)
  assert.throws(() => validateSources([{ id: '1', name: '   ' }], m), /NAME_REQUIRED/)
  assert.throws(() => validateSources([{ id: '1', name: 'a' }, { id: '2', name: 'a' }], m), /DUP/)
  assert.throws(() => validateSources([{ id: '1', name: 'a'.repeat(101) }], m), /LONG/)
  assert.throws(() => validateSources([{ id: '1', name: 'a', baseUrl: 'not a url' }], m), /BAD_URL/)
  assert.throws(() => validateSources([{ id: '1', name: 'a', baseUrl: 'https://user:pass@x.example.com' }], m), /BAD_URL/)
  // 合法列表不抛错；名称大小写敏感（'a' 与 'A' 视为不同）。
  validateSources([{ id: '1', name: 'prod', baseUrl: 'https://prod.example.com' }, { id: '2', name: 'A' }], m)
})

test('settingsNamespacesOf reads the namespaces aggregate out of a successful describe value', () => {
  const { settingsNamespacesOf } = loadBrowserRuntime().internals
  // 真机取证（0.1.2-rc.1）：settings.describe() 的应答是 { ok, value }，
  // value = { writable, hasDocument, namespaces[] }。它不是“直接返回描述符数组”：
  // 数组在 value.namespaces 里。本函数只负责结构解析（拆信封与 ok 判定由 unwrap 做）。
  const descriptors = [
    { ns: 'grafana', value: { sources: [] }, applies: 'live', secrets: [], revision: 0 },
    { ns: 'locale', value: { preference: 'zh' }, applies: 'live', secrets: [], revision: 0 },
  ]
  assert.deepEqual(settingsNamespacesOf({ writable: true, hasDocument: true, namespaces: descriptors }), descriptors)
  // 空值/畸形 value 回退空数组（卡片降级路径，不抛错）。
  for (const bad of [undefined, null, {}, { writable: true }, { namespaces: 'broken' }]) {
    const out = settingsNamespacesOf(bad)
    assert.equal(Array.isArray(out), true)
    assert.equal(out.length, 0)
  }
})

test('describe reports an unsupported host instead of rendering an empty source list', async () => {
  // 没有 remote.settings / remote.credentials 的旧宿主：卡片必须能据此显式提示升级，
  // 而不是渲染成“尚未配置源站”的空白态（这就是本缺陷的原始症状）。
  const { face, calls } = setup({ remote: false })
  const r = await face.describe()
  assert.equal(JSON.stringify(r), JSON.stringify({ hostUnsupported: true, sources: [], defaultSource: '', readOnly: false, unconfirmed: true }))
  // 未命中远端门面时不应发出任何远端调用。
  assert.equal(calls.length, 0)
  // 语言偏好在旧宿主上退回浏览器语言（空串），不抛错。
  assert.equal(await face.localePreference(), '')
  // 写路径必须抛稳定错误码，绝不能静默“成功”。
  await assert.rejects(() => face.setToken('GRAFANA_TOKEN_x', 'tok'), /HOST_UNSUPPORTED/)
  await assert.rejects(() => face.unsetToken('GRAFANA_TOKEN_x'), /SHARED_CREDENTIAL_CLEANUP_DISABLED/)
  await assert.rejects(() => face.writeSources([{ id: 'a', name: 'a' }], 'a'), /HOST_UNSUPPORTED/)
})

test('a rejected settings.describe surfaces its message instead of being swallowed', async () => {
  const { face } = setup({
    sources: [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }],
    defaultSource: 'id-prod',
    fail: { 'settings.describe': 'settings document is locked' },
  })
  await assert.rejects(() => face.describe(), /settings document is locked/)
})

test('a rejected credentials.describe reports unknown without leaking the provider error', async () => {
  // 旧实现在这里抛 TypeError 并被卡片的 .catch(() => {}) 吞掉，导致令牌状态恒显示“未配置”。
  const { face } = setup({
    sources: [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }],
    defaultSource: 'id-prod',
    creds: { GRAFANA_TOKEN_idprod: 'secret' },
    fail: { 'credentials.describe': 'credential store unavailable' },
  })
  const described = await face.describe()
  assert.equal(described.unconfirmed, false)
  assert.equal(described.sources.length, 1)
  assert.equal(described.sources[0].tokenConfigured, null)
})

test('writeSources surfaces a rejected mutate instead of reporting success', async () => {
  const { face } = setup({ fail: { 'settings.mutate': 'revision conflict' } })
  await assert.rejects(
    () => face.writeSources([{ id: 'a', name: 'a', baseUrl: 'https://a.example.com' }], 'a'),
    /revision conflict/,
  )
})

test('writeSources is one atomic mutate: a rejection never leaves a half-written list', async () => {
  // mutate 被拒（校验失败/revision 冲突）时 op 数组整体不落地——不存在「unset 已生效、
  // 新值未写入」的中间态把源站列表清空。
  const { face, calls } = setup({
    sources: [{ id: 'old', name: 'old', baseUrl: 'https://old.example.com', tokenRef: 'GRAFANA_TOKEN_old' }],
    defaultSource: 'old',
    fail: { 'settings.mutate': 'validation refused' },
  })
  await assert.rejects(
    () => face.writeSources([{ id: 'a', name: 'a', baseUrl: 'https://a.example.com' }], 'a'),
    /validation refused/,
  )
  // 被拒之后再无第二次写尝试（旧实现会继续发 settings.update）。
  assert.equal(calls.filter(([m]) => m === 'settings.mutate' || m === 'settings.update').length, 1)
  // 存储值原样保留：describe 读回仍是旧源站。
  const r = await face.describe()
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].id, 'old')
})

test('setToken surfaces a rejected credential write', async () => {
  const { face } = setup({ fail: { 'credentials.set': 'credential store is read-only' } })
  await assert.rejects(() => face.setToken('GRAFANA_TOKEN_x', 'tok'), /credential store is read-only/)
})

test('unsafe credential deletion is refused before contacting the provider', async () => {
  const { face, calls } = setup({ fail: { 'credentials.unset': 'credential store is read-only' } })
  await assert.rejects(() => face.unsetToken('GRAFANA_TOKEN_x'), /SHARED_CREDENTIAL_CLEANUP_DISABLED/)
  assert.equal(calls.length, 0)
})

// 移除只写当前 profile 配置，任何凭证状态下都不自动删除共享凭证。
test('removeSourceRemote retains credentials for every status and propagates settings rejection', async () => {
  const { removeSourceRemote } = loadBrowserRuntime().internals
  const source = sharedBackendOptions().sources[0]
  for (const tokenConfigured of [true, false, null]) {
    const { face, calls, credState } = setup(sharedBackendOptions())
    const outcome = await removeSourceRemote(face, {
      nextSources: [], nextDefault: '', tokenRef: source.tokenRef, tokenConfigured,
    })
    assert.equal(outcome.tokenRetained, true)
    assert.deepEqual(calls.map(([method]) => method), ['settings.mutate'])
    assert.equal(credState[source.tokenRef], 'demo-token-original')
    assert.equal((await face.describe()).sources.length, 0)
  }
  const { face, calls } = setup({ ...sharedBackendOptions(), fail: { 'settings.mutate': 'revision conflict' } })
  await assert.rejects(() => removeSourceRemote(face, {
    nextSources: [], nextDefault: '', tokenRef: source.tokenRef,
  }), /revision conflict/)
  assert.equal(calls.some(([m]) => m === 'credentials.unset'), false)
  assert.equal((await face.describe()).sources.length, 1)
})

test('retention and unknown-state captions exist in both locales without a cleanup retry', () => {
  const { STRINGS } = loadBrowserRuntime().internals
  for (const lang of ['zh', 'en']) {
    for (const key of ['removedCredentialRetained', 'replacedCredentialRetained', 'writtenCredentialRetained', 'statusUnknown', 'tokenHintUnknown', 'sharedCredentialHint']) {
      assert.equal(typeof STRINGS[lang][key], 'string')
      assert.ok(STRINGS[lang][key].length > 0)
    }
    assert.equal(STRINGS[lang].retryTokenCleanup, undefined)
    assert.ok(STRINGS[lang].removedCredentialRetained.includes('{name}'))
  }
})

// 保留说明逐项累积，同一引用不重复添加。
test('retained-credential notices accumulate and deduplicate per reference', () => {
  const { mergeRetainedCredential } = loadBrowserRuntime().internals
  let list = mergeRetainedCredential([], { ref: 'GRAFANA_TOKEN_ida', name: 'a', kind: 'removed' })
  list = mergeRetainedCredential(list, { ref: 'GRAFANA_TOKEN_idb', name: 'b', kind: 'replaced' })
  list = mergeRetainedCredential(list, { ref: 'GRAFANA_TOKEN_idb', kind: 'staged' })
  assert.equal(list.length, 2)
  assert.equal(list[1].name, 'b')
  assert.equal(list[1].kind, 'staged')
  assert.equal(JSON.stringify(mergeRetainedCredential(null, { ref: 'r' })), JSON.stringify([{ ref: 'r' }]))
})

// 删除写入成功后必须立即按已知结果推进本地：远端已生效，回读失败时界面不能继续
// 显示已被删除的源站卡片（否则用户会基于过期卡片继续操作）。
test('the local state advances on a successful removal write without waiting for the reread', () => {
  const { localStateAfterRemoval } = loadBrowserRuntime().internals
  const sources = [
    { id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod', tokenDraft: '' },
    { id: 'id-eu', name: 'eu', baseUrl: 'https://eu.example.com', tokenRef: 'GRAFANA_TOKEN_ideu', tokenDraft: '' },
    // 从未落库的新卡片草稿：不该被别的源站移除冲掉。
    { id: 'new', name: '', baseUrl: '', tokenRef: 'GRAFANA_TOKEN_new', tokenDraft: 'tok' },
  ]
  // 删除的正是默认源站：默认改指另一个已存源站，存储基线换成刚写入的列表。
  const next = localStateAfterRemoval({
    sources,
    removedId: 'id-prod',
    nextSources: [{ id: 'id-eu', name: 'eu', baseUrl: 'https://eu.example.com', tokenRef: 'GRAFANA_TOKEN_ideu' }],
    nextDefault: 'id-eu',
  })
  assert.equal(JSON.stringify(next.sources.map((s) => s.id)), JSON.stringify(['id-eu', 'new']))
  assert.equal(next.sources[1].tokenDraft, 'tok')
  assert.equal(JSON.stringify(next.stored.map((s) => s.id)), JSON.stringify(['id-eu']))
  assert.equal(next.defaultSource, 'id-eu')
  // 删掉最后一个已存源站：默认置空（不得继续指向已删除的 id）。
  const cleared = localStateAfterRemoval({ sources, removedId: 'id-eu', nextSources: [], nextDefault: '' })
  assert.equal(JSON.stringify(cleared.sources.map((s) => s.id)), JSON.stringify(['id-prod', 'new']))
  assert.equal(JSON.stringify(cleared.stored), '[]')
  assert.equal(cleared.defaultSource, '')
})

test('consecutive source removals retain both credentials and both notices', async () => {
  const card = cardHarness({ locale: 'en', sources: [
    { id: 'a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_a' },
    { id: 'b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_b' },
  ], creds: { GRAFANA_TOKEN_a: 'demo-a', GRAFANA_TOKEN_b: 'demo-b' } })
  await card.ready()
  await card.click('Remove source')
  await card.click('Remove source')
  assert.equal(card.state.sources.length, 0)
  assert.equal(card.states[7].length, 2)
  assert.equal(card.credState.GRAFANA_TOKEN_a, 'demo-a')
  assert.equal(card.credState.GRAFANA_TOKEN_b, 'demo-b')
  assert.equal(card.calls.some(([m]) => m === 'credentials.unset'), false)
})

// 配置允许多个源站共用一个自定义 tokenRef：移除其中一个时，剩余源站仍引用的
// 凭证不能被回收——「被移除的卡片不再用它」不等于「无人在用」，凭证只写不读，
// 删掉在用的就再也拿不回来。移除路径与保存路径的轮换保护遵守同一原则。
test('removing one source keeps the token another source still shares', async () => {
  const internals = loadBrowserRuntime().internals
  const shared = 'GRAFANA_TOKEN_shared'
  const alpha = { id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: shared }
  const beta = { id: 'id-b', name: 'b', baseUrl: 'https://beta.example.com', tokenRef: shared }
  const { face, calls, state } = setup({ sources: [alpha, beta], defaultSource: 'id-a', creds: { [shared]: 'demo-shared' } })
  const outcome = await internals.removeSourceRemote(face, {
    nextSources: [beta], nextDefault: 'id-b', tokenRef: shared, tokenConfigured: true,
  })
  assert.equal(JSON.stringify(outcome), JSON.stringify({ tokenRetained: true }))
  // 未发 unset：剩余源站仍引用该凭证。
  assert.equal(calls.some(([m]) => m === 'credentials.unset'), false)
  assert.equal(state.creds[shared], 'demo-shared')
  // 剩余源站的令牌仍可用。
  const described = await face.describe()
  assert.equal(described.sources.some((s) => s.id === 'id-b' && s.tokenConfigured), true)
})

// 移除后用于确认引用的读取收到畸形载荷（信封 ok 但没有 namespaces / grafana 命名空间）：
// 这是「无法确认」，不是「权威的空列表」——当空集合用会放行对共享凭证的删除。
test('a malformed post-removal describe keeps the shared token instead of treating it as unreferenced', async () => {
  const internals = loadBrowserRuntime().internals
  const shared = 'GRAFANA_TOKEN_shared'
  const alpha = { id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: shared }
  const beta = { id: 'id-b', name: 'b', baseUrl: 'https://beta.example.com', tokenRef: shared }
  const { face, state, settings } = setup({ sources: [alpha, beta], defaultSource: 'id-a', creds: { [shared]: 'demo-shared' } })
  const realDescribe = settings.describe
  let malformedOnce = false
  settings.describe = async (...args) => {
    // 保存（移除写入）成功后的第一次同步读取：{ok:true,value:{}}。
    if (!malformedOnce) {
      malformedOnce = true
      return { ok: true, value: {} }
    }
    return realDescribe(...args)
  }
  const outcome = await internals.removeSourceRemote(face, {
    nextSources: [beta], nextDefault: 'id-b', tokenRef: shared, tokenConfigured: true,
  })
  assert.equal(JSON.stringify(outcome), JSON.stringify({ tokenRetained: true }))
  // 共享凭证仍在（后续 describe 恢复正常后可见剩余源站仍在引用它）。
  assert.equal(state.creds[shared], 'demo-shared')
  assert.equal((await face.describe()).unconfirmed, true)
  const described = await face.describe()
  assert.equal(described.unconfirmed, false)
  assert.equal(described.sources.some((s) => s.id === 'id-b' && s.tokenConfigured), true)
})

// 旧宿主（describe 同时带 hostUnsupported 与 unconfirmed）：升级指引优先于
// 「数据无法解析」——不能让不可信读取的提示遮蔽明确的宿主不兼容诊断。
test('an unsupported host shows the upgrade notice, not the unconfirmed-read error', async () => {
  const card = cardHarness({ remote: false })
  await card.ready()
  assert.equal(card.states[3], true)
  assert.equal(String(card.states[6]), '')
  assert.equal(card.states[9], false)
  // Reload 按钮不出现：旧宿主的出路是升级宿主，不是重读。
  assert.equal(card.buttons().some((node) => node.props.children === 'Reload'), false)
})

// 确认框保留共享/无法确认则保留的语义，但不再承诺「界面会如实提示」——
// 那两个保留分支没有对应的界面提示行为，承诺了就是误导。
test('the remove confirmation keeps the shared-credential wording without promising a notice', () => {
  const { STRINGS } = loadBrowserRuntime().internals
  for (const lang of ['zh', 'en']) {
    const text = STRINGS[lang].confirmRemoveSource
    assert.match(text, /profile/)
    assert.match(text, /不会自动清除|not automatically cleared/)
    assert.doesNotMatch(text, /如实提示|says so/)
  }
})

// 保存路径的同形防护（G3 原文场景）：轮换成功后的同步读取畸形时，被替换的
// 共享凭证必须保留——畸形读取不等于「无人引用」。
test('a malformed read after a successful rotation keeps the shared token', async () => {
  const remote = sharedBackend()
  remote.state.sources = [
    { id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: 'GRAFANA_TOKEN_alpha' },
    { id: 'id-b', name: 'b', baseUrl: 'https://beta.example.com', tokenRef: 'GRAFANA_TOKEN_alpha' },
  ]
  remote.state.creds.GRAFANA_TOKEN_alpha = 'demo-shared'
  const card = cardHarness({ backend: remote })
  await card.ready()
  assert.ok(card.states[0].every((row) => row.tokenConfigured))
  const realDescribe = remote.settings.describe
  let armed = false
  let malformedOnce = false
  remote.settings.describe = async (...args) => {
    // 初始加载已完成（armed 后的第一次读取正是保存路径的引用确认）。
    if (armed && !malformedOnce) {
      malformedOnce = true
      return { ok: true, value: {} }
    }
    return realDescribe(...args)
  }
  card.change('password', 'demo-alpha-replacement')
  armed = true
  await card.click('Save this source')
  // 配置保存成功，但首次同步读取不可信，必须显示同步错误。
  assert.equal(card.states[5], false)
  assert.match(card.states[6], /cannot be parsed/)
  const [alpha, beta] = remote.state.sources
  assert.equal(remote.state.creds[alpha.tokenRef], 'demo-alpha-replacement')
  // 第二源站仍指向原引用；畸形读取没有被当成「无人引用」，共享凭证必须还在。
  assert.equal(beta.tokenRef, 'GRAFANA_TOKEN_alpha')
  assert.equal(remote.state.creds.GRAFANA_TOKEN_alpha, 'demo-shared')
})

// 结构有效性按宿主契约判定（Host 端 Config 定义 sources: array(...).default([])，
// 写入口保证每行可识别）：value 非对象、sources 非数组、条目被 normalizeSource
// 丢弃，都不是合法配置——unconfirmed 必须为 true；合法空配置（sources: []）为 false。
test('face.describe marks structurally invalid source payloads as unconfirmed', async () => {
  for (const [value, expected] of [
    [{}, true],
    [{ sources: 'invalid' }, true],
    [{ sources: [null] }, true],
    ['not-an-object', true],
    [{ sources: [] }, false],
    [{ sources: [{ id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }] }, false],
  ]) {
    const remote = sharedBackend()
    const describe = remote.settings.describe
    remote.settings.describe = async () => ({ ok: true, value: { namespaces: [{ ns: 'grafana', revision: 1, value }] } })
    const { face } = setup({ backend: remote })
    const r = await face.describe()
    assert.equal(r.unconfirmed, expected, `payload ${JSON.stringify(value)} must be unconfirmed=${expected}`)
    assert.equal(r.unconfirmed, expected)
    remote.settings.describe = describe
  }
})

// 命名空间在场但业务载荷无效（三种形状）：轮换成功后的同步读取返回这种载荷，
// 不能把它当成「权威的空列表」替换配置基线。
test('a namespace with a malformed source payload is unconfirmed, not an empty list', async () => {
  for (const value of [{}, { sources: 'invalid' }, { sources: [null] }]) {
    const remote = sharedBackend()
    remote.state.sources = [
      { id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: 'GRAFANA_TOKEN_alpha' },
      { id: 'id-b', name: 'b', baseUrl: 'https://beta.example.com', tokenRef: 'GRAFANA_TOKEN_alpha' },
    ]
    remote.state.creds.GRAFANA_TOKEN_alpha = 'demo-shared'
    const card = cardHarness({ backend: remote })
    await card.ready()
    assert.ok(card.states[0].every((row) => row.tokenConfigured))
    const mutate = remote.settings.mutate
    const describe = remote.settings.describe
    let next = false
    remote.settings.mutate = async (...args) => { const result = await mutate(...args); next = true; return result }
    remote.settings.describe = async (...args) => {
      // 写入成功后的第一次同步读取：命名空间在场、业务载荷无效。
      if (next) { next = false; return { ok: true, value: { namespaces: [{ ns: 'grafana', revision: 1, value }] } } }
      return describe(...args)
    }
    card.change('password', 'demo-alpha-replacement')
    await card.click('Save this source')
    const [alpha, beta] = remote.state.sources
    assert.equal(remote.state.creds[alpha.tokenRef], 'demo-alpha-replacement')
    // 第二源站仍指向共享引用；同步失败不会触发任何凭证删除。
    assert.equal(beta.tokenRef, 'GRAFANA_TOKEN_alpha')
    assert.equal(remote.state.creds.GRAFANA_TOKEN_alpha, 'demo-shared')
    assert.equal(card.states[0][1].tokenConfigured, true)
  }
})

// 初次读取 unconfirmed（信封 ok 但载荷缺失）：不能清空基线并开放写入——否则随后
// 一次保存不带修订号，把已存源站整表替换成新卡。出路是 Reload：恢复正常后替换
// 基线、带修订号写入。
test('an unconfirmed initial read keeps the card read-only instead of enabling an empty-baseline save', async () => {
  const remote = sharedBackend()
  const describe = remote.settings.describe
  remote.settings.describe = async () => ({ ok: true, value: {} })
  const card = cardHarness({ backend: remote })
  await card.ready()
  // 未就绪：loaded=false、错误指路 Reload、新增被拦（本地仍是空草稿，不是降级基线）。
  assert.equal(card.states[9], false)
  assert.match(String(card.states[6]), /配置数据无法解析/)
  card.click('新增源站')
  assert.equal(card.states[0].length, 0)
  // 恢复正常后 Reload：基线替换、开放写入。
  remote.settings.describe = describe
  await card.click('重新读取')
  assert.equal(card.states[9], true)
  assert.equal(card.states[0].length, 1)
  assert.equal(String(card.states[6]), '')
  // 此时保存带修订号（写入不再是空基线的整表覆盖）。
  card.change('password', 'demo-replacement')
  await card.click('保存当前源站')
  assert.equal(remote.state.writes.at(-1).expectedRevision, 0)
  assert.equal(remote.state.sources.length, 1)
  const activeRef = remote.state.sources[0].tokenRef
  assert.equal(remote.state.creds[activeRef], 'demo-replacement')
})

// 保存成功但写后回读 unconfirmed：保存已生效（新凭证在库），界面如实显示同步失败
// 而不是「已保存」；基线不被畸形载荷清空，恢复正常后 Reload 即回到一致状态。
test('a successful save whose resync read is unconfirmed reports the sync failure, not success', async () => {
  const remote = sharedBackend()
  const describe = remote.settings.describe
  let malformed = false
  remote.settings.describe = async (...args) => {
    if (malformed) return { ok: true, value: {} }
    return describe(...args)
  }
  const card = cardHarness({ backend: remote })
  await card.ready()
  card.change('password', 'demo-replacement')
  malformed = true
  await card.click('Save this source')
  // 保存已生效，但回读无法确认：不显示「已保存」，显示读取错误；基线未被清空。
  assert.equal(card.states[5], false)
  assert.match(String(card.states[6]), /cannot be parsed/)
  const activeRef = remote.state.sources[0].tokenRef
  assert.equal(remote.state.creds[activeRef], 'demo-replacement')
  assert.equal(card.states[0].length, 1)
  // 恢复正常后的下一次保存（草稿未清，仍可保存）以旧基线的修订号触发冲突，
  // 冲突路径的重读把卡片带回一致状态——显示新令牌已配置。
  malformed = false
  await card.click('Save this source')
  assert.match(String(card.states[6]), /revision conflict/)
  assert.equal(card.states[0][0].tokenConfigured, true)
})

test('the card dictionary carries the host-too-old notice in both locales', () => {
  const { STRINGS } = loadBrowserRuntime().internals
  for (const lang of ['zh', 'en']) {
    assert.equal(typeof STRINGS[lang].hostTooOld, 'string', `${lang}.hostTooOld must exist`)
    assert.ok(STRINGS[lang].hostTooOld.length > 0)
  }
  assert.notEqual(STRINGS.zh.hostTooOld, STRINGS.en.hostTooOld)
})

// —— 源站卡片级保存的纯函数语义。卡片没有 DOM harness，故「只提交本卡片」的
// 合并/脏判定/整表投影逻辑抽到 internals 单测；按钮接线层沿用现状不可测。

test('nextSourcesFor replaces only the saved card and appends brand-new cards', () => {
  const { nextSourcesFor } = loadBrowserRuntime().internals
  const stored = [
    { id: 'a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_a' },
    { id: 'b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_b' },
  ]
  // 已存在的源站卡片：只替换自己，其它卡片原样（连顺序都不变）。
  const edited = { id: 'b', name: 'b-renamed', baseUrl: 'https://b2.example.com', tokenRef: 'GRAFANA_TOKEN_b' }
  assert.equal(JSON.stringify(nextSourcesFor(stored, edited)), JSON.stringify([stored[0], {
    id: 'b', name: 'b-renamed', baseUrl: 'https://b2.example.com', tokenRef: 'GRAFANA_TOKEN_b',
  }]))
  // 新增卡片：追加到末尾，不动已有卡片。
  const fresh = { id: 'c', name: 'c', baseUrl: 'https://c.example.com', tokenRef: 'GRAFANA_TOKEN_c' }
  assert.equal(JSON.stringify(nextSourcesFor(stored, fresh)), JSON.stringify([...stored, fresh]))
  // 名称/URL 去首尾空白；tokenRef 缺省时按 id 推导。
  const sloppy = { id: 'a', name: '  a2  ', baseUrl: ' https://a9.example.com ', tokenRef: '' }
  assert.equal(JSON.stringify(nextSourcesFor(stored, sloppy)), JSON.stringify([{
    id: 'a', name: 'a2', baseUrl: 'https://a9.example.com', tokenRef: 'GRAFANA_TOKEN_a',
  }, stored[1]]))
})

test('rowDirty flags unsaved cards, edited fields and token drafts only', () => {
  const { rowDirty } = loadBrowserRuntime().internals
  const stored = [{ id: 'a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_a' }]
  const byId = new Map(stored.map((s) => [s.id, s]))
  const clean = { ...stored[0], tokenDraft: '' }
  assert.equal(rowDirty(clean, byId), false)
  // 与存储值仅差首尾空白 → 不算脏（写入时本来就会 trim）。
  assert.equal(rowDirty({ ...clean, name: ' a ' }, byId), false)
  assert.equal(rowDirty({ ...clean, name: 'a2' }, byId), true)
  assert.equal(rowDirty({ ...clean, baseUrl: 'https://x.example.com' }, byId), true)
  assert.equal(rowDirty({ ...clean, tokenDraft: '   ' }, byId), false)
  assert.equal(rowDirty({ ...clean, tokenDraft: 'tok' }, byId), true)
  // 存储里不存在 = 新增卡片 = 脏。
  assert.equal(rowDirty({ id: 'z', name: 'z', baseUrl: '', tokenRef: 'GRAFANA_TOKEN_z', tokenDraft: '' }, byId), true)
})

test('mergeDrafts keeps other cards’ drafts and drops cards removed from the store', () => {
  const { mergeDrafts } = loadBrowserRuntime().internals
  const drafts = [
    { id: 'a', name: 'a-draft', baseUrl: 'https://draft.example.com', tokenRef: 'GRAFANA_TOKEN_a', tokenConfigured: false, tokenDraft: 'tok', tokenFocus: true },
    { id: 'b', name: 'b-draft', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_b', tokenConfigured: true, tokenDraft: '', tokenFocus: false },
    { id: 'new', name: '', baseUrl: '', tokenRef: 'GRAFANA_TOKEN_new', tokenConfigured: false, tokenDraft: '', tokenFocus: false },
  ]
  // 存储里 a 的令牌已被别处配置、b 已被移除、new 从未写入。
  const described = [
    { id: 'a', name: 'a-stored', baseUrl: 'https://stored.example.com', tokenRef: 'GRAFANA_TOKEN_a', tokenConfigured: true },
  ]
  const merged = mergeDrafts(described, drafts, undefined, drafts.slice(0, 2))
  assert.equal(merged.length, 2)
  // a：草稿（含令牌草稿与聚焦态）保留，但 tokenConfigured 以存储为准刷新。
  assert.equal(merged[0].id, 'a')
  assert.equal(merged[0].name, 'a-draft')
  assert.equal(merged[0].tokenDraft, 'tok')
  assert.equal(merged[0].tokenFocus, true)
  assert.equal(merged[0].tokenConfigured, true)
  // new：存储里没有，草稿原样保留（未保存的新卡片不能被回读冲掉）。
  assert.equal(merged[1].id, 'new')
  // b：存储里已移除 → 草稿一并丢弃。
  assert.equal(merged.some((s) => s.id === 'b'), false)
  // 存储里新增而草稿没有的卡片：补进来并初始化草稿字段。
  const withExtra = mergeDrafts([...described, {
    id: 'c', name: 'c', baseUrl: 'https://c.example.com', tokenRef: 'GRAFANA_TOKEN_c', tokenConfigured: false,
  }], drafts, undefined, drafts.slice(0, 2))
  const c = withExtra.find((s) => s.id === 'c')
  assert.equal(c.tokenDraft, '')
  assert.equal(c.tokenFocus, false)
})

test('canSetDefault refuses unsaved drafts so the default never dangles', () => {
  const { canSetDefault } = loadBrowserRuntime().internals
  const storedById = new Map([
    ['a', { id: 'a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_a' }],
  ])
  // 已落库的卡片（哪怕正带着未保存的名称草稿）可以设默认：默认指向存在的 id。
  assert.equal(canSetDefault({ id: 'a', name: 'a-draft' }, storedById), true)
  // 未落库的新卡片不行：把 defaultSource 写成不存在的 id 会让 Host 端判定多源站
  // 无有效默认，而客户端草稿仍显示为默认，UI 与运行时从此不一致。
  assert.equal(canSetDefault({ id: 'new' }, storedById), false)
  // 空存储、缺参与畸形入参一律拒绝。
  assert.equal(canSetDefault({ id: 'a' }, new Map()), false)
  assert.equal(canSetDefault(null, storedById), false)
  assert.equal(canSetDefault(undefined, storedById), false)
})

test('the per-card and save-all captions exist in both locales', () => {
  const { STRINGS } = loadBrowserRuntime().internals
  for (const lang of ['zh', 'en']) {
    for (const key of ['saveCurrentSource', 'saveAllSources', 'unsavedBadge']) {
      assert.equal(typeof STRINGS[lang][key], 'string', `${lang}.${key} must exist`)
      assert.ok(STRINGS[lang][key].length > 0)
    }
  }
  assert.notEqual(STRINGS.zh.saveCurrentSource, STRINGS.en.saveCurrentSource)
  assert.notEqual(STRINGS.zh.saveAllSources, STRINGS.en.saveAllSources)
})

// ── 保存并发：整表替换必须带版本检查 ──────────────────────────────────────────
test('writeSources sends the revision it last read so a stale page cannot overwrite a newer one', async () => {
  const source = { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }
  const { face, calls } = setup({ sources: [source], creds: { GRAFANA_TOKEN_ida: true } })
  await face.describe()
  await face.writeSources([{ ...source, name: 'a-edited' }], 'id-a')
  const mutate = calls.find(([m]) => m === 'settings.mutate')
  // 第三参必须显式传（arity 严格），且带上最近一次 describe 读到的版本。
  assert.equal(mutate[1].length, 3)
  assert.equal(mutate[1][2], 0)
  // 未显式传版本时同样按最后一次读取的版本做检查（调用方漏传也不能退化成无条件写）：
  // 重新读取拿到前进后的版本，再一次不传版本地写。
  await face.describe()
  await face.writeSources([{ ...source, name: 'a-edited-2' }], 'id-a', undefined)
  assert.equal(calls.filter(([m]) => m === 'settings.mutate').at(-1)[1][2], 1)
})

test('the browser module rejects a save that would overwrite a newer configuration', async () => {
  const row = (id) => ({ id, name: id, baseUrl: `https://${id}.example.com`, tokenRef: `GRAFANA_TOKEN_${id}` })
  // 两个设置页各读一次同一版本，各自改不同的源站后先后保存。
  const first = setup({ sources: [row('alpha'), row('beta')], defaultSource: 'alpha' })
  const second = setup({ sources: [row('alpha'), row('beta')], defaultSource: 'alpha' })
  // 两页共用同一个后端：第二次写入必须被版本检查挡下，而不是把第一次的改动抹掉。
  const backend = first.settings.mutate
  let revision = 0
  const shared = async (ns, ops, expectedRevision) => {
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return { ok: false, error: { message: 'revision conflict' } }
    }
    revision += 1
    return backend(ns, ops)
  }
  first.settings.mutate = shared
  second.settings.mutate = shared
  const initial = await second.face.describe()
  await first.face.writeSources(
    (await first.face.describe()).sources.map((s) => (s.id === 'alpha' ? { ...s, name: 'alpha-edited' } : s)),
    'alpha',
  )
  await assert.rejects(
    second.face.writeSources(initial.sources.map((s) => (s.id === 'beta' ? { ...s, name: 'beta-edited' } : s)), 'alpha'),
    /revision conflict/,
  )
  // 先保存的那一页改动仍在；后一页只是被告知要重试，不是静默丢了另一个源站。
  const after = await first.face.describe()
  assert.deepEqual(after.sources.map((s) => s.name), ['alpha-edited', 'beta'])
})

// ── 令牌与 URL 的一致性 ──────────────────────────────────────────────────────
test('tokenWritePlan stages every token change to a persisted source under a one-off reference', () => {
  const { tokenWritePlan, stagedTokenRef } = loadBrowserRuntime().internals
  const draft = { id: 'id-a', name: 'a', baseUrl: 'https://new.example.com', tokenRef: 'GRAFANA_TOKEN_ida', tokenDraft: 'tok-new' }
  const stored = { id: 'id-a', name: 'a', baseUrl: 'https://old.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }
  // 已落库的源站一律暂存：只改令牌同样可能被配置的版本检查拒绝，而凭证写入在检查之前。
  const staged = tokenWritePlan(draft, stored)
  assert.equal(staged.staged, true)
  assert.equal(staged.replaces, 'GRAFANA_TOKEN_ida')
  assert.match(staged.ref, /^GRAFANA_TOKEN_ida_PENDING_[A-Za-z0-9_]+$/)
  const sameUrl = tokenWritePlan({ ...draft, baseUrl: 'https://old.example.com' }, stored)
  assert.equal(sameUrl.staged, true)
  // 每次保存独占一个引用：复用的键会被另一页（或下一次保存）覆盖，或被旧的
  // 「重试清理」提示删掉正在生效的凭证。
  assert.notEqual(staged.ref, sameUrl.ref)
  assert.notEqual(stagedTokenRef('GRAFANA_TOKEN_ida'), stagedTokenRef('GRAFANA_TOKEN_ida'))
  // 从未落库的新源站没有「正在生效的令牌」可被覆盖，就地写入即可。
  const fresh = tokenWritePlan(draft, null)
  assert.equal(fresh.staged, false)
  assert.equal(fresh.ref, 'GRAFANA_TOKEN_ida')
  // 无草稿不产生写入。
  assert.equal(tokenWritePlan({ ...draft, tokenDraft: '' }, stored), null)
})

test('a failed settings write leaves the old token serving the old URL instead of the new one', async () => {
  const card = cardHarness({
    sources: [{ id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }],
    defaultSource: 'id-a',
    creds: { GRAFANA_TOKEN_ida: 'token-alpha' },
    locale: 'en',
  })
  await card.ready()
  card.change('url', 'https://replacement.example.com')
  card.change('password', 'token-replacement')
  // settings 持久化失败（凭证写入发生在前）。
  card.settings.mutate = async () => ({ ok: false, error: { message: 'settings persistence failed' } })
  await card.click('Save this source')
  // 生效配置仍是旧 URL + 旧令牌；新凭证留在独立引用，不回收也不覆盖旧 ref。
  const stored = await card.face.describe()
  assert.equal(stored.sources[0].baseUrl, 'https://alpha.example.com')
  assert.equal(stored.sources[0].tokenRef, 'GRAFANA_TOKEN_ida')
  assert.equal(card.credState.GRAFANA_TOKEN_ida, 'token-alpha')
  assert.equal(Object.keys(card.credState).length, 2)
  assert.equal(card.calls.some(([m]) => m === 'credentials.unset'), false)
  assert.equal(card.states[7][0].kind, 'staged')
  assert.match(String(card.states[6]), /settings persistence failed/)
})

test('a successful token save stops being dirty and does not revert a later rotation', async () => {
  const card = cardHarness({
    sources: [{ id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }],
    defaultSource: 'id-a',
    locale: 'en',
  })
  await card.ready()
  card.change('password', 'token-v1')
  await card.click('Save this source')
  // 保存成功后草稿清空：卡片不再显示「未保存」，按钮随之禁用。
  assert.equal(card.states[0][0].tokenDraft, '')
  assert.equal(card.buttons().find((node) => node.props.children === 'Save this source').props.disabled, true)
  // 别处把令牌轮换到 v2，本页再保存时不得把 v1 写回去。
  card.credState.GRAFANA_TOKEN_ida = 'token-v2'
  await card.click('Save all sources')
  assert.equal(card.credState.GRAFANA_TOKEN_ida, 'token-v2')
  assert.equal(card.calls.filter(([m]) => m === 'credentials.set').length, 1)
})

// 两个页面依次保存同一源站：CAS 拒绝陈旧配置，所有已写入凭证保留。
test('a stale second save cannot delete the credential the winning page just activated', async () => {
  const remote = sharedBackend()
  const first = cardHarness({ backend: remote })
  const second = cardHarness({ backend: remote })
  await first.ready()
  await second.ready()
  first.change('url', 'https://new-a.example.com')
  first.change('password', 'demo-token-a')
  second.change('url', 'https://new-b.example.com')
  second.change('password', 'demo-token-b')
  await first.click('Save this source')
  const activeRef = remote.state.sources[0].tokenRef
  assert.equal(remote.state.creds[activeRef], 'demo-token-a')
  await second.click('Save this source')
  assert.equal(remote.state.sources[0].baseUrl, 'https://new-a.example.com')
  assert.equal(second.states[6], 'revision conflict')
  // 生效凭证仍在；被拒页面的暂存凭证也不自动删除。
  assert.equal(remote.state.creds[activeRef], 'demo-token-a')
})

// 保留说明不再提供删除重试；后来被启用的引用仍安全。
test('retention notices have no unsafe retry even when their credential becomes active', async () => {
  const remote = sharedBackend()
  const card = cardHarness({ backend: remote })
  await card.ready()
  card.change('password', 'demo-token-replacement')
  remote.fail['settings.mutate'] = 'settings write rejected'
  await card.click('Save this source')
  const retained = card.states[7][0].ref
  assert.equal(remote.state.creds[retained], 'demo-token-replacement')
  delete remote.fail['settings.mutate']
  remote.state.sources[0].tokenRef = retained
  remote.state.revision += 1
  await card.click('Reload')
  assert.equal(card.states[0][0].tokenConfigured, true)
  assert.equal(card.buttons().some((b) => /Retry token cleanup|重试清除令牌/.test(String(b.props.children))), false)
  await assert.rejects(() => card.face.unsetToken(retained), /SHARED_CREDENTIAL_CLEANUP_DISABLED/)
  assert.equal(remote.state.creds[retained], 'demo-token-replacement')
  assert.equal(remote.calls.some(([m]) => m === 'credentials.unset'), false)
})

// 配置提交成功但应答丢失（RPC 断开）：不能推断「写入未生效」去删暂存凭证。
test('a lost write response keeps the staged credential instead of deleting a committed one', async () => {
  const remote = sharedBackend()
  const card = cardHarness({ backend: remote })
  await card.ready()
  card.change('url', 'https://replacement.example.com')
  card.change('password', 'demo-token-replacement')
  const mutate = remote.settings.mutate
  remote.settings.mutate = async (...args) => {
    const result = await mutate(...args)
    assert.equal(result.ok, true)
    // 宿主已提交，调用方没收到应答：结果未知，不是拒绝。
    throw new Error('RPC connection lost after commit')
  }
  await card.click('Save this source')
  const activeRef = remote.state.sources[0].tokenRef
  assert.equal(remote.state.sources[0].baseUrl, 'https://replacement.example.com')
  assert.equal(remote.state.creds[activeRef], 'demo-token-replacement')
})

// 只改令牌（URL 不变）同样受保存一致性约束：被 CAS 拒绝的那一页不能已经换掉令牌。
test('a stale token-only save does not overwrite the token another page stored', async () => {
  const remote = sharedBackend()
  const first = cardHarness({ backend: remote })
  const second = cardHarness({ backend: remote })
  await first.ready()
  await second.ready()
  first.change('password', 'demo-token-a')
  second.change('password', 'demo-token-b')
  await first.click('Save this source')
  await second.click('Save this source')
  assert.equal(second.states[6], 'revision conflict')
  const activeRef = remote.state.sources[0].tokenRef
  // 生效的仍是第一页的令牌；第二页那次被拒绝的保存没有覆盖当前凭证。
  assert.equal(remote.state.creds[activeRef], 'demo-token-a')
})

// 配置允许多个源站共用一个自定义 tokenRef：轮换其中一个时，另一个仍在使用的
// 引用不能被当成「已替换」清掉——凭证只写不读，删了就再也拿不回来。
test('rotating one source keeps a credential another source still references', async () => {
  const remote = sharedBackend()
  remote.state.sources = [
    { id: 'id-a', name: 'a', baseUrl: 'https://alpha.example.com', tokenRef: 'GRAFANA_TOKEN_alpha' },
    { id: 'id-b', name: 'b', baseUrl: 'https://beta.example.com', tokenRef: 'GRAFANA_TOKEN_alpha' },
  ]
  remote.state.creds.GRAFANA_TOKEN_alpha = 'demo-shared'
  const card = cardHarness({ backend: remote })
  await card.ready()
  assert.ok(card.states[0].every((row) => row.tokenConfigured))
  card.change('password', 'demo-alpha-replacement')
  await card.click('Save this source')
  assert.equal(card.states[5], true)
  const [alpha, beta] = remote.state.sources
  assert.equal(remote.state.creds[alpha.tokenRef], 'demo-alpha-replacement')
  // 第二源站仍指向原引用，凭证必须还在。
  assert.equal(beta.tokenRef, 'GRAFANA_TOKEN_alpha')
  assert.equal(remote.state.creds.GRAFANA_TOKEN_alpha, 'demo-shared')
  assert.equal(card.states[0][1].tokenConfigured, true)
})

// 信封缺失/畸形不等于明确拒绝：宿主可能已经提交，不能回滚（删除已生效凭证）。
test('a malformed reply after commit is treated as unknown, not as a rejection', async () => {
  const remote = sharedBackend()
  const card = cardHarness({ backend: remote })
  await card.ready()
  card.change('password', 'demo-replacement')
  const mutate = remote.settings.mutate
  remote.settings.mutate = async (...args) => {
    await mutate(...args)
    // 没有 ok 字段：无从判定宿主是拒绝还是已提交。
    return undefined
  }
  await card.click('Save this source')
  assert.match(String(card.states[6]), /failed/)
  assert.match(remote.state.sources[0].tokenRef, /_PENDING_/)
  assert.equal(remote.state.creds[remote.state.sources[0].tokenRef], 'demo-replacement')
})

// 带首尾空白的草稿：提交用 trim 后的值，清草稿也必须 trim 后比较。
test('a whitespace-padded token draft is cleared once saved', async () => {
  const remote = sharedBackend()
  const card = cardHarness({ backend: remote })
  await card.ready()
  card.change('password', '  demo-token-v1  ')
  await card.click('Save this source')
  assert.equal(card.states[0][0].tokenDraft, '')
  // 别处轮换到 v2，本页再保存不得把带空白的旧草稿写回去。
  const activeRef = remote.state.sources[0].tokenRef
  remote.state.creds[activeRef] = 'demo-token-v2'
  await card.click('Save all sources')
  assert.equal(remote.state.creds[activeRef], 'demo-token-v2')
})

// 首次读取失败时不开放写入：以空基线保存会把已存源站整批抹掉。
test('sources are not writable before the configuration has been read successfully', async () => {
  const card = cardHarness({
    sources: [{ id: 'id-a', name: 'alpha', baseUrl: 'https://alpha.example.com', tokenRef: 'GRAFANA_TOKEN_ida' }],
    defaultSource: 'id-a',
    locale: 'en',
    fail: { 'settings.describe': 'temporary read failure' },
  })
  await card.ready()
  assert.match(String(card.states[6]), /temporary read failure/)
  // 故障恢复后仍不开放写入：本页从未拿到过权威基线，此时保存会用空列表覆盖
  // 后端已有的全部源站。
  delete card.fail['settings.describe']
  await card.click('新增源站')
  assert.match(String(card.states[6]), /尚未成功读取配置/)
  assert.equal(card.calls.some(([m]) => m === 'settings.mutate'), false)
  // 重新读取之后才拿到基线；写入仍然要由用户显式触发。
  await card.click('重新读取')
  assert.equal(card.calls.some(([m]) => m === 'settings.mutate'), false)
  const after = await card.face.describe()
  assert.deepEqual(after.sources.map((s) => s.name), ['alpha'])
})

// ── R6：只读模式在设置卡片可见、可切换 ──────────────────────────────────────
test('the settings card surfaces the current read-only mode on the toggle', async () => {
  // 数据面：describe 把命名空间 value 里的 readOnly 明文带回来。
  const rw = setup({})
  assert.equal((await rw.face.describe()).readOnly, false)
  const ro = setup({ readOnly: true })
  assert.equal((await ro.face.describe()).readOnly, true)

  // 展示面：卡片状态与开关按 describe 结果落位（readOnly 及其后的模式反馈状态
  // 刻意排在 useState 序列末尾，以免打乱既有状态下标：readOnly 恒为 states[12]）。
  const card = cardHarness({ readOnly: true, locale: 'en' })
  await card.ready()
  assert.equal(card.states[12], true)
  assert.equal(card.switchButton().props['aria-checked'], true)
  const rwCard = cardHarness({ locale: 'en' })
  await rwCard.ready()
  assert.equal(rwCard.states[12], false)
  assert.equal(rwCard.switchButton().props['aria-checked'], false)

  // 文案双语存在。
  const { STRINGS } = loadBrowserRuntime().internals
  for (const lang of ['zh', 'en']) {
    for (const key of ['modeToggleLabel', 'stateReadOnly', 'stateReadWrite', 'modeToggleHint', 'modeReadWriteDesc', 'modeReadOnlyDesc', 'modeEffectNote', 'savedReadOnly', 'savedReadWrite']) {
      assert.equal(typeof STRINGS[lang][key], 'string', `${lang}.${key} must exist`)
      assert.ok(STRINGS[lang][key].length > 0)
    }
  }
  assert.notEqual(STRINGS.zh.modeToggleLabel, STRINGS.en.modeToggleLabel)
})

// writeReadOnly 的 face 契约：单字段 mutate（恰一个 set op）、位置参数、arity 3、
// 第三参未显式传时按最后一次 describe 的版本做检查（与 writeSources 同一防陈旧语义）。
test('writeReadOnly routes a single-field mutate through the settings facade', async () => {
  const source = { id: 'id-a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_ia' }
  const { face, calls } = setup({ sources: [source], defaultSource: 'id-a' })
  await face.describe()
  await face.writeReadOnly(true, 0)
  const mutates = calls.filter(([m]) => m === 'settings.mutate')
  assert.equal(mutates.length, 1)
  assert.equal(mutates[0][1].length, 3)
  assert.equal(JSON.stringify(mutates[0][1].slice(0, 2)), JSON.stringify(['grafana', [
    { op: 'set', path: ['readOnly'], value: true },
  ]]))
  assert.equal(mutates[0][1][2], 0)
  // 载荷里没有 sources/defaultSource：模式写入不可能波及源站配置。
  const ops = mutates[0][1][1]
  assert.equal(ops.some((op) => op.path?.[0] !== 'readOnly'), false)
  // 未显式传版本时同样按最后一次读取的版本做检查（调用方漏传也不能退化成无条件写）。
  await face.describe()
  await face.writeReadOnly(false)
  const last = calls.filter(([m]) => m === 'settings.mutate').at(-1)
  assert.equal(last[1].length, 3)
  assert.equal(last[1][2], 1)
  // 后端权威状态已翻转。
  assert.equal((await face.describe()).readOnly, false)
})

test('writeReadOnly rejects on an unsupported host', async () => {
  const { face } = setup({ remote: false })
  await assert.rejects(() => face.writeReadOnly(true), /HOST_UNSUPPORTED/)
})

// 切换即写：点开关 → 单字段 mutate 写 readOnly=true，sources/defaultSource 原样
// 保留（三源站 + 默认源站一个不动），成功反馈与开关态就近显示，回读带回新修订号。
test('toggling into read-only writes readOnly alone and keeps sources and the default untouched', async () => {
  const remote = buildBackend({
    locale: 'en',
    sources: [
      { id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' },
      { id: 'id-eu', name: 'eu', baseUrl: 'https://eu.example.com', tokenRef: 'GRAFANA_TOKEN_ideu' },
      { id: 'id-lab', name: 'lab', baseUrl: 'https://lab.example.com', tokenRef: 'GRAFANA_TOKEN_idlab' },
    ],
    defaultSource: 'id-prod',
  })
  const card = cardHarness({ backend: remote })
  await card.ready()
  await card.switchButton().props.onClick()
  // 恰一次 mutate，只带一个 set op，且带上读取时的修订号。
  const mutates = card.calls.filter(([m]) => m === 'settings.mutate')
  assert.equal(mutates.length, 1)
  assert.equal(JSON.stringify(mutates[0][1].slice(0, 2)), JSON.stringify(['grafana', [
    { op: 'set', path: ['readOnly'], value: true },
  ]]))
  assert.equal(mutates[0][1][2], 0)
  // 后端权威状态：readOnly 已翻 true；源站与默认源站一个没动。
  assert.equal(remote.state.readOnly, true)
  assert.deepEqual(remote.state.sources.map((s) => s.name), ['prod', 'eu', 'lab'])
  assert.equal(remote.state.defaultSource, 'id-prod')
  // 界面反馈：开关 ON、方向相关的「已保存」提示就在开关下方，无错误。
  assert.equal(card.states[12], true)
  assert.equal(card.switchButton().props['aria-checked'], true)
  assert.match(String(card.states[13]), /Saved/)
  assert.doesNotMatch(String(card.states[13]), /restart/i)
  assert.equal(String(card.states[14]), '')
  // 回读带回了新修订号：随后的源站保存不会因陈旧版本被拒。
  assert.equal(card.states[10], 1)
})

// 从只读切回读写：保存成功，但提示重启/重载才会重新注册写入工具（以只读模式启动
// 的插件从未注册它们）——这个事实不得隐藏。
test('switching back to read-write saves and explains the restart requirement', async () => {
  const remote = buildBackend({ locale: 'en', readOnly: true })
  const card = cardHarness({ backend: remote })
  await card.ready()
  await card.switchButton().props.onClick()
  assert.equal(remote.state.readOnly, false)
  assert.equal(card.states[12], false)
  assert.equal(card.switchButton().props['aria-checked'], false)
  assert.match(String(card.states[13]), /Saved/)
  assert.match(String(card.states[13]), /restart/i)
  assert.equal(String(card.states[14]), '')
})

// 模式写入失败（宿主明确拒绝，例如版本冲突）：本地开关不翻转、不显示「已保存」，
// 错误就近显示；重读让下一次重试拿到新修订号。
test('a failed mode write keeps the previous mode and surfaces the error', async () => {
  const card = cardHarness({ locale: 'en', fail: { 'settings.mutate': 'settings persistence failed' } })
  await card.ready()
  await card.switchButton().props.onClick()
  assert.equal(card.state.readOnly, false)
  assert.equal(card.states[12], false)
  assert.equal(card.switchButton().props['aria-checked'], false)
  assert.equal(String(card.states[13]), '')
  assert.match(String(card.states[14]), /settings persistence failed/)
})


// 独立 profile 的 settings/revision 分开，只有凭证 store 共用：不是同 profile 多页面。
for (const operation of ['rotate-one', 'rotate-all', 'remove', 'rejected-save', 'lost-response']) {
  test(`shared credentials survive ${operation} in another profile`, async () => {
    const store = { GRAFANA_TOKEN_ida: 'demo-token-original' }
    const web = buildBackend({ ...sharedBackendOptions(), credentialStore: store, locale: 'en' })
    const desktop = buildBackend({ ...sharedBackendOptions(), credentialStore: store, locale: 'en' })
    const other = setup({ backend: desktop })
    const card = cardHarness({ backend: web })
    await card.ready()
    const otherBefore = JSON.stringify(desktop.state.sources)
    if (operation === 'remove') {
      await card.click('Remove source')
      assert.equal(web.state.sources.length, 0)
    } else {
      card.change('password', 'demo-token-web-new')
      if (operation === 'rejected-save') web.fail['settings.mutate'] = 'settings rejected'
      if (operation === 'lost-response') {
        const mutate = web.settings.mutate
        web.settings.mutate = async (...args) => { await mutate(...args); throw new Error('transport disconnected') }
      }
      await card.click(operation === 'rotate-all' ? 'Save all sources' : 'Save this source')
      if (operation === 'rejected-save') {
        assert.equal(web.state.sources[0].tokenRef, 'GRAFANA_TOKEN_ida')
        assert.match(card.states[6], /settings rejected/)
      } else {
        assert.notEqual(web.state.sources[0].tokenRef, 'GRAFANA_TOKEN_ida')
        assert.equal(store[web.state.sources[0].tokenRef], 'demo-token-web-new')
      }
    }
    assert.equal(store.GRAFANA_TOKEN_ida, 'demo-token-original')
    assert.equal(JSON.stringify(desktop.state.sources), otherBefore)
    assert.equal(desktop.state.revision, 0)
    assert.equal((await other.face.describe()).sources[0].tokenConfigured, true)
    assert.equal([...web.calls, ...desktop.calls].some(([m]) => m === 'credentials.unset'), false)
    assert.equal(card.states[7].length > 0, true)
    assert.equal(card.buttons().some((b) => /Retry token cleanup|重试清除令牌/.test(String(b.props.children))), false)
  })
}

test('a partial credential write failure preserves all old and possibly written references', async () => {
  const remote = sharedBackend({ sources: [
    { id: 'a', name: 'a', baseUrl: 'https://a.example.com', tokenRef: 'GRAFANA_TOKEN_a' },
    { id: 'b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_b' },
  ], creds: { GRAFANA_TOKEN_a: 'demo-a', GRAFANA_TOKEN_b: 'demo-b' } })
  const card = cardHarness({ backend: remote })
  await card.ready()
  const passwords = card.inputs().filter((n) => n.props.type === 'password')
  passwords[0].props.onChange({ target: { value: 'demo-new-a' } })
  passwords[1].props.onChange({ target: { value: 'demo-new-b' } })
  const set = remote.credentials.set
  let writes = 0
  remote.credentials.set = async (...args) => {
    await set(...args)
    if (++writes === 2) throw new Error('write reply lost')
    return { ok: true }
  }
  await card.click('Save all sources')
  assert.deepEqual(remote.state.sources.map((s) => s.tokenRef), ['GRAFANA_TOKEN_a', 'GRAFANA_TOKEN_b'])
  assert.equal(Object.keys(remote.credState).length, 4)
  assert.equal(card.states[7].length, 2)
  assert.equal(remote.calls.some(([m]) => m === 'credentials.unset'), false)
  assert.match(card.states[6], /write reply lost/)
})

const unknownCredentialCases = [
  ['absent facade', (b) => { b.credentials = undefined }],
  ['absent method', (b) => { delete b.credentials.describe }],
  ['missing envelope', (b) => { b.credentials.describe = async () => undefined }],
  ['missing value', (b) => { b.credentials.describe = async () => ({ ok: true }) }],
  ['missing reference', (b) => { b.credentials.describe = async () => ({ ok: true, value: {} }) }],
  ['array payload', (b) => { b.credentials.describe = async () => ({ ok: true, value: [] }) }],
  ['missing configured', (b) => { b.credentials.describe = async () => ({ ok: true, value: { GRAFANA_TOKEN_ida: {} } }) }],
  ['nonboolean configured', (b) => { b.credentials.describe = async () => ({ ok: true, value: { GRAFANA_TOKEN_ida: { configured: 'true' } } }) }],
  ['inherited configured', (b) => { b.credentials.describe = async () => ({ ok: true, value: { GRAFANA_TOKEN_ida: Object.create({ configured: true }) } }) }],
  ['inherited reference', (b) => { b.credentials.describe = async () => ({ ok: true, value: Object.create({ GRAFANA_TOKEN_ida: { configured: true } }) }) }],
  ['rejection', (b) => { b.credentials.describe = async () => ({ ok: false, error: { message: 'demo-provider-secret' } }) }],
  ['exception', (b) => { b.credentials.describe = async () => { throw new Error('demo-provider-secret') } }],
]
for (const [label, inject] of unknownCredentialCases) {
  test(`credential ${label} is unknown without losing settings or faking a mask`, async () => {
    const remote = sharedBackend()
    inject(remote)
    const card = cardHarness({ backend: remote })
    await card.ready()
    assert.equal(card.states[0][0].tokenConfigured, null)
    assert.equal(card.states[9], true)
    assert.equal(card.states[10], 0)
    assert.equal(card.inputs().find((n) => n.props.type === 'password').props.value, '')
    const rendered = JSON.stringify(card.render())
    assert.match(rendered, /Status unavailable/)
    assert.doesNotMatch(rendered, /demo-provider-secret/)
    assert.equal(card.buttons().some((n) => n.props.children === 'Reload'), true)
    assert.equal(remote.calls.some(([m]) => m === 'credentials.unset'), false)
  })
}

test('credential status failure affects only rows whose boolean status is unavailable', async () => {
  const remote = sharedBackend({ sources: [
    ...sharedBackendOptions().sources,
    { id: 'b', name: 'b', baseUrl: 'https://b.example.com', tokenRef: 'GRAFANA_TOKEN_b' },
    { id: 'c', name: 'c', baseUrl: 'https://c.example.com', tokenRef: 'GRAFANA_TOKEN_c' },
  ] })
  remote.credentials.describe = async () => ({ ok: true, value: {
    GRAFANA_TOKEN_ida: { configured: true }, GRAFANA_TOKEN_b: { configured: false },
  } })
  const { face } = setup({ backend: remote })
  assert.equal(JSON.stringify((await face.describe()).sources.map((s) => s.tokenConfigured)), '[true,false,null]')
})

for (const locale of ['zh', 'en']) {
  test(`unknown credential state is visible and reloadable in ${locale}`, async () => {
    const remote = sharedBackend({ locale })
    remote.credentials.describe = async () => ({ ok: true, value: {} })
    const card = cardHarness({ backend: remote })
    await card.ready()
    const rendered = JSON.stringify(card.render())
    assert.match(rendered, locale === 'zh' ? /状态读取失败/ : /Status unavailable/)
    remote.credentials.describe = async () => ({ ok: true, value: { GRAFANA_TOKEN_ida: { configured: true } } })
    await card.click(locale === 'zh' ? '重新读取' : 'Reload')
    assert.equal(card.states[0][0].tokenConfigured, true)
    assert.match(card.inputs().find((n) => n.props.type === 'password').props.value, /^\*{28}$/)
  })
}

for (const tokenConfigured of [true, false, null]) {
  test(`draft merging uses persistence rather than credential status ${tokenConfigured}`, () => {
    const { mergeDrafts } = loadBrowserRuntime().internals
    const saved = { id: 'saved', name: 'saved', tokenConfigured, tokenDraft: 'demo-draft' }
    const fresh = { id: 'fresh', name: 'fresh', tokenConfigured, tokenDraft: 'demo-new' }
    const merged = mergeDrafts([], [saved, fresh], undefined, [saved])
    assert.equal(JSON.stringify(merged.map((s) => s.id)), '["fresh"]')
    assert.equal(merged[0].tokenDraft, 'demo-new')
  })
}

for (const failFirstRead of [false, true]) {
  test(`a newly committed source removed before reread is not resurrected (retry=${failFirstRead})`, async () => {
    const remote = buildBackend({ locale: 'en' })
    const card = cardHarness({ backend: remote })
    await card.ready()
    await card.click('Add source')
    card.change('text', 'new-source')
    card.change('url', 'https://new.example.com')
    card.change('password', 'demo-new-token')
    const mutate = remote.settings.mutate
    remote.settings.mutate = async (...args) => {
      const result = await mutate(...args)
      // 另一页面在首次提交成功后、回读之前移除此源站。
      remote.state.sources = []
      remote.state.defaultSource = ''
      remote.state.revision += 1
      return result
    }
    const describe = remote.settings.describe
    let failed = false
    remote.settings.describe = async (...args) => {
      if (failFirstRead && !failed) { failed = true; return { ok: true, value: {} } }
      return describe(...args)
    }
    await card.click('Save this source')
    assert.equal(card.states[0].length, 0)
    remote.settings.mutate = mutate
    await card.click('Save all sources')
    assert.equal(remote.state.sources.length, 0)
    assert.equal(remote.calls.some(([m]) => m === 'credentials.unset'), false)
  })
}

test('two failed post-save reads still remember that a new source was persisted', async () => {
  const remote = buildBackend({ locale: 'en' })
  const card = cardHarness({ backend: remote })
  await card.ready()
  await card.click('Add source')
  card.change('text', 'new-source')
  card.change('url', 'https://new.example.com')
  card.change('password', 'demo-new-token')
  const describe = remote.settings.describe
  remote.settings.describe = async () => ({ ok: true, value: {} })
  await card.click('Save this source')
  assert.equal(remote.state.sources.length, 1)
  assert.equal(card.states[1].length, 1, 'confirmed commit advances the persistence baseline')
  assert.equal(card.states[5], false)
  remote.state.sources = []
  remote.state.defaultSource = ''
  remote.state.revision += 1
  remote.settings.describe = describe
  // 旧修订号的保存被拒；回读必须丢弃这个已保存后被删除的源站。
  await card.click('Save all sources')
  assert.equal(card.states[0].length, 0)
  await card.click('Save all sources')
  assert.equal(remote.state.sources.length, 0)
  assert.equal(remote.calls.some(([m]) => m === 'credentials.unset'), false)
})

for (const initialState of ['missing', 'unknown']) {
  test(`a saved source with ${initialState} credentials is not resurrected by a later save-all`, async () => {
    const remote = sharedBackend({ creds: {} })
    if (initialState === 'unknown') remote.credentials.describe = async () => ({ ok: true, value: {} })
    const card = cardHarness({ backend: remote })
    await card.ready()
    remote.state.sources = []
    remote.state.defaultSource = ''
    remote.state.revision += 1
    card.change('text', 'edited-source')
    await card.click('Save all sources')
    assert.equal(card.states[0].length, 0)
    await card.click('Save all sources')
    assert.equal(remote.state.sources.length, 0)
    assert.equal(remote.calls.some(([m]) => m === 'credentials.unset'), false)
  })
}
