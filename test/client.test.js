import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

test('browser module routes the URL through settings and the token through credentials', async () => {
  let definition
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { URL, window })
  assert.equal(definition.id, 'dsh-grafana')

  const runtime = definition.factory((id) => {
    if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {} }
    if (id === 'react') return {}
    throw new Error(`Unexpected browser dependency: ${id}`)
  })
  assert.deepEqual(Array.from(runtime.inject), ['slots', 'connection'])

  const calls = []
  let face

  // 可变的 settings 状态：模拟 Host 端 settings namespace 的读写。
  let settingsBaseUrl = 'https://grafana.example.com'
  const credentials = {
    async describe(payload) {
      calls.push(['credentials.describe', payload])
      return {
        result: {
          value: {
            credentials: {
              GRAFANA_TOKEN: { configured: true, writable: true },
              // URL 不再存凭证库；这里恒为未配置，证明 baseConfigured 完全来自 settings。
              GRAFANA_BASE_URL: { configured: false, writable: true },
            },
          },
        },
      }
    },
    async set(payload) {
      calls.push(['credentials.set', payload])
      return { result: { value: {} } }
    },
    async unset(payload) {
      calls.push(['credentials.unset', payload])
      return { result: { value: {} } }
    },
  }
  const settings = {
    async describe(payload) {
      calls.push(['settings.describe', payload])
      return {
        result: {
          value: {
            namespaces: [
              { ns: 'grafana', value: { baseUrl: settingsBaseUrl } },
              { ns: 'locale', value: { preference: 'zh' } },
            ],
          },
        },
      }
    },
    async update(payload) {
      calls.push(['settings.update', payload])
      if (payload?.patch?.baseUrl !== undefined) settingsBaseUrl = payload.patch.baseUrl
      return { result: { value: { ns: 'grafana', value: { baseUrl: settingsBaseUrl } } } }
    },
    async mutate(payload) {
      calls.push(['settings.mutate', payload])
      const op = payload?.ops?.find((o) => o?.op === 'unset' && o?.path?.[0] === 'baseUrl')
      if (op) settingsBaseUrl = ''
      return { result: { value: { ns: 'grafana', value: { baseUrl: settingsBaseUrl } } } }
    },
  }
  const ctx = {
    get(name) {
      assert.equal(name, 'connection')
      return { api: { credentials, settings } }
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.plugin.item')
        callback()
      },
      register(specification) {
        // keyed slot：key 必须与 index.js 的 SETTINGS_NAMESPACE 一致。
        assert.equal(specification.key, 'grafana')
        assert.equal('id' in specification, false)
        assert.equal('order' in specification, false)
        face = specification.inject().grafanaCard
        return () => {}
      },
    },
  }

  runtime.apply(ctx)

  // describe 并行调 credentials + settings，返回 URL 明文。
  assert.equal(JSON.stringify(await face.describe()), JSON.stringify({
    tokenConfigured: true,
    baseConfigured: true,
    baseUrl: 'https://grafana.example.com',
  }))

  // setBaseUrl 走 settings.update（非 credentials.set）。
  // client.js 在 vm sandbox 内执行，payload 对象的原型链属于 sandbox realm，
  // 与测试主 realm 的对象不等，故用 JSON.stringify 避开跨 realm 原型链差异。
  await face.setBaseUrl('https://grafana.internal')
  const updateCall = calls.find(([m]) => m === 'settings.update')
  assert.ok(updateCall, 'settings.update was called')
  assert.equal(JSON.stringify(updateCall[1]), JSON.stringify({ ns: 'grafana', patch: { baseUrl: 'https://grafana.internal' } }))

  // unsetToken 走凭证库。
  await face.unsetToken()
  const credUnsetCall = calls.find(([m]) => m === 'credentials.unset')
  assert.ok(credUnsetCall, 'credentials.unset was called')
  assert.equal(JSON.stringify(credUnsetCall[1]), JSON.stringify({ ref: 'GRAFANA_TOKEN' }))

  // unsetBaseUrl 走 settings.mutate，用单字段 unset op。
  await face.unsetBaseUrl()
  const mutateCall = calls.find(([m]) => m === 'settings.mutate')
  assert.ok(mutateCall, 'settings.mutate was called')
  assert.equal(JSON.stringify(mutateCall[1]), JSON.stringify({ ns: 'grafana', ops: [{ op: 'unset', path: ['baseUrl'] }] }))

  // 移除后 URL 明文清空，baseConfigured 变 false。
  const after = await face.describe()
  assert.equal(after.baseConfigured, false)
  assert.equal(after.baseUrl, '')
})

function loadBrowserRuntime() {
  let definition
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { URL, window })
  return definition.factory((id) => {
    if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {} }
    if (id === 'react') return {}
    throw new Error(`Unexpected browser dependency: ${id}`)
  })
}

test('settingsNamespacesOf parses the array envelope (0.1.2-rc.1+) and the namespaces aggregate (≤0.1.1)', () => {
  const { settingsNamespacesOf } = loadBrowserRuntime().internals
  // 双代信封：0.1.2-rc.1 的 describe 直接返回描述符数组；≤0.1.1 聚合在
  // result.value.namespaces。描述符条目字段 ns/value 两代同名。
  const descriptors = [{ ns: 'grafana', value: { baseUrl: 'https://grafana.example.com' } }, { ns: 'locale', value: { preference: 'zh' } }]
  assert.deepEqual(settingsNamespacesOf({ result: { value: descriptors } }), descriptors)
  assert.deepEqual(settingsNamespacesOf({ result: { value: { namespaces: descriptors } } }), descriptors)
  // 空值/畸形应答回退空数组（卡片降级路径，不抛错）。
  // 断言形状而非 deepEqual([])：vm realm 造出的 [] 与本 realm 的 []
  // 结构相等但原型不同源，deepStrictEqual 会误报 not reference-equal。
  for (const bad of [{ result: {} }, null, { result: { value: { namespaces: 'broken' } } }]) {
    const out = settingsNamespacesOf(bad)
    assert.equal(Array.isArray(out), true)
    assert.equal(out.length, 0)
  }
})

test('describe and localePreference read the base URL back under the 0.1.2-rc.1 array envelope', async () => {
  // 修复前 client 按 ≤0.1.1 的 {namespaces} 聚合形态解析，0.1.2-rc.1 的数组
  // 应答拿到 undefined 后静默降级为「未配置」——此测试锁住新形态下的回显。
  const runtime = loadBrowserRuntime()
  let face
  const credentials = {
    async describe() {
      return { result: { value: { credentials: { GRAFANA_TOKEN: { configured: true } } } } }
    },
  }
  const settings = {
    // 0.1.2-rc.1：describe 直接返回描述符数组，无 namespaces 聚合层。
    async describe() {
      return {
        result: {
          value: [
            { ns: 'grafana', value: { baseUrl: 'https://grafana.example.com' } },
            { ns: 'locale', value: { preference: 'zh' } },
          ],
        },
      }
    },
  }
  runtime.apply({
    get: () => ({ api: { credentials, settings } }),
    slots: {
      inject: (_name, callback) => callback(),
      register: (specification) => {
        face = specification.inject().grafanaCard
        return () => {}
      },
    },
  })

  assert.equal(JSON.stringify(await face.describe()), JSON.stringify({
    tokenConfigured: true,
    baseConfigured: true,
    baseUrl: 'https://grafana.example.com',
  }))
  assert.equal(await face.localePreference(), 'zh')
})
