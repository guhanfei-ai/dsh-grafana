import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, Config, internals, SETTINGS_NAMESPACE } from '../index.js'

const { parseImportedYaml } = internals
const plainImport = [
  'grafana:',
  '  readOnly: true',
  '  defaultSource: example-source',
  '  sources:',
  '    - id: example-source',
  '      name: example',
  '      baseUrl: https://grafana.example.com',
  '      tokenRef: GRAFANA_TOKEN_example',
].join('\n')

function missingModule(name) {
  return Object.assign(new Error(`Cannot find module '${name}'\nRequire stack:\nfixture`), { code: 'MODULE_NOT_FOUND' })
}

test('full YAML parsing preserves quoted Unicode, aliases and merged source fields', () => {
  const parsed = parseImportedYaml([
    'defaults: &defaults',
    '  baseUrl: https://grafana.example.com',
    '  tokenRef: GRAFANA_TOKEN_example',
    'grafana:',
    '  readOnly: true',
    '  sources:',
    '    - <<: *defaults',
    '      id: example-source',
    '      name: "示例源站: 一"',
  ].join('\n'))
  assert.equal(parsed.grafana.readOnly, true)
  assert.deepEqual(parsed.grafana.sources[0], {
    id: 'example-source', name: '示例源站: 一',
    baseUrl: 'https://grafana.example.com', tokenRef: 'GRAFANA_TOKEN_example',
  })
  assert.equal(parseImportedYaml(''), undefined)
})

test('only an absent js-yaml dependency enables the restricted parser', () => {
  const parsed = parseImportedYaml(plainImport, (name) => {
    assert.equal(name, 'js-yaml')
    throw missingModule(name)
  })
  assert.equal(parsed.grafana.readOnly, true)
  assert.equal(parsed.grafana.sources[0].baseUrl, 'https://grafana.example.com')
  assert.equal(parsed.grafana.sources[0].tokenRef, 'GRAFANA_TOKEN_example')
})

test('broken YAML installations and missing transitive dependencies are not hidden by fallback', () => {
  for (const failure of [missingModule('argparse'), Object.assign(new Error('fixture load failure'), { code: 'ERR_REQUIRE_ESM' })]) {
    assert.throws(() => parseImportedYaml(plainImport, () => { throw failure }), (error) => error === failure)
  }
  const parserFailure = new Error('fixture parser failure')
  assert.throws(() => parseImportedYaml(plainImport, () => ({ load() { throw parserFailure } })), (error) => error === parserFailure)
})

test('duplicate keys and malformed YAML remain errors instead of becoming valid imports', () => {
  for (const text of [plainImport.replace('  readOnly: true', '  readOnly: true\n  readOnly: false'), 'grafana:\n  sources: [unterminated']) {
    assert.throws(() => parseImportedYaml(text), (error) => error.name === 'YAMLException')
  }
})

test('restricted imports reject duplicate sections, fields, source fields and invalid booleans', () => {
  const cases = [
    `${plainImport}\ngrafana:\n  readOnly: false`,
    plainImport.replace('  readOnly: true', '  readOnly: true\n  readOnly: false'),
    plainImport.replace('      name: example', '      name: example\n      name: other'),
    plainImport.replace('  readOnly: true', '  readOnly: typo'),
  ]
  for (const text of cases) {
    assert.throws(() => parseImportedYaml(text, () => { throw missingModule('js-yaml') }), /Invalid imported Grafana configuration/)
  }
})

// 真实文件 + 宿主服务面：错误导入不能触发后续 legacy 写入或凭证清理。
test('invalid imported YAML preserves settings, credentials and the original file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-grafana-invalid-import-'))
  const path = join(directory, 'settings.yaml.imported')
  const text = plainImport.replace('  readOnly: true', '  readOnly: true\n  readOnly: false')
  writeFileSync(path, text)
  const section = { sources: [], readOnly: true, baseUrl: 'https://kept.example.com' }
  const calls = []
  const logs = []
  const ctx = {
    credentials: {
      async resolve(ref) { calls.push(['resolve', ref]); return { value: 'fixture-legacy-value' } },
      async unset(ref) { calls.push(['unset', ref]) },
    },
    inject(services, callback) {
      if (!services.includes('settings')) return
      callback({
        credentials: ctx.credentials, effect(setup) { setup() },
        settings: {
          describe() { return [{ ns: SETTINGS_NAMESPACE, revision: 0, value: Config(section) }] },
          async update(...args) { calls.push(['update', ...args]) },
        },
      })
    },
    on() {}, systemPrompt: { section() {} }, tools: { register() {} },
  }
  const previousDshHome = process.env.DSH_HOME
  const previousLog = console.error
  process.env.DSH_HOME = directory
  console.error = (line) => logs.push(line)
  try {
    apply(ctx, section)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [], 'invalid import must not resolve or remove legacy credentials or update settings')
    assert.equal(section.readOnly, true)
    assert.equal(readFileSync(path, 'utf8'), text)
    assert.deepEqual(logs, [
      '[grafana-migrate] step3 failed reason=invalid-import',
      '[grafana-migrate] step1 skipped reason=import-failed',
      '[grafana-migrate] step2 skipped reason=import-failed',
    ])
  } finally {
    console.error = previousLog
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    rmSync(directory, { recursive: true, force: true })
  }
})
