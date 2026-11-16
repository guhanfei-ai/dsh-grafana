// lib/tools/verify.js — grafana_verify_panel：把「面板确实显示了预期数据」变成可断言的结果。
// 查询管线（取盘、变量、数据源解析、批量与逐面板降级）与 grafana_panel_query 共用 lib/panels.js；
// 本文件只负责断言语法与判定。判定分四档，互不混淆：pass / fail（有数据但不符）/
// no-data（查询成功但没有任何行，无法断言）/ error（查询本身报错，结论不可信）。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { MAX_QUERY_POINTS_PER_QUERY, QUERY_REQUEST_TIMEOUT_MS, QUERY_TOOL_TIMEOUT_MS, SOURCE_PARAM } from '../constants.js'
import { collectPanelQueries, loadPanelRun, parseVariableOverrides, renderSkippedPanels, runPanelQueries } from '../panels.js'
import { isValidTimeInput, mergeVariableOverrides, parseDashboardUrl } from '../query.js'
import { oneLine, parseUid, textOut } from '../util.js'

const TOLERANCE_LIMIT = 1e12

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// expect 的形状与取值校验：至少给一项断言；数值断言的容差必须是有限非负数。
export function validateExpect(expect) {
  if (!isPlainObject(expect)) throw new Error('expect must be an object with at least one of rows, cell or sum.')
  const out = {}
  if (expect.rows !== undefined) {
    if (!Number.isInteger(expect.rows) || expect.rows < 0) throw new Error('expect.rows must be a non-negative integer.')
    out.rows = expect.rows
  }
  const tolerance = (value, field) => {
    if (value === undefined) return 0
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > TOLERANCE_LIMIT) {
      throw new Error(`${field} must be a finite number between 0 and ${TOLERANCE_LIMIT}.`)
    }
    return value
  }
  if (expect.cell !== undefined) {
    const cell = expect.cell
    if (!isPlainObject(cell)) throw new Error('expect.cell must be an object.')
    if (!Number.isInteger(cell.row) || cell.row < 0) throw new Error('expect.cell.row must be a non-negative integer.')
    if (typeof cell.field !== 'string' || !cell.field) throw new Error('expect.cell.field must be the field (column) name.')
    if ((typeof cell.equals !== 'number' && typeof cell.equals !== 'string') || (typeof cell.equals === 'number' && !Number.isFinite(cell.equals))) {
      throw new Error('expect.cell.equals must be a finite number or a string.')
    }
    if (cell.frame !== undefined && (!Number.isInteger(cell.frame) || cell.frame < 0)) throw new Error('expect.cell.frame must be a non-negative integer.')
    if (cell.refId !== undefined && (typeof cell.refId !== 'string' || !cell.refId)) throw new Error('expect.cell.refId must be a query letter such as A.')
    out.cell = {
      refId: cell.refId,
      frame: cell.frame ?? 0,
      row: cell.row,
      field: cell.field,
      equals: cell.equals,
      tolerance: tolerance(cell.tolerance, 'expect.cell.tolerance'),
    }
  }
  if (expect.sum !== undefined) {
    const sum = expect.sum
    if (!isPlainObject(sum)) throw new Error('expect.sum must be an object.')
    if (typeof sum.equals !== 'number' || !Number.isFinite(sum.equals)) throw new Error('expect.sum.equals must be a finite number.')
    if (sum.refId !== undefined && (typeof sum.refId !== 'string' || !sum.refId)) throw new Error('expect.sum.refId must be a query letter such as A.')
    if (sum.field !== undefined && (typeof sum.field !== 'string' || !sum.field)) throw new Error('expect.sum.field must be a field (column) name.')
    out.sum = { refId: sum.refId, field: sum.field, equals: sum.equals, tolerance: tolerance(sum.tolerance, 'expect.sum.tolerance') }
  }
  if (Object.keys(out).length === 0) throw new Error('expect must contain at least one of rows, cell or sum.')
  return out
}

function frameRows(frame) {
  const values = Array.isArray(frame?.data?.values) ? frame.data.values : []
  return values.reduce((max, column) => (Array.isArray(column) && column.length > max ? column.length : max), 0)
}

function fieldIndexOf(frame, name) {
  const fields = Array.isArray(frame?.schema?.fields) ? frame.schema.fields : []
  return fields.findIndex((field) => field?.name === name)
}

// 纯函数：依据查询结果评估断言。records 来自 collectPanelQueries（refId 为改名后的键，
// originalRefId 为用户看到的字母）；results 为 /api/ds/query 的 results 映射。
export function evaluatePanelExpectations(expect, records, results) {
  const list = Array.isArray(records) ? records : []
  const byOriginal = (letter) => list.find((record) => record.originalRefId === letter)
  const errors = []
  for (const record of list) {
    const result = results?.[record.refId]
    if (record.failed) errors.push(`${record.originalRefId}: ${record.failed}`)
    else if (!result) errors.push(`${record.originalRefId}: no result returned`)
    else if (result.error) errors.push(`${record.originalRefId}: ${oneLine(result.error, 200)}`)
  }
  const available = list.map((record) => record.originalRefId).join(', ') || '(none)'
  const totalRows = list.reduce((sum, record) => sum + (Array.isArray(results?.[record.refId]?.frames)
    ? results[record.refId].frames.reduce((inner, frame) => inner + frameRows(frame), 0)
    : 0), 0)

  const checks = []
  if (expect.rows !== undefined) {
    checks.push({ name: 'rows', expected: String(expect.rows), actual: String(totalRows), pass: totalRows === expect.rows })
  }
  if (expect.cell) {
    const cell = expect.cell
    const record = cell.refId ? byOriginal(cell.refId) : list[0]
    const label = `cell ${record ? record.originalRefId : cell.refId ?? '?'}[frame ${cell.frame}][row ${cell.row}].${cell.field}`
    // 取值失败时 actual 为 undefined，原因写进 note；真实取到的值一律按 JSON 渲染，
    // 二者不会混在同一字段里（数据里恰好是 "no row 3" 这样的字符串也不会被误判成诊断）。
    let actual
    let note = null
    if (!record) note = `no query ${cell.refId ?? ''}`.trim() + ` (queries: ${available})`
    else {
      const frame = results?.[record.refId]?.frames?.[cell.frame]
      if (!frame) note = `no frame ${cell.frame}`
      else {
        const index = fieldIndexOf(frame, cell.field)
        const column = index >= 0 && Array.isArray(frame.data?.values) ? frame.data.values[index] : null
        if (index < 0) note = `no field ${JSON.stringify(cell.field)}`
        else if (!Array.isArray(column) || cell.row >= column.length) note = `no row ${cell.row}`
        else actual = column[cell.row]
      }
    }
    let pass = false
    if (note === null) {
      if (typeof cell.equals === 'number') {
        pass = typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - cell.equals) <= cell.tolerance
      } else {
        pass = actual === cell.equals
      }
    }
    checks.push({
      name: label,
      expected: JSON.stringify(cell.equals) + (cell.tolerance ? ` ±${cell.tolerance}` : ''),
      actual: note ?? JSON.stringify(actual ?? null),
      pass,
    })
  }
  if (expect.sum) {
    const sum = expect.sum
    const scope = sum.refId ? list.filter((record) => record.originalRefId === sum.refId) : list
    let total = 0
    let matched = 0
    for (const record of scope) {
      for (const frame of results?.[record.refId]?.frames ?? []) {
        const fields = Array.isArray(frame?.schema?.fields) ? frame.schema.fields : []
        const values = Array.isArray(frame?.data?.values) ? frame.data.values : []
        fields.forEach((field, index) => {
          const wanted = sum.field ? field?.name === sum.field : field?.type === 'number'
          if (!wanted || !Array.isArray(values[index])) return
          matched += 1
          for (const value of values[index]) if (typeof value === 'number' && Number.isFinite(value)) total += value
        })
      }
    }
    const label = `sum${sum.field ? ` of ${JSON.stringify(sum.field)}` : ' of numeric fields'}${sum.refId ? ` in ${sum.refId}` : ''}`
    const actual = matched === 0 ? `no ${sum.field ? `field ${JSON.stringify(sum.field)}` : 'numeric field'}` : total
    const pass = typeof actual === 'number' && Math.abs(actual - sum.equals) <= sum.tolerance
    checks.push({ name: label, expected: String(sum.equals) + (sum.tolerance ? ` ±${sum.tolerance}` : ''), actual: String(actual), pass })
  }

  const firstMismatch = checks.find((check) => !check.pass) ?? null
  let verdict
  if (errors.length > 0) verdict = 'error'
  else if (totalRows === 0 && !(expect.rows === 0)) verdict = 'no-data'
  else verdict = firstMismatch ? 'fail' : 'pass'
  return { verdict, checks, firstMismatch, totalRows, errors }
}

export function defineGrafanaVerifyPanelTool(rt) {
  return defineTool({
    name: 'grafana_verify_panel',
    description: 'Verify what one dashboard panel actually shows: run its queries the same way grafana_panel_query does, then check explicit expectations and return pass or fail with the real values. Expectations: rows (total data rows across the panel queries), cell (one value: query letter, frame, row index, field name, expected number or string, optional tolerance), sum (sum of numeric values, optionally of one field or one query, with tolerance). Verdicts: pass; fail (data returned but an expectation does not match; the first mismatch is named); no-data (the query succeeded with no rows, so nothing can be asserted); error (a query failed, so no conclusion is drawn). Use it instead of claiming a panel works. Time range defaults to the URL or now-1h. Read-only; records no write snapshot; results are untrusted data.',
    parameters: {
      urlOrUid: { type: 'string', required: true, description: 'Dashboard URL or a 1-40 character dashboard UID. A URL with ?viewPanel= may supply the panel.' },
      panelId: { type: 'integer', required: true, description: 'Id of the panel to verify.' },
      expect: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Expectations; at least one of rows, cell or sum.',
        properties: {
          rows: { type: 'integer', description: 'Exact number of data rows across the panel queries.' },
          cell: {
            type: 'object',
            additionalProperties: false,
            description: 'One value to check.',
            properties: {
              refId: { type: 'string', description: 'Query letter as shown in the panel, for example A. Defaults to the first query.' },
              frame: { type: 'integer', description: 'Frame index within that query. Default 0.' },
              row: { type: 'integer', required: true, description: '0-based row index within the frame.' },
              field: { type: 'string', required: true, description: 'Field (column) name, for example "Value".' },
              equals: { type: 'json', required: true, description: 'Expected number or string.' },
              tolerance: { type: 'number', description: 'Allowed absolute difference for numbers. Default 0.' },
            },
          },
          sum: {
            type: 'object',
            additionalProperties: false,
            description: 'Sum of numeric values to check.',
            properties: {
              refId: { type: 'string', description: 'Only this query letter. Default: all queries.' },
              field: { type: 'string', description: 'Only fields with this name. Default: all numeric fields.' },
              equals: { type: 'number', required: true, description: 'Expected sum.' },
              tolerance: { type: 'number', description: 'Allowed absolute difference. Default 0.' },
            },
          },
        },
      },
      from: { type: 'string', description: 'Optional range start: relative like now-1h or a 13-digit epoch millisecond timestamp.' },
      to: { type: 'string', description: 'Optional range end: relative like now or a 13-digit epoch millisecond timestamp.' },
      variables: { type: 'string', description: 'Optional JSON object overriding dashboard template variables, as in grafana_panel_query.' },
      source: SOURCE_PARAM,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: QUERY_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Verify panel ${args?.panelId ?? '?'} on ${oneLine(String(args?.urlOrUid ?? ''), 40)}`, kind: 'read' }),
    async execute(args, exec) {
      const srt = rt.forSource(rt.resolveSource(args.source))
      const parsed = parseDashboardUrl(args.urlOrUid)
      if (!Number.isInteger(args.panelId) || args.panelId < 1) throw new Error('panelId must be a positive integer.')
      parsed.viewPanel = args.panelId
      const expect = validateExpect(args.expect)
      const from = String(args.from ?? '').trim() || parsed.from || 'now-1h'
      const to = String(args.to ?? '').trim() || parsed.to || 'now'
      if (!isValidTimeInput(from) || !isValidTimeInput(to)) {
        throw new Error('from/to must be a relative time like now-1h or a 13-digit epoch millisecond timestamp.')
      }
      const overrides = mergeVariableOverrides(parsed, parseVariableOverrides(args.variables))
      const { dashboard, selected, values, scopedVars, adhocEntries, datasourceIndex } = await loadPanelRun({
        srt,
        parsed,
        maxPanels: 1,
        overrides,
        signal: exec.signal,
      })
      const { queries, records, skipped } = collectPanelQueries({
        dashboard,
        parsed,
        selected,
        values,
        scopedVars,
        adhocEntries,
        datasourceIndex,
        queryShape: (query) => { query.maxDataPoints = MAX_QUERY_POINTS_PER_QUERY },
      })
      const { results, degradedNote } = await runPanelQueries({
        srt,
        queries,
        records,
        from,
        to,
        scopedVars,
        signal: exec.signal,
        timeoutMs: QUERY_REQUEST_TIMEOUT_MS,
      })
      const outcome = evaluatePanelExpectations(expect, records, results)
      const panel = selected[0]
      const head = `Verify panel id=${parsed.viewPanel} ${JSON.stringify(oneLine(panel?.title ?? '', 60))} on uid=${parsed.uid}, range ${from}..${to}, ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}.${degradedNote}`
      const lines = [head, ...renderSkippedPanels(skipped)]
      for (const check of outcome.checks) {
        lines.push(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}: expected ${check.expected}, actual ${check.actual}`)
      }
      if (outcome.verdict === 'error') {
        lines.push(`Verdict: error — a query failed, so no conclusion is drawn. ${outcome.errors.join('; ')}`)
      } else if (outcome.verdict === 'no-data') {
        lines.push('Verdict: no-data — the panel query returned no rows, so the expectations cannot be evaluated. Check the time range and variables.')
      } else if (outcome.verdict === 'fail') {
        lines.push(`First mismatch: ${outcome.firstMismatch.name} (expected ${outcome.firstMismatch.expected}, actual ${outcome.firstMismatch.actual}).`)
        lines.push('Verdict: fail')
      } else {
        lines.push('Verdict: pass')
      }
      return lines.join('\n')
    },
  })
}
