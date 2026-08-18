import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

test('browser module uses only the privileged credential RPC for configuration', async () => {
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
  const credentials = {
    async describe(payload) {
      calls.push(['describe', payload])
      return {
        result: {
          value: {
            credentials: {
              GRAFANA_TOKEN: { configured: true, writable: true },
              GRAFANA_BASE_URL: { configured: false, writable: true },
            },
          },
        },
      }
    },
    async set(payload) {
      calls.push(['set', payload])
      return { result: { value: {} } }
    },
    async unset(payload) {
      calls.push(['unset', payload])
      return { result: { value: {} } }
    },
  }
  const ctx = {
    get(name) {
      assert.equal(name, 'connection')
      return { api: { credentials } }
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.plugin.item')
        callback()
      },
      register(specification) {
        face = specification.inject().grafanaCard
        return () => {}
      },
    },
  }

  runtime.apply(ctx)
  assert.deepEqual({ ...(await face.describe()) }, { tokenConfigured: true, baseConfigured: false })
  await face.setToken('token')
  await face.setBaseUrl('https://grafana.example.com')
  await face.unset('GRAFANA_BASE_URL')
  assert.deepEqual(calls.map(([method]) => method), ['describe', 'set', 'set', 'unset'])
})
