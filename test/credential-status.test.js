import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime } from '../lib/runtime.js'
import { defineGrafanaSourcesTool } from '../lib/tools/misc.js'

const source = (name) => ({
  id: `id-${name}`, name, baseUrl: `https://${name}.example.com`, tokenRef: `GRAFANA_TOKEN_${name}`,
})

for (const [label, resolve, expected] of [
  ['configured', async () => ({ value: 'demo-token-not-for-output', source: 'file' }), true],
  ['missing', async () => undefined, false],
  ['blank', async () => ({ value: '' }), false],
  ['exception', async () => { throw new Error('demo-provider-secret') }, null],
  ['null', async () => null, null],
  ['missing value', async () => ({}), null],
  ['wrong value type', async () => ({ value: true }), null],
  ['array', async () => [], null],
  ['inherited value', async () => Object.create({ value: 'demo-token-not-for-output' }), null],
]) {
  test(`runtime credential ${label} is classified without exposing secrets`, async () => {
    const rt = createRuntime({ credentials: { resolve } }, () => ({ sources: [source('alpha')] }))
    const rows = await rt.listSources()
    assert.equal(rows[0].tokenConfigured, expected)
    const output = await defineGrafanaSourcesTool(rt).execute({}, { signal: new AbortController().signal })
    assert.match(output, new RegExp(`token=${expected === true ? 'configured' : expected === false ? 'missing' : 'unknown'}$`))
    assert.doesNotMatch(output, /demo-token-not-for-output|demo-provider-secret/)
  })
}

test('a missing credential provider is unknown rather than missing', async () => {
  const rt = createRuntime({}, () => ({ sources: [source('alpha')] }))
  assert.equal((await rt.listSources())[0].tokenConfigured, null)
  assert.match(await defineGrafanaSourcesTool(rt).execute({}, { signal: new AbortController().signal }), /token=unknown$/)
})

test('one failed credential read does not hide other sources or fake their states', async () => {
  const rt = createRuntime({ credentials: {
    async resolve(ref) {
      if (ref === 'GRAFANA_TOKEN_alpha') return { value: 'demo-token-not-for-output' }
      if (ref === 'GRAFANA_TOKEN_beta') return undefined
      throw new Error('demo-provider-secret')
    },
  } }, () => ({ sources: [source('alpha'), source('beta'), source('gamma')], defaultSource: 'id-alpha' }))
  const output = await defineGrafanaSourcesTool(rt).execute({}, { signal: new AbortController().signal })
  const lines = output.split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0], /^\(default\).*token=configured$/)
  assert.match(lines[1], /token=missing$/)
  assert.match(lines[2], /token=unknown$/)
  assert.doesNotMatch(output, /demo-token-not-for-output|demo-provider-secret/)
})

test('the sources renderer never treats an absent status as confirmed missing', async () => {
  const output = await defineGrafanaSourcesTool({
    async listSources() { return [{ id: 'id-alpha', name: 'alpha', baseUrl: '', isDefault: true }] },
  }).execute({}, { signal: new AbortController().signal })
  assert.match(output, /token=unknown$/)
})
