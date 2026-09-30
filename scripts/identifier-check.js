// Public-surface check: whitelist documentation addresses and necessary upstream links.
// Failure output contains only file/member names, line numbers and counts, never matched text.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, lstatSync } from 'node:fs'
import { isIP } from 'node:net'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.md', '.json', '.yaml', '.yml', '.sh'])
const CODE_EXTENSIONS = new Set(['js', 'cjs', 'mjs', 'ts', 'tsx', 'json', 'yaml', 'yml', 'md', 'sh', 'tgz'])

// Only official third-party sites already linked by this project and package metadata.
// Add a new exact host only when a real documentation/package reference needs it.
const OFFICIAL_HOSTS = new Set([
  'github.com', 'registry.npmjs.org', 'www.npmjs.com', 'npmjs.com', 'keepachangelog.com',
  'grafana.com', 'grafana.org', 'prometheus.io', 'nodejs.org',
])

export function allowedHost(host) {
  const value = String(host).toLowerCase().replace(/\.$/, '')
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1') return true
  if (OFFICIAL_HOSTS.has(value)) return true
  if (value === 'example.com' || value.endsWith('.example.com')
    || value === 'example.net' || value.endsWith('.example.net')
    || value === 'example.org' || value.endsWith('.example.org')
    || value === 'invalid' || value.endsWith('.invalid')) return true
  if (isIP(value) === 4) {
    const [a, b, c] = value.split('.').map(Number)
    return a === 192 && b === 0 && c === 2
      || a === 198 && b === 51 && c === 100
      || a === 203 && b === 0 && c === 113
  }
  if (isIP(value) === 6) return /^2001:db8(?::|$)/i.test(value)
  return false
}

const URL_HOST = /\b(?:[a-z][a-z\d+.-]*):\/\/([^\s/"'`<>\\)${}]+)/gi
const EMAIL_HOST = /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24})\b/g
// Bare hosts have no URL/email context; narrow the suffix to domain TLDs seen in
// deployable addresses, so JS member calls such as `listeners.set` stay out.
// URL and email hosts above are checked regardless of suffix.
const DNS_HOST = /(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9-]{1,63}\.)+(?:com|net|org|invalid|io|dev|app|work|local|ai|gov|edu|cn|uk|jp|de|fr|us|tech|cloud|internal)(?![A-Za-z0-9_.-])/gi
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g
const IPV6 = /\[[\da-fA-F:]+\]/g

// JS/TS syntax contains thousands of ordinary member accesses (`object.field`).
// Preserve only strings and comments before looking for hostnames in code files.
function codeText(line, state) {
  let visible = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]
    if (state.quote) {
      visible += char
      if (char === '\\' && next !== undefined) visible += line[++i]
      else if (char === state.quote) state.quote = null
    } else if (state.block) {
      visible += char
      if (char === '*' && next === '/') { visible += '/'; i++; state.block = false }
    } else if (char === '/' && next === '/') {
      visible += line.slice(i)
      break
    } else if (char === '/' && next === '*') {
      visible += '/*'
      i++
      state.block = true
    } else if (char === '"' || char === "'" || char === '`') {
      visible += char
      state.quote = char
    } else {
      visible += ' '
    }
  }
  return visible
}

export function scanText(text, { code = false } = {}) {
  const hits = []
  const state = { quote: null, block: false }
  for (const [index, sourceLine] of String(text).split(/\r?\n/).entries()) {
    const line = code ? codeText(sourceLine, state) : sourceLine
    const ranges = []
    const check = (host, at, length = host.length) => {
      const normalized = host.replace(/^\[|\]$/g, '')
      if (!allowedHost(normalized) && !ranges.some(([start, end]) => at < end && at + length > start)) {
        ranges.push([at, at + length])
      }
    }
    for (const match of line.matchAll(URL_HOST)) {
      const authority = match[1].split('@').at(-1)
      if (!/[A-Za-z0-9]/.test(authority) || !authority.includes('.') && !authority.startsWith('[') && !isIP(authority)) continue
      try { check(new URL(match[0]).hostname, match.index, match[0].length) } catch { check(authority.replace(/:\d+$/, ''), match.index, match[0].length) }
    }
    for (const match of line.matchAll(EMAIL_HOST)) check(match[1], match.index, match[0].length)
    for (const match of line.matchAll(DNS_HOST)) {
      const suffix = match[0].split('.').at(-1).toLowerCase()
      // Source filenames (e.g. module.js) are not DNS; all other candidate
      // hosts still have to pass the whitelist, even in a code-like string.
      if (CODE_EXTENSIONS.has(suffix)) continue
      check(match[0], match.index)
    }
    for (const match of line.matchAll(IPV4)) check(match[0], match.index)
    for (const match of line.matchAll(IPV6)) {
      if (isIP(match[0].slice(1, -1)) === 6) check(match[0], match.index)
    }
    for (const match of line.matchAll(/(?:\b[\da-fA-F]{1,4}:){2,}[\da-fA-F:]+/g)) {
      if (isIP(match[0]) === 6) check(match[0], match.index)
    }
    if (ranges.length) hits.push({ line: index + 1, count: ranges.length })
  }
  return hits
}

function scanMember(name, contents, results) {
  if (contents.includes(0)) return
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents) } catch { return }
  const code = ['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(extname(name).toLowerCase())
  for (const hit of scanText(text, { code })) results.push({ location: name, ...hit })
}

export function scanRepository(root = ROOT) {
  // Git is read-only here: include tracked files and new, non-ignored candidates
  // that a maintainer could add. Package archives are checked independently.
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .toString('utf8').split('\0').filter(Boolean)
  const results = []
  for (const name of new Set(paths)) {
    if (!SOURCE_EXTENSIONS.has(extname(name).toLowerCase())) continue
    const file = resolve(root, name)
    if (!existsSync(file)) continue
    if (!lstatSync(file).isFile()) continue
    scanMember(name, readFileSync(file), results)
  }
  return results
}

function tarString(bytes, start, length) {
  return bytes.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
}

export function scanArchiveBytes(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 100 * 1024 * 1024 })
  const results = []
  let offset = 0
  let nextPath = null
  let members = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const length = Number.parseInt(tarString(header, 124, 12).trim(), 8)
    if (!Number.isSafeInteger(length) || length < 0 || offset + 512 + length > tar.length) throw new Error('Invalid archive')
    const contents = tar.subarray(offset + 512, offset + 512 + length)
    const type = String.fromCharCode(header[156])
    const name = nextPath ?? [tarString(header, 345, 155), tarString(header, 0, 100)].filter(Boolean).join('/')
    if (type === 'L') nextPath = tarString(contents, 0, contents.length)
    else if (type === 'x') {
      const path = contents.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]+)\n/)
      nextPath = path?.[1] ?? null
    } else {
      nextPath = null
      if (type === '0' || type === '\0') {
        members += 1
        scanMember(name, contents, results)
      }
    }
    offset += 512 + Math.ceil(length / 512) * 512
  }
  if (!members) throw new Error('Empty archive')
  return results
}

export function scanArchive(archive) {
  return scanArchiveBytes(readFileSync(archive))
}

export function formatFindings(results) {
  return results.map(({ location, line, count }) => `${location}:${line} (${count})`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = process.argv.length === 3 && process.argv[2] === '--repository'
      ? scanRepository()
      : process.argv.length === 4 && process.argv[2] === '--archive'
        ? scanArchive(process.argv[3])
        : null
    if (results === null) throw new Error('Invalid arguments')
    for (const location of formatFindings(results)) console.error(location)
    if (results.length) {
      console.error(`Identifier check failed: ${results.length} line(s)`)
      process.exitCode = 1
    }
  } catch {
    console.error('Identifier check could not complete')
    process.exitCode = 1
  }
}
