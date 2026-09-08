import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// 在 vm 沙箱里加载浏览器 bundle：注入 URL、window.__ModuleLoader__ 与 crypto
// （generateSourceId 走 crypto.randomUUID 路径需要它）。返回 { definition, runtime }。
function loadBrowserModule() {
  let definition
  const window = { __ModuleLoader__: { load(value) { definition = value } } }
  vm.runInNewContext(
    readFileSync(new URL('../client.js', import.meta.url), 'utf8'),
    { URL, window, crypto: globalThis.crypto },
  )
  const runtime = definition.factory((id) => {
    if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {} }
    if (id === 'react') return {}
    throw new Error(`Unexpected browser dependency: ${id}`)
  })
  return { definition, runtime }
}

function loadBrowserRuntime() {
  return loadBrowserModule().runtime
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
function setup({ sources = [], defaultSource = '', creds = {}, locale = 'zh', remote = true, fail = {} } = {}) {
  const calls = []
  let grafanaValue = { sources: sources.map((s) => ({ ...s })), defaultSource }
  const credState = { ...creds }
  let face
  const rejected = (what) => (fail[what] ? { ok: false, error: { message: fail[what] } } : null)
  // 真机 describe 应答里每个命名空间描述符的完整键集。
  const descriptor = (ns, value) => ({ ns, schema: null, value, base: {}, user: {}, applies: 'live', secrets: [], revision: 0 })
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
        descriptor('grafana', { sources: grafanaValue.sources.map((s) => ({ ...s })), defaultSource: grafanaValue.defaultSource }),
        descriptor('locale', { preference: locale }),
      ] } }
    },
    async update(...args) {
      calls.push(['settings.update', args])
      const [ns, patch] = args
      const bad = rejected('settings.update')
      if (bad) return bad
      if (ns === 'grafana' && patch) {
        if (patch.sources !== undefined) grafanaValue.sources = patch.sources.map((s) => ({ ...s }))
        if (patch.defaultSource !== undefined) grafanaValue.defaultSource = patch.defaultSource
      }
      return { ok: true, value: descriptor('grafana', { ...grafanaValue }) }
    },
    async mutate(...args) {
      calls.push(['settings.mutate', args])
      const [ns, ops] = args
      const bad = rejected('settings.mutate')
      if (bad) return bad
      for (const op of ops ?? []) {
        if (ns === 'grafana' && op?.op === 'unset' && op?.path?.[0] === 'sources') grafanaValue.sources = []
      }
      return { ok: true, value: descriptor('grafana', { ...grafanaValue }) }
    },
  }
  const services = remote ? { 'remote.settings': settings, 'remote.credentials': credentials } : {}
  const runtime = loadBrowserRuntime()
  runtime.apply({
    // cordis ctx.get 语义（4.0.2 实测）：服务缺席时返回 undefined，不抛。
    // 刻意不提供 connection —— 任何回退到 connection.api 的实现都会当场失败。
    get(name) { return services[name] },
    slots: {
      inject(name, callback) { assert.equal(name, 'settings.plugin.item'); callback() },
      register(specification) {
        // keyed slot：key 必须与 index.js 的 SETTINGS_NAMESPACE 一致，且不带 id/order。
        assert.equal(specification.key, 'grafana')
        assert.equal('id' in specification, false)
        assert.equal('order' in specification, false)
        face = specification.inject().grafanaCard
        return () => {}
      },
    },
  })
  return { face, calls }
}

test('browser module declares the dsh-grafana id, the slots-only inject, and the keyed grafana slot', () => {
  const { definition, runtime } = loadBrowserModule()
  assert.equal(definition.id, 'dsh-grafana')
  // 只 inject slots：卡片必须在没有 remote.* 的旧宿主上也能加载，才能显示升级提示。
  // cordis 4.0.2 实测：inject 里任何缺席的服务都会让 fiber 永远停在 INACTIVE（插件不加载），
  // 而 ctx.get 可以在运行期读到未声明的服务，故远端门面一律用 ctx.get 延迟解析。
  assert.deepEqual(Array.from(runtime.inject), ['slots'])
  let face
  runtime.apply({
    get: () => undefined,
    slots: {
      inject: (_name, callback) => callback(),
      register: (specification) => {
        assert.equal(specification.key, 'grafana')
        face = specification.inject().grafanaCard
        return () => {}
      },
    },
  })
  // 多源站 face 契约：读回源站列表、整体写入、令牌增删、语言偏好。
  for (const method of ['describe', 'writeSources', 'setToken', 'unsetToken', 'localePreference']) {
    assert.equal(typeof face[method], 'function', `face.${method} must be a function`)
  }
})

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
    sources: [
      { id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod', tokenConfigured: true },
      { id: 'id-eu', name: 'eu', baseUrl: 'https://eu.example.com', tokenRef: 'GRAFANA_TOKEN_ideu', tokenConfigured: false },
    ],
    defaultSource: 'id-eu',
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
  await face.unsetToken('GRAFANA_TOKEN_ida')
  const declared = {
    'settings.describe': 0,
    'settings.mutate': 3,
    'settings.update': 3,
    'credentials.describe': 1,
    'credentials.set': 2,
    'credentials.unset': 1,
  }
  assert.deepEqual([...new Set(calls.map(([m]) => m))].sort(), Object.keys(declared).sort())
  for (const [method, args] of calls) {
    assert.equal(args.length, declared[method], `${method} must pass ${declared[method]} argument(s), got ${args.length}`)
  }
})

test('describe returns an empty list without touching credentials when no source is configured', async () => {
  const { face, calls } = setup()
  const r = await face.describe()
  assert.equal(JSON.stringify(r), JSON.stringify({ hostUnsupported: false, sources: [], defaultSource: '' }))
  // 无源站 → 无 tokenRef 可查，不应调用 credentials.describe。
  assert.equal(calls.some(([m]) => m === 'credentials.describe'), false)
})

test('writeSources replaces the whole sources array via unset + update and writes defaultSource', async () => {
  const { face, calls } = setup({
    sources: [{ id: 'old', name: 'old', baseUrl: 'https://old.example.com', tokenRef: 'GRAFANA_TOKEN_old' }],
    defaultSource: 'old',
  })
  await face.writeSources(
    [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }],
    'id-prod',
  )
  // 先 mutate unset ['sources']（避免 update 对数组按下标深合并留下陈旧项）……
  const mutateIndex = calls.findIndex(([m]) => m === 'settings.mutate')
  const updateIndex = calls.findIndex(([m]) => m === 'settings.update')
  assert.ok(mutateIndex >= 0 && updateIndex >= 0 && mutateIndex < updateIndex, 'unset must precede update')
  // mutate(ns, ops, expectedRevision?)：位置参数；第三参留空表示不做乐观并发校验。
  assert.equal(JSON.stringify(calls[mutateIndex][1].slice(0, 2)), JSON.stringify(['grafana', [{ op: 'unset', path: ['sources'] }]]))
  assert.equal(calls[mutateIndex][1][2], undefined)
  // ……再 update(ns, patch, revision?) 写入新的 sources + defaultSource。
  assert.equal(JSON.stringify(calls[updateIndex][1].slice(0, 2)), JSON.stringify(['grafana', {
    sources: [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }], defaultSource: 'id-prod',
  }]))
  assert.equal(calls[updateIndex][1][2], undefined)
  // 写入后旧源站被整体替换，只剩新源站；id 原样保留（只读，不重新生成）。
  const r = await face.describe()
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].id, 'id-prod')
  assert.equal(r.defaultSource, 'id-prod')
})

test('writeSources derives the token ref from the id when a new source omits it', async () => {
  const { face, calls } = setup()
  await face.writeSources([{ id: 'abc-123', name: 'fresh', baseUrl: 'https://fresh.example.com' }], 'abc-123')
  const updateCall = calls.find(([m]) => m === 'settings.update')
  // 新源站未带 tokenRef → 按 id 派生 GRAFANA_TOKEN_<去横线>，与 Host 端解析一致。
  assert.equal(JSON.stringify(updateCall[1][1].sources), JSON.stringify([{ id: 'abc-123', name: 'fresh', baseUrl: 'https://fresh.example.com', tokenRef: 'GRAFANA_TOKEN_abc123' }]))
})

test('setToken and unsetToken route through the credential store with the per-source ref', async () => {
  const { face, calls } = setup()
  await face.setToken('GRAFANA_TOKEN_idprod', 'tok')
  const setCall = calls.find(([m]) => m === 'credentials.set')
  assert.equal(JSON.stringify(setCall[1]), JSON.stringify(['GRAFANA_TOKEN_idprod', 'tok']))
  await face.unsetToken('GRAFANA_TOKEN_idprod')
  const unsetCall = calls.find(([m]) => m === 'credentials.unset')
  assert.equal(JSON.stringify(unsetCall[1]), JSON.stringify(['GRAFANA_TOKEN_idprod']))
})

test('removing a source rewrites the list and unsets its token credential', async () => {
  const { face, calls } = setup({
    sources: [
      { id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' },
      { id: 'id-eu', name: 'eu', baseUrl: 'https://eu.example.com', tokenRef: 'GRAFANA_TOKEN_ideu' },
    ],
    defaultSource: 'id-prod',
    creds: { GRAFANA_TOKEN_idprod: 'p', GRAFANA_TOKEN_ideu: 'e' },
  })
  // 模拟保存：移除 eu → 写入只剩 prod 的列表 + 清除 eu 的令牌凭证。
  await face.writeSources([{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }], 'id-prod')
  await face.unsetToken('GRAFANA_TOKEN_ideu')
  const unsetCall = calls.find(([m]) => m === 'credentials.unset')
  assert.equal(JSON.stringify(unsetCall[1]), JSON.stringify(['GRAFANA_TOKEN_ideu']))
  const r = await face.describe()
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].id, 'id-prod')
  assert.equal(r.defaultSource, 'id-prod')
  // eu 的令牌已从凭证库清除。
  assert.equal(r.sources.some((s) => s.id === 'id-eu'), false)
})

test('localePreference reads the locale namespace preference', async () => {
  const { face } = setup({ locale: 'en' })
  assert.equal(await face.localePreference(), 'en')
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
  assert.equal(JSON.stringify(r), JSON.stringify({ hostUnsupported: true, sources: [], defaultSource: '' }))
  // 未命中远端门面时不应发出任何远端调用。
  assert.equal(calls.length, 0)
  // 语言偏好在旧宿主上退回浏览器语言（空串），不抛错。
  assert.equal(await face.localePreference(), '')
  // 写路径必须抛稳定错误码，绝不能静默“成功”。
  await assert.rejects(() => face.setToken('GRAFANA_TOKEN_x', 'tok'), /HOST_UNSUPPORTED/)
  await assert.rejects(() => face.unsetToken('GRAFANA_TOKEN_x'), /HOST_UNSUPPORTED/)
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

test('a rejected credentials.describe surfaces its message and never fakes “not configured”', async () => {
  // 旧实现在这里抛 TypeError 并被卡片的 .catch(() => {}) 吞掉，导致令牌状态恒显示“未配置”。
  const { face } = setup({
    sources: [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }],
    defaultSource: 'id-prod',
    creds: { GRAFANA_TOKEN_idprod: 'secret' },
    fail: { 'credentials.describe': 'credential store unavailable' },
  })
  await assert.rejects(() => face.describe(), /credential store unavailable/)
})

test('writeSources surfaces a rejected mutate instead of reporting success', async () => {
  const { face } = setup({ fail: { 'settings.mutate': 'revision conflict' } })
  await assert.rejects(
    () => face.writeSources([{ id: 'a', name: 'a', baseUrl: 'https://a.example.com' }], 'a'),
    /revision conflict/,
  )
})

test('writeSources surfaces a rejected update instead of reporting success', async () => {
  const { face } = setup({ fail: { 'settings.update': 'namespace is not writable' } })
  await assert.rejects(
    () => face.writeSources([{ id: 'a', name: 'a', baseUrl: 'https://a.example.com' }], 'a'),
    /namespace is not writable/,
  )
})

test('setToken surfaces a rejected credential write', async () => {
  const { face } = setup({ fail: { 'credentials.set': 'credential store is read-only' } })
  await assert.rejects(() => face.setToken('GRAFANA_TOKEN_x', 'tok'), /credential store is read-only/)
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
  const merged = mergeDrafts(described, drafts)
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
  }], drafts)
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
