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
function setup({ sources = [], defaultSource = '', creds = {}, locale = 'zh' } = {}) {
  const calls = []
  let grafanaValue = { sources: sources.map((s) => ({ ...s })), defaultSource }
  const credState = { ...creds }
  let face
  const credentials = {
    async describe(payload) {
      calls.push(['credentials.describe', payload])
      const out = {}
      for (const ref of payload?.refs ?? []) out[ref] = { configured: Boolean(credState[ref]), writable: true }
      return { result: { value: { credentials: out } } }
    },
    async set(payload) { calls.push(['credentials.set', payload]); credState[payload.ref] = payload.value; return { result: { value: {} } } },
    async unset(payload) { calls.push(['credentials.unset', payload]); delete credState[payload.ref]; return { result: { value: {} } } },
  }
  const settings = {
    // 0.1.2-rc.1：describe 直接返回描述符数组（每项 {ns, value}）。
    async describe() {
      calls.push(['settings.describe', {}])
      return { result: { value: [
        { ns: 'grafana', value: { sources: grafanaValue.sources.map((s) => ({ ...s })), defaultSource: grafanaValue.defaultSource } },
        { ns: 'locale', value: { preference: locale } },
      ] } }
    },
    async update(payload) {
      calls.push(['settings.update', payload])
      if (payload?.ns === 'grafana' && payload?.patch) {
        if (payload.patch.sources !== undefined) grafanaValue.sources = payload.patch.sources.map((s) => ({ ...s }))
        if (payload.patch.defaultSource !== undefined) grafanaValue.defaultSource = payload.patch.defaultSource
      }
      return { result: { value: { ns: 'grafana', value: { ...grafanaValue } } } }
    },
    async mutate(payload) {
      calls.push(['settings.mutate', payload])
      for (const op of payload?.ops ?? []) {
        if (payload?.ns === 'grafana' && op?.op === 'unset' && op?.path?.[0] === 'sources') grafanaValue.sources = []
      }
      return { result: { value: { ns: 'grafana', value: { ...grafanaValue } } } }
    },
  }
  const runtime = loadBrowserRuntime()
  runtime.apply({
    get(name) { assert.equal(name, 'connection'); return { api: { credentials, settings } } },
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

test('browser module declares the dsh-grafana id, slots+connection inject, and the keyed grafana slot', () => {
  const { definition, runtime } = loadBrowserModule()
  assert.equal(definition.id, 'dsh-grafana')
  assert.deepEqual(Array.from(runtime.inject), ['slots', 'connection'])
  let face
  runtime.apply({
    get: () => ({ api: { credentials: {}, settings: {} } }),
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
    sources: [
      { id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod', tokenConfigured: true },
      { id: 'id-eu', name: 'eu', baseUrl: 'https://eu.example.com', tokenRef: 'GRAFANA_TOKEN_ideu', tokenConfigured: false },
    ],
    defaultSource: 'id-eu',
  }))
})

test('describe returns an empty list without touching credentials when no source is configured', async () => {
  const { face, calls } = setup()
  const r = await face.describe()
  assert.equal(JSON.stringify(r), JSON.stringify({ sources: [], defaultSource: '' }))
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
  assert.equal(JSON.stringify(calls[mutateIndex][1]), JSON.stringify({ ns: 'grafana', ops: [{ op: 'unset', path: ['sources'] }] }))
  // ……再 update 写入新的 sources + defaultSource。
  assert.equal(JSON.stringify(calls[updateIndex][1]), JSON.stringify({
    ns: 'grafana',
    patch: { sources: [{ id: 'id-prod', name: 'prod', baseUrl: 'https://prod.example.com', tokenRef: 'GRAFANA_TOKEN_idprod' }], defaultSource: 'id-prod' },
  }))
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
  assert.equal(JSON.stringify(updateCall[1].patch.sources), JSON.stringify([{ id: 'abc-123', name: 'fresh', baseUrl: 'https://fresh.example.com', tokenRef: 'GRAFANA_TOKEN_abc123' }]))
})

test('setToken and unsetToken route through the credential store with the per-source ref', async () => {
  const { face, calls } = setup()
  await face.setToken('GRAFANA_TOKEN_idprod', 'tok')
  const setCall = calls.find(([m]) => m === 'credentials.set')
  assert.equal(JSON.stringify(setCall[1]), JSON.stringify({ ref: 'GRAFANA_TOKEN_idprod', value: 'tok' }))
  await face.unsetToken('GRAFANA_TOKEN_idprod')
  const unsetCall = calls.find(([m]) => m === 'credentials.unset')
  assert.equal(JSON.stringify(unsetCall[1]), JSON.stringify({ ref: 'GRAFANA_TOKEN_idprod' }))
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
  assert.equal(JSON.stringify(unsetCall[1]), JSON.stringify({ ref: 'GRAFANA_TOKEN_ideu' }))
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

test('settingsNamespacesOf parses the array envelope (0.1.2-rc.1+) and the namespaces aggregate (≤0.1.1)', () => {
  const { settingsNamespacesOf } = loadBrowserRuntime().internals
  // 双代信封：0.1.2-rc.1 的 describe 直接返回描述符数组；≤0.1.1 聚合在
  // result.value.namespaces。描述符条目字段 ns/value 两代同名。
  const descriptors = [{ ns: 'grafana', value: { sources: [] } }, { ns: 'locale', value: { preference: 'zh' } }]
  assert.deepEqual(settingsNamespacesOf({ result: { value: descriptors } }), descriptors)
  assert.deepEqual(settingsNamespacesOf({ result: { value: { namespaces: descriptors } } }), descriptors)
  // 空值/畸形应答回退空数组（卡片降级路径，不抛错）。
  for (const bad of [{ result: {} }, null, { result: { value: { namespaces: 'broken' } } }]) {
    const out = settingsNamespacesOf(bad)
    assert.equal(Array.isArray(out), true)
    assert.equal(out.length, 0)
  }
})
