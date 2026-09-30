import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { allowedHost, formatFindings, scanArchiveBytes, scanText } from '../scripts/identifier-check.js'

test('public identifiers allow only documentation ranges and explicitly referenced official hosts', () => {
  for (const host of ['grafana.example.com', 'demo.example.net', 'example.org', 'sample.invalid', 'localhost', '127.0.0.1', '192.0.2.1', '198.51.100.10', '203.0.113.20', '2001:db8::1', 'github.com']) {
    assert.equal(allowedHost(host), true)
  }
  const outsideOfficialHost = ['www', 'rfc-editor', 'org'].join('.')
  assert.equal(allowedHost(outsideOfficialHost), false, 'new third-party hosts require an explicit, justified exception')
})

test('scanner checks URLs, bare domains, emails and IPs without treating code member calls as hosts', () => {
  const outsideOfficialHost = ['www', 'rfc-editor', 'org'].join('.')
  const lines = [
    'https://grafana.example.com and user@example.com and 203.0.113.6',
    `https://${outsideOfficialHost}/docs and host.${outsideOfficialHost}`,
    'settings.update() and obj.config and listeners.set()',
  ]
  assert.deepEqual(scanText(lines.join('\n')), [{ line: 2, count: 2 }])
  assert.deepEqual(scanText('listeners.set(name, value)\nconst url = "https://example.org"', { code: true }), [])
  assert.deepEqual(formatFindings([{ location: 'test/fixture.md', line: 2, count: 2 }]), ['test/fixture.md:2 (2)'])
})

function tarEntry(name, text) {
  const header = Buffer.alloc(512)
  const contents = Buffer.from(text)
  header.write(name, 0, 100, 'utf8')
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  header.write('0', 156, 1, 'ascii')
  return Buffer.concat([header, contents, Buffer.alloc(Math.ceil(contents.length / 512) * 512 - contents.length)])
}

test('archive check scans text members and reports only the member and line', () => {
  const outsideOfficialHost = ['www', 'rfc-editor', 'org'].join('.')
  const archive = gzipSync(Buffer.concat([
    tarEntry('package/README.md', `hello\nhttps://${outsideOfficialHost}/docs\n`),
    tarEntry('package/index.js', 'const url = "https://example.com"\n'),
    Buffer.alloc(1024),
  ]))
  assert.deepEqual(formatFindings(scanArchiveBytes(archive)), ['package/README.md:2 (1)'])
})
