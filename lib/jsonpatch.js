// lib/jsonpatch.js — RFC 6902 补丁与 RFC 6901 指针的纯函数实现，供增量写入使用。
// 增量写入只需要这一层：把模型给出的 ops 应用到「刚读取的最新大盘」副本上，任一步失败
// 整份拒绝（不做部分应用，写入次数为 0）。不引入第三方库：补丁面很小，而且要对路径施加
// 本项目的约束——禁止原型链键、数组索引必须是规范十进制、每一步的目标都必须已存在。
import { oneLine } from './util.js'

export const PATCH_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test'])
export const MAX_PATCH_OPS = 100
const MAX_POINTER_CHARS = 300
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const INDEX_PATTERN = /^(0|[1-9]\d*)$/
const OP_KEYS = new Set(['op', 'path', 'from', 'value'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// RFC 6901 转义：先 ~1 再 ~0，顺序不能反。
export function escapePointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1')
}

export function parsePointer(pointer, field = 'path') {
  if (typeof pointer !== 'string') throw new Error(`${field} must be a JSON pointer string.`)
  if (pointer.length > MAX_POINTER_CHARS) throw new Error(`${field} must not exceed ${MAX_POINTER_CHARS} characters.`)
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new Error(`${field} ${JSON.stringify(oneLine(pointer, 80))} must be a JSON pointer starting with "/".`)
  return pointer.slice(1).split('/').map((raw) => {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (FORBIDDEN_KEYS.has(token)) throw new Error(`${field} ${JSON.stringify(oneLine(pointer, 80))} uses a reserved key.`)
    return token
  })
}

function jsonEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((value, index) => jsonEqual(value, b[index]))
  }
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
}

// 取某个容器的直接子项：数组只认规范十进制且在界内的索引，对象只认自有属性。
function hasChild(container, token) {
  if (Array.isArray(container)) return INDEX_PATTERN.test(token) && Number(token) < container.length
  return isPlainObject(container) && Object.hasOwn(container, token)
}

// 沿指针逐级下探，返回 { parent, key }：parent 是最后一个容器，key 是最后一个令牌。
// 中间任一级缺失或不是容器都直接报错——补丁不替调用方自动创建中间结构。
function locate(document, tokens, path) {
  if (tokens.length === 0) throw new Error(`${path} must not be the whole document; address a member instead.`)
  let parent = document
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]
    if (!hasChild(parent, token)) throw new Error(`path ${JSON.stringify(oneLine(path, 120))} does not exist (missing "${oneLine(token, 40)}").`)
    parent = Array.isArray(parent) ? parent[Number(token)] : parent[token]
    if (parent === null || typeof parent !== 'object') throw new Error(`path ${JSON.stringify(oneLine(path, 120))} crosses a non-container value at "${oneLine(token, 40)}".`)
  }
  return { parent, key: tokens[tokens.length - 1] }
}

function insertAt(parent, key, value, path) {
  if (Array.isArray(parent)) {
    const index = key === '-' ? parent.length : (INDEX_PATTERN.test(key) ? Number(key) : NaN)
    if (!Number.isInteger(index) || index > parent.length) throw new Error(`array index ${JSON.stringify(oneLine(key, 20))} is out of range for ${JSON.stringify(oneLine(path, 120))}.`)
    parent.splice(index, 0, value)
    return
  }
  parent[key] = value
}

function readAt(parent, key, path) {
  if (!hasChild(parent, key)) throw new Error(`path ${JSON.stringify(oneLine(path, 120))} does not exist.`)
  return Array.isArray(parent) ? parent[Number(key)] : parent[key]
}

function removeAt(parent, key, path) {
  readAt(parent, key, path)
  if (Array.isArray(parent)) parent.splice(Number(key), 1)
  else delete parent[key]
}

function applyOne(document, op) {
  if (!isPlainObject(op)) throw new Error('each operation must be an object.')
  for (const key of Object.keys(op)) {
    if (!OP_KEYS.has(key)) throw new Error(`unknown field ${JSON.stringify(oneLine(key, 30))} (allowed: op, path, from, value).`)
  }
  const name = op.op
  if (!PATCH_OPS.has(name)) throw new Error(`op must be one of ${[...PATCH_OPS].join(', ')}.`)
  const path = op.path
  const tokens = parsePointer(path)
  if (name === 'add' || name === 'replace' || name === 'test') {
    if (!Object.hasOwn(op, 'value')) throw new Error(`${name} requires a value.`)
  }
  if (name === 'move' || name === 'copy') {
    if (typeof op.from !== 'string') throw new Error(`${name} requires a from pointer.`)
  }
  const value = op.value === undefined ? undefined : structuredClone(op.value)

  if (name === 'add') {
    const { parent, key } = locate(document, tokens, path)
    insertAt(parent, key, value, path)
    return
  }
  if (name === 'remove') {
    const { parent, key } = locate(document, tokens, path)
    removeAt(parent, key, path)
    return
  }
  if (name === 'replace') {
    const { parent, key } = locate(document, tokens, path)
    readAt(parent, key, path)
    if (Array.isArray(parent)) parent[Number(key)] = value
    else parent[key] = value
    return
  }
  if (name === 'test') {
    const { parent, key } = locate(document, tokens, path)
    const current = readAt(parent, key, path)
    if (!jsonEqual(current, value)) throw new Error(`test failed at ${JSON.stringify(oneLine(path, 120))}: the value differs from the expected value.`)
    return
  }
  // move / copy：来源必须存在；move 不能把节点移进自己的子树。
  const fromTokens = parsePointer(op.from, 'from')
  if (name === 'move' && fromTokens.length > 0 && tokens.length > fromTokens.length
    && fromTokens.every((token, index) => tokens[index] === token)) {
    throw new Error(`move cannot place ${JSON.stringify(oneLine(op.from, 80))} inside itself.`)
  }
  const source = locate(document, fromTokens, op.from)
  const moved = structuredClone(readAt(source.parent, source.key, op.from))
  if (name === 'move') removeAt(source.parent, source.key, op.from)
  const target = locate(document, tokens, path)
  insertAt(target.parent, target.key, moved, path)
}

function describe(op) {
  const name = isPlainObject(op) && typeof op.op === 'string' ? oneLine(op.op, 10) : '?'
  const path = isPlainObject(op) && typeof op.path === 'string' ? oneLine(op.path, 80) : '?'
  return `${name} ${JSON.stringify(path)}`
}

// 纯函数：返回应用全部 ops 之后的新文档，输入文档不被修改。任一步非法即抛错（带下标），
// 调用方据此整份拒绝写入。
export function applyPatch(document, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('ops must be a non-empty array of JSON Patch operations.')
  if (ops.length > MAX_PATCH_OPS) throw new Error(`ops must not exceed ${MAX_PATCH_OPS} operations (got ${ops.length}); split the change or use grafana_upsert_panel / grafana_variable_upsert.`)
  const next = structuredClone(document)
  ops.forEach((op, index) => {
    try {
      applyOne(next, op)
    } catch (error) {
      throw new Error(`ops[${index}] (${describe(op)}): ${error.message}`)
    }
  })
  return next
}

// 结构化差异：返回两份文档之间值不同的 JSON 指针（有界）。对象按键递归、数组等长时按
// 下标递归，其余整体视为一处变化。仅用于披露「改了哪些路径」，不参与写入判定。
export function changedPaths(before, after, limit = 20) {
  const paths = []
  let total = 0
  const visit = (a, b, pointer) => {
    if (jsonEqual(a, b)) return
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const key of keys) visit(a[key], b[key], `${pointer}/${escapePointerToken(key)}`)
      return
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((value, index) => visit(value, b[index], `${pointer}/${index}`))
      return
    }
    total += 1
    if (paths.length < limit) paths.push(pointer || '/')
  }
  visit(before, after, '')
  return { paths, total }
}

export { jsonEqual }
