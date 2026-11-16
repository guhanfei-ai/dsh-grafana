// lib/dashboard-edit.js — 面板与模板变量的语义编辑：把「新增 / 修改 / 删除」意图翻译成
// RFC 6902 ops，基于调用方传入的「最新」大盘计算，由 lib/tools/patch.js 统一应用与提交。
// 规则：只改显式给出的字段；不隐式移动画布上的其它面板（只有显式给出 gridPos 才调整该面板）；
// 面板 id 重复、afterPanelId 不存在、gridPos 越界、变量名冲突都直接报错，绝不猜。
import { PANEL_GRID_COLUMNS, PANEL_GRID_DEFAULT_H, PANEL_GRID_DEFAULT_W, PANEL_GRID_MAX_H, PANEL_GRID_MAX_Y, VARIABLE_NAME_MAX_CHARS } from './constants.js'
import { escapePointerToken } from './jsonpatch.js'
import { oneLine } from './util.js'

const PANEL_ID_LIMIT = 1_000_000
const GRID_KEYS = new Set(['x', 'y', 'w', 'h'])
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// 字段名会进入 JSON 指针；原型链保留键在规划阶段就拒绝，不把无效补丁带进审批预览。
function editKey(key) {
  if (RESERVED_KEYS.has(key)) throw new Error(`field ${JSON.stringify(key)} uses a reserved key.`)
  return escapePointerToken(key)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalPanelId(value, field) {
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || value < 1 || value > PANEL_ID_LIMIT) throw new Error(`${field} must be an integer between 1 and ${PANEL_ID_LIMIT}.`)
  return value
}

// 面板索引：按 id 收集顶层与 row 内嵌面板的指针、所在数组与下标。id 重复时拒绝编辑——
// 重复 id 下「改哪一个」没有确定答案，宁可让维护者先在 Grafana 里修正。
export function collectPanels(dashboard) {
  const byId = new Map()
  const duplicates = new Set()
  const walk = (panels, arrayPointer, depth) => {
    if (!Array.isArray(panels)) return
    panels.forEach((panel, index) => {
      if (!isPlainObject(panel)) return
      const pointer = `${arrayPointer}/${index}`
      if (Number.isInteger(panel.id)) {
        if (byId.has(panel.id)) duplicates.add(panel.id)
        byId.set(panel.id, { panel, pointer, arrayPointer, index, depth })
      }
      if (Array.isArray(panel.panels)) walk(panel.panels, `${pointer}/panels`, depth + 1)
    })
  }
  walk(dashboard?.panels, '/panels', 0)
  return { byId, duplicates }
}

function descendantIds(panel) {
  const ids = Number.isInteger(panel?.id) ? [panel.id] : []
  if (Array.isArray(panel?.panels)) for (const child of panel.panels) ids.push(...descendantIds(child))
  return ids
}

function nextPanelId(byId) {
  let max = 0
  for (const id of byId.keys()) if (id > max) max = id
  if (max + 1 > PANEL_ID_LIMIT) throw new Error(`no free panel id is available below the ${PANEL_ID_LIMIT} limit; pass panelId explicitly.`)
  return max + 1
}

// gridPos 校验：只接受 x/y/w/h 四个整数键；列宽 24 的画布内，宽度与横向偏移之和不得越界。
// base 为空时缺省字段取默认值（插入新面板）；base 存在时缺省字段沿用原值（修改面板）。
function resolveGridPos(input, base) {
  if (input !== undefined && !isPlainObject(input)) throw new Error('gridPos must be an object with x, y, w and h integers.')
  for (const key of Object.keys(input ?? {})) {
    if (!GRID_KEYS.has(key)) throw new Error(`gridPos has an unknown field ${JSON.stringify(oneLine(key, 20))} (allowed: x, y, w, h).`)
  }
  const merged = { ...(base ?? {}), ...(input ?? {}) }
  const grid = {
    x: merged.x ?? 0,
    y: merged.y ?? 0,
    w: merged.w ?? PANEL_GRID_DEFAULT_W,
    h: merged.h ?? PANEL_GRID_DEFAULT_H,
  }
  for (const key of GRID_KEYS) {
    if (!Number.isInteger(grid[key])) throw new Error(`gridPos.${key} must be an integer.`)
  }
  if (grid.x < 0 || grid.x >= PANEL_GRID_COLUMNS) throw new Error(`gridPos.x must be between 0 and ${PANEL_GRID_COLUMNS - 1}.`)
  if (grid.w < 1 || grid.w > PANEL_GRID_COLUMNS) throw new Error(`gridPos.w must be between 1 and ${PANEL_GRID_COLUMNS}.`)
  if (grid.x + grid.w > PANEL_GRID_COLUMNS) throw new Error(`gridPos exceeds the ${PANEL_GRID_COLUMNS}-column grid: x (${grid.x}) + w (${grid.w}) must not exceed ${PANEL_GRID_COLUMNS}.`)
  if (grid.y < 0 || grid.y > PANEL_GRID_MAX_Y) throw new Error(`gridPos.y must be between 0 and ${PANEL_GRID_MAX_Y}.`)
  if (grid.h < 1 || grid.h > PANEL_GRID_MAX_H) throw new Error(`gridPos.h must be between 1 and ${PANEL_GRID_MAX_H}.`)
  return grid
}

// gridPos 可写在顶层参数或 panel 内，但不能两处同时给出（静默取其一会掩盖调用方的错误）。
function gridInputOf(input, panel) {
  if (input.gridPos !== undefined && panel.gridPos !== undefined) {
    throw new Error('give gridPos once: either the top-level gridPos argument or panel.gridPos, not both.')
  }
  return input.gridPos !== undefined ? input.gridPos : panel.gridPos
}

// 新面板缺省放在画布最下方（顶层面板的最大底边），不挤占已有面板的位置。
function bottomOfTopLevel(dashboard) {
  let bottom = 0
  for (const panel of Array.isArray(dashboard?.panels) ? dashboard.panels : []) {
    if (!isPlainObject(panel) || !isPlainObject(panel.gridPos)) continue
    const edge = (Number(panel.gridPos.y) || 0) + (Number(panel.gridPos.h) || 0)
    if (edge > bottom) bottom = edge
  }
  return bottom
}

// 面板 upsert/delete 规划。输入字段：
// - panelId：目标面板 id（修改/删除必填；新增时作为新 id，已存在则转为修改）；
// - delete：true 表示删除（连同 row 内嵌面板）；
// - panel：修改时为要覆盖的字段（浅合并，id 若给出必须与 panelId 一致）；新增时为完整面板（至少含 type）；
// - afterPanelId：新增时插入到该面板之后（同一数组内）；缺省追加到顶层末尾；
// - gridPos：修改时只覆盖给出的键；新增时缺省放到画布底部。
// 返回 { action, ops, panelIds }：ops 是相对「最新大盘」的 RFC 6902 补丁。
export function planPanelUpsert(dashboard, input = {}) {
  if (!Array.isArray(dashboard?.panels)) throw new Error('the dashboard has no panels array.')
  const { byId, duplicates } = collectPanels(dashboard)
  const panelId = optionalPanelId(input.panelId, 'panelId')
  const afterPanelId = optionalPanelId(input.afterPanelId, 'afterPanelId')

  if (input.delete === true) {
    if (panelId === undefined) throw new Error('delete requires panelId.')
    if (duplicates.has(panelId)) throw new Error(`panel id=${panelId} appears more than once in this dashboard; fix the duplicate in Grafana before editing it.`)
    const hit = byId.get(panelId)
    if (!hit) throw new Error(`panel id=${panelId} was not found on this dashboard.`)
    return { action: 'delete', ops: [{ op: 'remove', path: hit.pointer }], panelIds: descendantIds(hit.panel) }
  }

  // 只调整位置（给了 gridPos、没给 panel）是合法的修改，等价于 panel 为空对象。
  let panel = input.panel
  if (panel === undefined && input.gridPos !== undefined && panelId !== undefined && byId.has(panelId)) panel = {}
  if (!isPlainObject(panel)) throw new Error('panel must be an object with the fields to set.')
  if (panel.id !== undefined && optionalPanelId(panel.id, 'panel.id') === undefined) throw new Error('panel.id must be an integer.')

  if (panelId !== undefined && byId.has(panelId)) {
    if (duplicates.has(panelId)) throw new Error(`panel id=${panelId} appears more than once in this dashboard; fix the duplicate in Grafana before editing it.`)
    if (afterPanelId !== undefined) throw new Error('afterPanelId is only valid when adding a new panel; to move a panel, delete it and add it back.')
    const hit = byId.get(panelId)
    if (panel.id !== undefined && panel.id !== panelId) throw new Error(`panel.id ${panel.id} differs from panelId ${panelId}; a panel's id cannot change.`)
    const gridInput = gridInputOf(input, panel)
    const incoming = { ...panel }
    delete incoming.id
    delete incoming.gridPos
    const ops = []
    if (gridInput !== undefined) {
      ops.push({ op: 'add', path: `${hit.pointer}/gridPos`, value: resolveGridPos(gridInput, hit.panel.gridPos) })
    }
    for (const key of Object.keys(incoming)) {
      ops.push({ op: 'add', path: `${hit.pointer}/${editKey(key)}`, value: incoming[key] })
    }
    if (ops.length === 0) throw new Error(`panel id=${panelId}: no fields to change were given.`)
    return { action: 'update', ops, panelIds: [panelId] }
  }

  // 新增：类型必填；id 取 panel.id / panelId / 自动分配（三者同时给出时必须一致）。
  if (typeof panel.type !== 'string' || !panel.type.trim()) {
    const why = panelId !== undefined ? ` panel id=${panelId} was not found, so this call adds a new panel.` : ''
    throw new Error(`a new panel needs a type (for example "timeseries").${why}`)
  }
  if (panelId !== undefined && panel.id !== undefined && panel.id !== panelId) throw new Error(`panel.id ${panel.id} differs from panelId ${panelId}.`)
  const newId = panel.id ?? panelId ?? nextPanelId(byId)
  if (byId.has(newId)) throw new Error(`panel id=${newId} already exists on this dashboard.`)

  let path = '/panels/-'
  if (afterPanelId !== undefined) {
    const anchor = byId.get(afterPanelId)
    if (!anchor) throw new Error(`afterPanelId=${afterPanelId} was not found on this dashboard.`)
    if (duplicates.has(afterPanelId)) throw new Error(`afterPanelId=${afterPanelId} appears more than once; fix the duplicate in Grafana first.`)
    path = `${anchor.arrayPointer}/${anchor.index + 1}`
  }
  const defaultGrid = { x: 0, y: bottomOfTopLevel(dashboard), w: PANEL_GRID_DEFAULT_W, h: PANEL_GRID_DEFAULT_H }
  const gridPos = resolveGridPos(gridInputOf(input, panel), defaultGrid)
  const value = { ...panel, id: newId, gridPos }
  return { action: 'insert', ops: [{ op: 'add', path, value }], panelIds: [newId] }
}

function normalizeVariableName(name) {
  const value = String(name ?? '').trim()
  if (!value) throw new Error('name is required.')
  if (value.length > VARIABLE_NAME_MAX_CHARS) throw new Error(`name must not exceed ${VARIABLE_NAME_MAX_CHARS} characters.`)
  if (/[\r\n\t]/.test(value)) throw new Error('name must be a single line.')
  return value
}

// 模板变量 upsert/delete 规划。只动同名变量，其它变量逐字保持不变。
// 修改为浅合并（name 不可改）；新增必须带 type；templating / list 缺失时先补出空容器。
export function planVariableUpsert(dashboard, input = {}) {
  const name = normalizeVariableName(input.name)
  const templating = dashboard?.templating
  if (templating !== undefined && templating !== null && !isPlainObject(templating)) {
    throw new Error('dashboard.templating is not an object; fix it in Grafana before editing variables.')
  }
  if (templating && templating.list !== undefined && !Array.isArray(templating.list)) {
    throw new Error('dashboard.templating.list is not an array; fix it in Grafana before editing variables.')
  }
  const list = Array.isArray(templating?.list) ? templating.list : null
  const matching = list ? list.map((variable, index) => ({ variable, index })).filter((entry) => isPlainObject(entry.variable) && entry.variable.name === name) : []
  if (matching.length > 1) throw new Error(`variable ${JSON.stringify(name)} appears more than once; fix the duplicate in Grafana before editing it.`)
  const index = matching.length === 1 ? matching[0].index : -1

  if (input.delete === true) {
    if (index < 0) throw new Error(`variable ${JSON.stringify(name)} was not found on this dashboard.`)
    return { action: 'delete', ops: [{ op: 'remove', path: `/templating/list/${index}` }], name }
  }

  const variable = input.variable
  if (!isPlainObject(variable)) throw new Error('variable must be an object with the fields to set.')
  if (variable.name !== undefined && variable.name !== name) throw new Error(`variable.name ${JSON.stringify(oneLine(variable.name, 80))} differs from name ${JSON.stringify(name)}; a variable's name cannot change.`)

  if (index >= 0) {
    const ops = Object.keys(variable)
      .filter((key) => key !== 'name')
      .map((key) => ({ op: 'add', path: `/templating/list/${index}/${editKey(key)}`, value: variable[key] }))
    if (ops.length === 0) throw new Error(`variable ${JSON.stringify(name)}: no fields to change were given.`)
    return { action: 'update', ops, name }
  }

  if (typeof variable.type !== 'string' || !variable.type) {
    throw new Error(`a new variable needs a type (for example "custom" or "query"). Variable ${JSON.stringify(name)} was not found, so this call adds a new variable.`)
  }
  const ops = []
  if (!templating) ops.push({ op: 'add', path: '/templating', value: { list: [] } })
  else if (!list) ops.push({ op: 'add', path: '/templating/list', value: [] })
  ops.push({ op: 'add', path: '/templating/list/-', value: { ...variable, name } })
  return { action: 'insert', ops, name }
}
