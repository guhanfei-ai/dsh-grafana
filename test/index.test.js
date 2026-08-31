import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, Config, internals, SETTINGS_NAMESPACE } from '../index.js'

function execution() {
  return { signal: new AbortController().signal }
}

function createContext({ baseUrl = 'https://grafana.example.com', token = 'test-token' } = {}) {
  const tools = []
  const listeners = new Map()
  const sections = []
  const ctx = {
    credentials: {
      async resolve(ref) {
        if (ref === 'GRAFANA_BASE_URL') return baseUrl ? { value: baseUrl } : undefined
        if (ref === 'GRAFANA_TOKEN') return token ? { value: token } : undefined
        return undefined
      },
    },
    // 无 settings 服务时注入回调不会执行（与真实 cordis 行为一致）。
    inject() {},
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  apply(ctx, {})
  return { listeners, sections, tools }
}

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('parseUid accepts Grafana-compatible UIDs and dashboard URLs', () => {
  assert.equal(internals.parseUid('abc'), 'abc')
  assert.equal(internals.parseUid('https://grafana.example.com/d/abc_123/overview?orgId=1'), 'abc_123')
  assert.throws(() => internals.parseUid('x'.repeat(41)), /1-40 character UID/)
  assert.throws(() => internals.parseUid('not/a/dashboard'), /Cannot parse/)
})

test('normalizeBaseUrl allows HTTP out of the box and can enforce HTTPS only', () => {
  assert.equal(internals.normalizeBaseUrl('https://grafana.example.com/'), 'https://grafana.example.com')
  assert.equal(internals.normalizeBaseUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000')
  assert.equal(internals.normalizeBaseUrl('http://grafana.internal/'), 'http://grafana.internal')
  assert.equal(internals.normalizeBaseUrl('http://grafana.internal/', true), 'http://grafana.internal')
  assert.throws(() => internals.normalizeBaseUrl('http://grafana.internal/', false), /Plain HTTP is disabled/)
  assert.throws(() => internals.normalizeBaseUrl('https://user:pass@grafana.example.com'), /embedded credentials/)
  assert.throws(() => internals.normalizeBaseUrl('https://grafana.example.com?target=x'), /query string or fragment/)
})

test('readLimitedText rejects oversized responses', async () => {
  await assert.rejects(
    internals.readLimitedText(new Response('12345'), 4),
    /exceeds the 4-byte limit/,
  )
})

test('API error details expose only bounded status and message fields', () => {
  const detail = internals.safeApiErrorDetail(JSON.stringify({
    status: 'version-mismatch',
    message: 'changed elsewhere',
    token: 'must-not-leak',
  }))
  assert.equal(detail, 'version-mismatch: changed elsewhere')
})

test('apply registers six tools and a hard approval gate for writes', async () => {
  const { listeners, sections, tools } = createContext()
  assert.deepEqual(tools.map((tool) => tool.name), [
    'grafana_get',
    'grafana_push',
    'grafana_clone',
    'grafana_query',
    'grafana_search',
    'grafana_health',
  ])
  assert.equal(sections.length, 1)

  const gate = listeners.get('tools/pre-execute')
  assert.equal(typeof gate, 'function')
  assert.deepEqual(
    await gate({ name: 'grafana_get', arguments: {} }, async () => ({ kind: 'allow' })),
    { kind: 'allow' },
  )
  // 无可信快照：gate 仍返回 ask，文案说明写回会被拒绝并要求先 grafana_get。
  const decision = await gate({
    name: 'grafana_push',
    arguments: {
      dashboardJson: JSON.stringify({ uid: 'abc', title: 'Overview' }),
      changeSummary: 'Adjust CPU threshold',
    },
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /no recent trusted snapshot/)
  assert.match(decision.reason, /Adjust CPU threshold/)
  const cloneDecision = await gate({
    name: 'grafana_clone',
    arguments: { sourceUrlOrUid: 'abc', newTitle: 'Overview copy' },
  }, async () => ({ kind: 'allow' }))
  assert.equal(cloneDecision.kind, 'ask')
  assert.match(cloneDecision.reason, /cloning source uid=abc/)
  assert.match(cloneDecision.reason, /Overview copy/)
  assert.match(cloneDecision.reason, /in the source folder/)

  const cloneToGeneralDecision = await gate({
    name: 'grafana_clone',
    arguments: { sourceUrlOrUid: 'abc', folderUid: '' },
  }, async () => ({ kind: 'allow' }))
  assert.equal(cloneToGeneralDecision.kind, 'ask')
  assert.match(cloneToGeneralDecision.reason, /into General/)
})

test('approval gate builds the reason from the trusted snapshot, not from dashboardJson', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const dashboard = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return jsonResponse({ meta: { folderUid: 'folder1', folderTitle: 'Team Folder', canSave: true }, dashboard })
  }

  try {
    const { listeners, tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    // args 里的标题是伪造的，审批文案必须展示快照里的可信标题。
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_push',
      arguments: {
        dashboardJson: JSON.stringify({ id: 7, uid: 'abc123', title: 'Tampered Title', version: 3, panels: [] }),
        changeSummary: 'Adjust CPU threshold',
      },
    }, async () => ({ kind: 'allow' }))

    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /uid=abc123/)
    assert.match(decision.reason, /title="Overview"/)
    // 身份行必须用快照可信标题；伪造标题只允许出现在内容 diff 预览分节里。
    const [identityLine] = decision.reason.split('\n')
    assert.doesNotMatch(identityLine, /Tampered Title/)
    assert.match(decision.reason, /Diff vs current Grafana dashboard:/)
    assert.match(decision.reason, /~ field title: "Overview" -> "Tampered Title"/)
    assert.match(decision.reason, /snapshot version 3/)
    assert.match(decision.reason, /fetched less than a minute ago/)
    // 快照中的 folderTitle（P3）出现在审批文案里。
    assert.match(decision.reason, /folder "Team Folder"/)
    assert.match(decision.reason, /Grafana-side version matches/)
    // 请求序列：grafana_get 一次 + 审批前实时复核一次。
    assert.equal(calls.length, 2)
    assert.match(calls[1], /\/api\/dashboards\/uid\/abc123$/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('approval gate warns about version conflicts and folder changes found by the live check', async () => {
  const originalFetch = globalThis.fetch
  let getCount = 0
  const initial = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async () => {
    getCount += 1
    const dashboard = getCount === 1 ? initial : { ...initial, version: 5 }
    const meta = getCount === 1
      ? { folderUid: 'folder1', folderTitle: 'Team Folder', canSave: true }
      : { folderUid: 'folder2', folderTitle: 'Other Folder', canSave: true }
    return jsonResponse({ meta, dashboard })
  }

  try {
    const { listeners, tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_push',
      arguments: {
        dashboardJson: JSON.stringify(initial),
        changeSummary: 'Adjust CPU threshold',
      },
    }, async () => ({ kind: 'allow' }))

    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /⚠️ VERSION CONFLICT/)
    assert.match(decision.reason, /Grafana-side version 5/)
    assert.match(decision.reason, /snapshot version 3/)
    assert.match(decision.reason, /⚠️ FOLDER CHANGED/)
    assert.match(decision.reason, /Team Folder/)
    assert.match(decision.reason, /Other Folder/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('approval gate explains a missing snapshot without any live request', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return jsonResponse({})
  }

  try {
    const { listeners } = createContext()
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_push',
      arguments: {
        dashboardJson: JSON.stringify({ uid: 'never-fetched', title: 'Overview' }),
        changeSummary: 'Adjust CPU threshold',
      },
    }, async () => ({ kind: 'allow' }))

    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /no recent trusted snapshot/)
    assert.match(decision.reason, /the write will be rejected/)
    assert.match(decision.reason, /Call grafana_get first/)
    assert.doesNotMatch(decision.reason, /Diff vs current/)
    // 没有可信快照时不发起实时复核请求，也不静默放行。
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('approval gate still asks for approval when the live check fails', async () => {
  const originalFetch = globalThis.fetch
  let getCount = 0
  const dashboard = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async () => {
    getCount += 1
    if (getCount === 1) return jsonResponse({ meta: { folderUid: 'folder1', folderTitle: 'Team Folder', canSave: true }, dashboard })
    throw new Error('network down')
  }

  try {
    const { listeners, tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_push',
      arguments: {
        dashboardJson: JSON.stringify(dashboard),
        changeSummary: 'Adjust CPU threshold',
      },
    }, async () => ({ kind: 'allow' }))

    // 复核失败不阻断审批：仍返回 ask，文案注明无法确认 Grafana 端状态；
    // 拿不到当前大盘时不生成内容 diff。
    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /uid=abc123/)
    assert.match(decision.reason, /title="Overview"/)
    assert.match(decision.reason, /⚠️ unable to confirm the current Grafana-side state/)
    assert.doesNotMatch(decision.reason, /Diff vs current/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('approvalReason turns a snapshot plus live result into approval copy deterministically', () => {
  const args = {
    dashboardJson: JSON.stringify({ uid: 'abc123', title: 'Untrusted Title' }),
    changeSummary: 'Tweak panels',
  }

  // 无快照：文案必须声明写回会被拒绝并要求先 grafana_get，不透传不可信标题。
  const noSnapshot = internals.approvalReason(args, null, null)
  assert.match(noSnapshot, /no recent trusted snapshot/)
  assert.match(noSnapshot, /the write will be rejected/)
  assert.match(noSnapshot, /Call grafana_get first/)
  assert.match(noSnapshot, /Tweak panels/)
  assert.doesNotMatch(noSnapshot, /Untrusted Title/)

  const snapshot = {
    id: 7,
    uid: 'abc123',
    version: 3,
    canSave: true,
    fetchedAt: Date.now() - 5 * 60_000,
    title: 'Trusted Overview',
    folderUid: 'folder1',
    folderTitle: 'Team Folder',
  }

  // 有快照、未复核：只用快照里的 uid/title/version，并显示快照获取时间。
  const trusted = internals.approvalReason(args, snapshot, null)
  assert.match(trusted, /uid=abc123/)
  assert.match(trusted, /title="Trusted Overview"/)
  assert.match(trusted, /snapshot version 3/)
  assert.match(trusted, /5 minutes ago/)
  assert.match(trusted, /folder "Team Folder"/)
  assert.doesNotMatch(trusted, /Untrusted Title/)

  // 实时复核一致 / 冲突 / 失败三种结果。
  const matching = internals.approvalReason(args, snapshot, { ok: true, current: { dashboard: { version: 3 }, meta: { folderUid: 'folder1', folderTitle: 'Team Folder' } } })
  assert.match(matching, /Grafana-side version matches/)
  assert.doesNotMatch(matching, /VERSION CONFLICT/)

  const conflict = internals.approvalReason(args, snapshot, { ok: true, current: { dashboard: { version: 4 }, meta: { folderUid: 'folder1' } } })
  assert.match(conflict, /⚠️ VERSION CONFLICT/)
  assert.match(conflict, /Grafana-side version 4/)
  assert.match(conflict, /snapshot version 3/)

  const offline = internals.approvalReason(args, snapshot, { ok: false })
  assert.match(offline, /⚠️ unable to confirm the current Grafana-side state/)

  // folderTitle 为空时用 folderUid 兜底显示。
  const fallback = internals.approvalReason(args, { ...snapshot, folderTitle: '' }, null)
  assert.match(fallback, /folder "folder1"/)

  // 显式空 folderUid 表示移动到 General，审批文案必须展示目标与确认标志。
  const moveToGeneral = internals.approvalReason({
    ...args,
    folderUid: '',
    allowFolderMove: true,
  }, snapshot, null)
  assert.match(moveToGeneral, /⚠️ REQUESTED FOLDER MOVE/)
  assert.match(moveToGeneral, /current folder "Team Folder"/)
  assert.match(moveToGeneral, /destination "General"/)
  assert.match(moveToGeneral, /allowFolderMove=true/)

  // 未确认的目录移动会在审批文案中说明执行阶段将拒绝。
  const unconfirmedMove = internals.approvalReason({ ...args, folderUid: 'folder2' }, snapshot, null)
  assert.match(unconfirmedMove, /destination "folder2"/)
  assert.match(unconfirmedMove, /allowFolderMove is not true/)
})

test('approvalUid trusts only a valid uid inside dashboardJson', () => {
  assert.equal(internals.approvalUid({ dashboardJson: JSON.stringify({ uid: 'abc123' }) }), 'abc123')
  assert.equal(internals.approvalUid({ dashboardJson: JSON.stringify({ title: 'no uid here' }) }), null)
  assert.equal(internals.approvalUid({ dashboardJson: JSON.stringify({ uid: 'not a uid!' }) }), null)
  assert.equal(internals.approvalUid({ dashboardJson: 'not json at all' }), null)
  assert.equal(internals.approvalUid({}), null)
})

test('approval gate previews a content diff against the live dashboard', async () => {
  const originalFetch = globalThis.fetch
  const dashboard = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [{ id: 1, type: 'stat', title: 'CPU' }] }
  globalThis.fetch = async () => jsonResponse({ meta: { folderUid: 'folder1', folderTitle: 'Team Folder', canSave: true }, dashboard })

  try {
    const { listeners, tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    const proposed = { ...dashboard, panels: [{ id: 1, type: 'stat', title: 'CPU usage' }] }
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_push',
      arguments: { dashboardJson: JSON.stringify(proposed), changeSummary: 'Rename the CPU panel' },
    }, async () => ({ kind: 'allow' }))

    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /Diff vs current Grafana dashboard:/)
    assert.match(decision.reason, /~ panel id=1 "CPU usage" type=stat: changed title/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('diffDashboards reports panel, variable, and top-level field changes', () => {
  const current = {
    title: 'Overview',
    refresh: '30s',
    panels: [
      { id: 1, type: 'timeseries', title: 'CPU', targets: [{ expr: 'a' }] },
      { id: 2, type: 'graph', title: 'Memory' },
      { id: 3, type: 'row', title: 'Row', panels: [{ id: 4, type: 'stat', title: 'Nested' }] },
    ],
    templating: { list: [{ name: 'env', type: 'query', query: 'prod' }, { name: 'region', type: 'query' }] },
  }
  const proposed = {
    title: 'Overview v2',
    refresh: '30s',
    panels: [
      { id: 1, type: 'timeseries', title: 'CPU', targets: [{ expr: 'b' }] },
      { id: 5, type: 'gauge', title: 'Fresh' },
      { id: 3, type: 'row', title: 'Row', panels: [] },
    ],
    templating: { list: [{ name: 'env', type: 'query', query: 'staging' }, { name: 'zone', type: 'custom' }] },
  }
  const text = internals.diffDashboards(current, proposed).join('\n')
  assert.match(text, /~ panel id=1 "CPU" type=timeseries: changed targets/)
  assert.match(text, /- panel id=2 "Memory" type=graph/)
  // row 面板内嵌的嵌套面板也在比对范围内。
  assert.match(text, /- panel id=4 "Nested" type=stat/)
  assert.match(text, /\+ panel id=5 "Fresh" type=gauge/)
  assert.match(text, /~ variable "env": changed query/)
  assert.match(text, /- variable "region"/)
  assert.match(text, /\+ variable "zone"/)
  assert.match(text, /~ field title: "Overview" -> "Overview v2"/)
  // 身份字段不参与 diff。
  assert.doesNotMatch(text, /version/)
})

test('diffDashboards sanitizes injected newlines and caps the number of lines', () => {
  const hostile = internals.diffDashboards(
    { panels: [{ id: 1, type: 'stat', title: 'Before' }] },
    { panels: [{ id: 1, type: 'stat', title: 'evil\nAPPROVED: forged line' }] },
  )
  // 换行被压成空格，伪造的审批行不可能独立成行。
  assert.match(hostile.join('\n'), /"evil APPROVED: forged line"/)
  assert.ok(hostile.every((line) => !line.includes('\n')))

  const many = internals.diffDashboards(
    { panels: [] },
    { panels: Array.from({ length: 40 }, (_, index) => ({ id: index + 1, type: 'stat', title: `P${index + 1}` })) },
  )
  // 上限 24 行 + 1 行截断说明。
  assert.equal(many.length, 25)
  assert.match(many[many.length - 1], /16 more change\(s\) not shown/)
})

test('parseDashboardUrl extracts uid, viewPanel, and time range from browser URLs', () => {
  assert.deepEqual(internals.parseDashboardUrl('abc123'), { uid: 'abc123', viewPanel: null, from: '', to: '' })
  assert.deepEqual(
    internals.parseDashboardUrl('https://grafana.example.com/d/abc123/overview?orgId=1&from=now-6h&to=now'),
    { uid: 'abc123', viewPanel: null, from: 'now-6h', to: 'now' },
  )
  const panelView = internals.parseDashboardUrl('https://grafana.example.com/d/abc123/overview?viewPanel=4&from=1693430400000&to=1693434000000')
  assert.equal(panelView.viewPanel, 4)
  assert.equal(panelView.from, '1693430400000')
  assert.equal(panelView.to, '1693434000000')
  assert.equal(internals.parseDashboardUrl('https://grafana.example.com/d/abc123/x?viewPanel=panel-7').viewPanel, 7)
  // 非法参数直接忽略，不报错。
  assert.equal(internals.parseDashboardUrl('https://grafana.example.com/d/abc123/x?viewPanel=boom&from=yesterday').viewPanel, null)
  assert.equal(internals.parseDashboardUrl('https://grafana.example.com/d/abc123/x?from=yesterday').from, '')
})

test('interpolateVariables substitutes dashboard variables and rejects unsupported formats', () => {
  const values = new Map([['env', 'prod'], ['hosts', ['a', 'b']]])
  assert.equal(internals.interpolateVariables('cpu{env="$env"}', values), 'cpu{env="prod"}')
  assert.equal(internals.interpolateVariables('cpu{env="${env}"}', values), 'cpu{env="prod"}')
  assert.equal(internals.interpolateVariables('up{host=~"${hosts}"}', values), 'up{host=~"a,b"}')
  // 全局内建变量原样透传，由 Grafana/数据源计算（含带格式修饰符的内建形态）。
  assert.equal(internals.interpolateVariables('rate(x[$__rate_interval])', values), 'rate(x[$__rate_interval])')
  assert.equal(internals.interpolateVariables('rate(x[${__rate_interval}])', values), 'rate(x[${__rate_interval}])')
  assert.equal(internals.interpolateVariables('from=${__from:date}', values), 'from=${__from:date}')
  // 未知格式修饰符 → 显式报错（regex 已是受支持格式）。
  assert.throws(() => internals.interpolateVariables('cpu{env="${env:mystery}"}', values), /Unsupported Grafana variable format/)
  assert.throws(() => internals.interpolateVariables('cpu{env="${env:}"}', values), /Unsupported Grafana variable format/)
  assert.throws(() => internals.interpolateVariables('cpu{env="$missing"}', values), /missing/)
})

test('interpolateVariables expands multi-value variables with Grafana format modifiers', () => {
  const values = new Map([
    ['single', 'prod'],
    ['hosts', ['a', 'b']],
    ['tricky', ["o'brien", 'a"b', 'c\\d']],
  ])
  const t = (text) => internals.interpolateVariables(text, values)

  // 默认与 csv：逗号连接；单值保持逐字节不变。
  assert.equal(t('${hosts}'), 'a,b')
  assert.equal(t('$hosts'), 'a,b')
  assert.equal(t('${hosts:csv}'), 'a,b')
  assert.equal(t('${single}'), 'prod')
  assert.equal(t('${single:csv}'), 'prod')
  assert.equal(t('${single:raw}'), 'prod')

  // 引号包裹类格式。
  assert.equal(t('${hosts:doublequote}'), '"a","b"')
  assert.equal(t('${hosts:singlequote}'), "'a','b'")
  // sqlstring：单引号包裹且内部 ' 翻倍转义（防注入）。
  assert.equal(t("${tricky:sqlstring}"), "'o''brien','a\"b','c\\d'")

  // json：多值为数组、单值为字符串。
  assert.equal(t('${hosts:json}'), '["a","b"]')
  assert.equal(t('${single:json}'), '"prod"')

  // pipe / percent / querystring。
  assert.equal(t('${hosts:pipe}'), 'a|b')
  assert.equal(t('${hosts:percent}'), 'a,b')
  assert.equal(t('${hosts:querystring}'), 'hosts=a&hosts=b')
  assert.equal(t('${single:querystring}'), 'single=prod')

  // regex：特殊字符转义，多值以 | 连接（可直接放进 =~"(...)"）。
  assert.equal(t('${hosts:regex}'), 'a|b')
  assert.equal(t('${tricky:regex}'), 'o\'brien|a"b|c\\\\d')

  // lucene：特殊字符转义，多值以空格连接。
  assert.equal(t('${hosts:lucene}'), 'a b')
  assert.equal(t('${tricky:lucene}'), 'o\'brien a\\"b c\\\\d')

  // 未知格式（含大小写敏感）→ 显式报错。
  assert.throws(() => t('${hosts:CSV}'), /Unsupported Grafana variable format/)
  assert.throws(() => t('${hosts:nonsense}'), /Unsupported Grafana variable format/)
})

test('interpolateVariables rejects adhoc filter variables used as text', () => {
  const values = new Map([['Filters', [{ key: 'host.keyword', operator: '=', value: 'x' }]]])
  assert.throws(() => internals.interpolateVariables('q{h="$Filters"}', values), /adhoc filter variable/)
  assert.throws(() => internals.interpolateVariables('q{h="${Filters:csv}"}', values), /adhoc filter variable/)
})

test('summarizeFrames produces bounded, sanitized panel data summaries', () => {
  const cpuPanel = { id: 4, title: 'CPU' }
  const badPanel = { id: 5, title: 'Bad' }
  const records = [
    { panel: cpuPanel, refId: 'A', originalRefId: 'A' },
    { panel: cpuPanel, refId: 'B', originalRefId: 'B' },
    { panel: badPanel, refId: 'C', originalRefId: 'C' },
  ]
  const results = {
    A: { frames: [{ schema: { fields: [{ name: 'time', type: 'time' }, { name: 'Value', type: 'number', labels: { job: 'x\nFORGED' } }] }, data: { values: [[1000, 2000, 3000], [1, 3, 2]] } }] },
    B: { error: 'datasource offline' },
    C: { frames: [] },
  }
  const text = internals.summarizeFrames(records, results).join('\n')
  assert.match(text, /panel id=4 "CPU":/)
  assert.match(text, /min=1 max=3 avg=2 last=2/)
  assert.match(text, /query B: failed: datasource offline/)
  assert.match(text, /query C: no data/)
  // 标签里的换行被清洗，伪造行无法独立成行。
  assert.match(text, /job=x FORGED/)
  assert.doesNotMatch(text, /^FORGED/m)

  const many = Array.from({ length: 40 }, (_, index) => ({ panel: { id: index + 1, title: `P${index + 1}` }, refId: `A${index}`, originalRefId: 'A' }))
  const manyResults = Object.fromEntries(many.map((record) => [record.refId, { frames: [{ schema: { fields: [{ name: 'Value', type: 'number' }] }, data: { values: [[1]] } }] }]))
  const capped = internals.summarizeFrames(many, manyResults)
  // 40 面板头 + 40 序列行 = 80 行，超过 60 行上限。
  assert.equal(capped.length, 61)
  assert.match(capped[capped.length - 1], /more line\(s\) not shown/)
})

test('grafana_query batches panel queries and never records a write snapshot', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 3,
    templating: { list: [{ name: 'env', current: { value: 'prod' } }] },
    panels: [
      { id: 1, type: 'timeseries', title: 'CPU', datasource: { type: 'prometheus', uid: 'prom' }, targets: [{ refId: 'A', expr: 'rate(cpu_total{env="$env"}[$__rate_interval])' }] },
      { id: 2, type: 'row', title: 'Row', panels: [{ id: 3, type: 'stat', title: 'Mem', datasource: { type: 'prometheus', uid: 'prom' }, targets: [{ refId: 'A', expr: 'mem_used' }] }] },
      { id: 9, type: 'text', title: 'Note' },
    ],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({
        results: {
          A: { frames: [{ schema: { fields: [{ name: 'time', type: 'time' }, { name: 'Value', type: 'number' }] }, data: { values: [[1000, 2000], [4, 6]] } }] },
          p3xA: { frames: [] },
        },
      })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { listeners, tools } = createContext()
    const output = await toolByName(tools, 'grafana_query').execute({
      urlOrUid: 'https://grafana.example.com/d/abc123/overview?from=now-2h&to=now',
    }, execution())

    // 整盘一次批量请求：嵌套面板也包含，refId 撞车加面板前缀，变量替换、内建透传。
    assert.equal(queryBodies.length, 1)
    assert.equal(queryBodies[0].from, 'now-2h')
    assert.equal(queryBodies[0].to, 'now')
    assert.equal(queryBodies[0].queries.length, 2)
    assert.equal(queryBodies[0].queries[0].expr, 'rate(cpu_total{env="prod"}[$__rate_interval])')
    assert.equal(queryBodies[0].queries[0].refId, 'A')
    assert.equal(queryBodies[0].queries[0].maxDataPoints, 500)
    assert.equal(queryBodies[0].queries[1].refId, 'p3xA')

    assert.match(output, /Dashboard uid=abc123, range now-2h..now, 2 panel\(s\), 2 queries\./)
    assert.match(output, /panel id=1 "CPU":/)
    assert.match(output, /last=6/)
    assert.match(output, /panel id=3 "Mem":/)
    assert.match(output, /query A: no data/)

    // 面板视图 URL 只查单面板；时间缺省 now-1h..now。
    const single = await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'https://grafana.example.com/d/abc123/overview?viewPanel=1' }, execution())
    assert.equal(queryBodies.length, 2)
    assert.equal(queryBodies[1].queries.length, 1)
    assert.equal(queryBodies[1].from, 'now-1h')
    assert.match(single, /panel id=1/)
    assert.doesNotMatch(single, /panel id=3/)
    await assert.rejects(
      toolByName(tools, 'grafana_query').execute({ urlOrUid: 'https://grafana.example.com/d/abc123/overview?viewPanel=99' }, execution()),
      /Panel id=99 was not found/,
    )

    // 只读查询不为写回铺路：随后立即写入仍被拒绝。
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_push',
      arguments: { dashboardJson: JSON.stringify(dashboard), changeSummary: 'x' },
    }, async () => ({ kind: 'allow' }))
    assert.match(decision.reason, /no recent trusted snapshot/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('summarizeFrames keeps real bucket names for table frames and reports per-panel failures', () => {
  const records = [
    { panel: { id: 6, title: 'Top IPs' }, refId: 'A', originalRefId: 'A' },
    { panel: { id: 7, title: 'Broken' }, refId: 'B', originalRefId: 'B', failed: 'request timed out' },
  ]
  const results = {
    A: {
      frames: [{
        schema: { fields: [{ name: 'ip', type: 'string' }, { name: 'Value', type: 'number' }] },
        data: { values: [['139.9.128.14', '8.8.8.8', '9.9.9.9'], [342000, 11560, 11950]] },
      }],
    },
  }
  const text = internals.summarizeFrames(records, results).join('\n')
  // terms 表格帧的桶名是排行榜类面板的核心数据，必须原样展示，不能退化成 "?"。
  assert.match(text, /139\.9\.128\.14=/)
  assert.match(text, /9\.9\.9\.9=/)
  assert.doesNotMatch(text, /\?=/)
  // 降级逐面板重试后仍失败的面板：逐条记录，不隐藏。
  assert.match(text, /query B: failed: request timed out/)
})

test('grafana_query passes server-side expressions through and skips unresolvable panels', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 9, uid: 'abc123', title: 'Overview', version: 1,
    panels: [
      { id: 2, type: 'stat', title: 'Broken', datasource: { type: 'prometheus', uid: 'prom' }, targets: [{ refId: 'A', expr: 'up{env="$nope"}' }] },
      {
        id: 8, type: 'timeseries', title: 'QPS',
        targets: [
          { refId: 'A', datasource: { type: 'elasticsearch', uid: 'es' }, query: 'count(*)' },
          { refId: 'B', datasource: { type: '__expr__', uid: '__expr__' }, expression: '$A / 60' },
        ],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }
  try {
    const { tools } = createContext()
    const output = await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    // Expression 里的 $A 是 refId 引用，由服务端表达式引擎解析，原样透传。
    assert.equal(queryBodies.length, 1)
    assert.equal(queryBodies[0].queries.length, 2)
    const expressionQuery = queryBodies[0].queries.find((query) => query.refId === 'B')
    assert.equal(expressionQuery.expression, '$A / 60')

    // 模板变量解析失败的面板只跳过并说明，不阻断整盘。
    assert.match(output, /panel id=2 "Broken": skipped/)
    assert.match(output, /nope/)
    assert.match(output, /panel id=8 "QPS":/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query falls back to per-panel queries when the batch request fails', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  let queryCalls = 0
  const dashboard = {
    id: 9, uid: 'abc123', title: 'Overview', version: 1,
    panels: [
      { id: 1, type: 'stat', title: 'One', datasource: { type: 'prometheus', uid: 'prom' }, targets: [{ refId: 'A', expr: 'one' }] },
      { id: 2, type: 'stat', title: 'Two', datasource: { type: 'prometheus', uid: 'prom' }, targets: [{ refId: 'A', expr: 'two' }] },
    ],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      const body = JSON.parse(init.body)
      queryBodies.push(body)
      queryCalls += 1
      // 第一次批量请求超时，触发逐面板降级。
      if (queryCalls === 1) throw new Error('request timed out')
      return jsonResponse({
        results: Object.fromEntries(body.queries.map((query) => [query.refId, {
          frames: [{ schema: { fields: [{ name: 'Value', type: 'number' }] }, data: { values: [[7]] } }],
        }])),
      })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }
  try {
    const { tools } = createContext()
    const output = await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    // 1 次批量失败 + 2 次逐面板降级。
    assert.equal(queryBodies.length, 3)
    assert.equal(queryBodies[0].queries.length, 2)
    assert.equal(queryBodies[1].queries.length, 1)
    assert.equal(queryBodies[2].queries.length, 1)
    assert.match(output, /Batch query failed \(Grafana API request failed: POST \/api\/ds\/query: request timed out\); fell back to per-panel queries\./)
    assert.match(output, /panel id=1 "One":/)
    assert.match(output, /panel id=2 "Two":/)
    assert.match(output, /last=7/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_get summary mode returns a compact overview without recording a write snapshot', async () => {
  const originalFetch = globalThis.fetch
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 5,
    templating: { list: [{ name: 'env', type: 'custom' }] },
    panels: [
      {
        id: 1, type: 'stat', title: 'QPS', datasource: { type: 'prometheus', uid: 'prom' },
        targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))' }],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: 'green' }, { color: 'red', value: 900 }] } },
          overrides: [{ matcher: { id: 'byName' }, properties: [] }],
        },
      },
      { id: 2, type: 'text', title: 'Note' },
    ],
  }
  globalThis.fetch = async () => jsonResponse({ meta: { folderTitle: 'Prod', folderUid: 'prod', canSave: true }, dashboard })
  try {
    const { listeners, tools } = createContext()
    const output = await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123', summary: true }, execution())

    assert.match(output, /dashboard uid=abc123 "Overview" version=5 folder="Prod"/)
    assert.match(output, /variables: env\(custom\)/)
    assert.match(output, /panel id=1 "QPS" type=stat/)
    assert.match(output, /datasource: prometheus uid=prom/)
    assert.match(output, /query A: sum\(rate\(http_requests_total\[5m\]\)\)/)
    assert.match(output, /thresholds: base=green, 900=red/)
    assert.match(output, /overrides: 1 rule\(s\)/)

    // 摘要模式只读：随后立即写入仍被审批门拒绝。
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_push',
      arguments: { dashboardJson: JSON.stringify(dashboard), changeSummary: 'x' },
    }, async () => ({ kind: 'allow' }))
    assert.match(decision.reason, /no recent trusted snapshot/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('snapshots record title, folderTitle, and folderUid with a folderUid fallback', async () => {
  const originalFetch = globalThis.fetch
  const dashboard = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  // meta 不带 folderTitle：快照的 folderTitle 字段应兜底为 folderUid。
  globalThis.fetch = async () => jsonResponse({ meta: { folderUid: 'folder9', canSave: true }, dashboard })

  try {
    const { listeners, tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    const decision = await listeners.get('tools/pre-execute')({
      name: 'grafana_push',
      arguments: {
        dashboardJson: JSON.stringify(dashboard),
        changeSummary: 'Adjust CPU threshold',
      },
    }, async () => ({ kind: 'allow' }))

    // 快照字段断言：title 来自 dashboard.title；folderTitle 缺失时兜底为 folderUid。
    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /title="Overview"/)
    assert.match(decision.reason, /folder "folder9"/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_push preserves the current folder and disables overwrite by default', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const dashboard = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (init.method === 'POST') {
      return jsonResponse({ uid: 'abc123', status: 'success', version: 4, url: '/d/abc123/overview' })
    }
    return jsonResponse({ meta: { folderUid: 'folder1', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    const get = toolByName(tools, 'grafana_get')
    const push = toolByName(tools, 'grafana_push')
    const fetched = JSON.parse(await get.execute({ urlOrUid: 'abc123' }, execution()))
    fetched.dashboard.title = 'Overview v2'
    const output = await push.execute({
      dashboardJson: JSON.stringify(fetched.dashboard),
      changeSummary: 'Rename the dashboard',
      message: 'Rename dashboard through dsh-grafana',
    }, execution())

    assert.match(output, /Dashboard updated/)
    assert.equal(calls.length, 3)
    const request = JSON.parse(calls[2].init.body)
    assert.equal(request.folderUid, 'folder1')
    assert.equal(request.overwrite, false)
    assert.equal(request.message, 'Rename dashboard through dsh-grafana')
    assert.equal(calls[2].init.headers.Authorization, 'Bearer test-token')
    assert.equal(calls[2].init.redirect, 'error')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_push rejects concurrent edits before POST', async () => {
  const originalFetch = globalThis.fetch
  let getCount = 0
  let postCount = 0
  const initial = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === 'POST') {
      postCount += 1
      return jsonResponse({ status: 'success' })
    }
    getCount += 1
    const dashboard = getCount === 1 ? initial : { ...initial, version: 4 }
    return jsonResponse({ meta: { folderUid: 'folder1', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    await assert.rejects(
      toolByName(tools, 'grafana_push').execute({
        dashboardJson: JSON.stringify(initial),
        changeSummary: 'Change one panel',
        message: 'Update panel',
      }, execution()),
      /Dashboard version conflict/,
    )
    assert.equal(postCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_push requires an explicit flag before moving folders', async () => {
  const originalFetch = globalThis.fetch
  let postCount = 0
  const dashboard = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === 'POST') {
      postCount += 1
      return jsonResponse({ status: 'success' })
    }
    return jsonResponse({ meta: { folderUid: 'folder1', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'abc123' }, execution())
    await assert.rejects(
      toolByName(tools, 'grafana_push').execute({
        dashboardJson: JSON.stringify(dashboard),
        changeSummary: 'Move dashboard',
        message: 'Move dashboard',
        folderUid: 'folder2',
      }, execution()),
      /allowFolderMove: true/,
    )
    assert.equal(postCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_clone duplicates a dashboard into a brand-new one and returns its URL', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const source = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [{ id: 1, type: 'timeseries' }] }
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (init.method === 'POST') {
      return jsonResponse({ uid: 'new456', status: 'success', version: 1, url: '/d/new456/overview-copy' })
    }
    if (String(url).endsWith('/api/dashboards/uid/abc123')) {
      return jsonResponse({ meta: { folderUid: 'folder1', canSave: true }, dashboard: source })
    }
    throw new Error(`Unexpected request: ${String(url)}`)
  }

  try {
    const { tools } = createContext()
    const output = await toolByName(tools, 'grafana_clone').execute({
      sourceUrlOrUid: 'https://grafana.example.com/d/abc123/overview',
    }, execution())

    assert.match(output, /Dashboard cloned: uid=new456/)
    // 返回的是可直接打开的完整地址，而非 Grafana 的相对路径。
    assert.match(output, /url=https:\/\/grafana\.example\.com\/d\/new456\/overview-copy/)
    // 未提供 newTitle 时默认追加 " (copy)" 后缀。
    assert.match(output, /New title: "Overview \(copy\)"/)
    assert.match(output, /Call grafana_get on the new dashboard before any further write/)

    // 请求序列：GET 源 → POST 创建。新盘快照由后续 grafana_get 显式建立。
    assert.equal(calls.length, 2)
    const request = JSON.parse(calls[1].init.body)
    assert.equal(request.dashboard.id, null)
    assert.equal(request.dashboard.uid, undefined)
    assert.equal(request.dashboard.version, undefined)
    assert.equal(request.dashboard.title, 'Overview (copy)')
    assert.equal(request.dashboard.panels.length, 1)
    assert.equal(request.overwrite, false)
    assert.equal(request.folderUid, 'folder1')
    assert.match(request.message, /Cloned from abc123/)
    assert.equal(calls[1].init.headers.Authorization, 'Bearer test-token')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_clone honors an explicit title and folder, and requires grafana_get before a follow-up push', async () => {
  const originalFetch = globalThis.fetch
  let postCount = 0
  const source = { id: 7, uid: 'abc123', title: 'Overview', version: 3, panels: [] }
  const created = { id: 99, uid: 'new456', title: 'Staging overview', version: 1, panels: [] }
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      postCount += 1
      if (postCount === 1) return jsonResponse({ uid: 'new456', status: 'success', version: 1, url: '/d/new456/staging-overview' })
      return jsonResponse({ uid: 'new456', status: 'success', version: 2, url: '/d/new456/staging-overview' })
    }
    if (String(url).endsWith('/api/dashboards/uid/abc123')) {
      return jsonResponse({ meta: { folderUid: 'folder1', canSave: true }, dashboard: source })
    }
    return jsonResponse({ meta: { folderUid: 'folder2', canSave: true }, dashboard: created })
  }

  try {
    const { tools } = createContext()
    const clone = toolByName(tools, 'grafana_clone')
    const output = await clone.execute({
      sourceUrlOrUid: 'abc123',
      newTitle: 'Staging overview',
      folderUid: 'folder2',
    }, execution())
    assert.match(output, /Dashboard cloned: uid=new456/)

    const push = toolByName(tools, 'grafana_push')
    await assert.rejects(
      push.execute({
        dashboardJson: JSON.stringify({ ...created, title: 'Staging overview v2' }),
        changeSummary: 'Rename the clone',
        message: 'Rename clone',
      }, execution()),
      /No recent trusted snapshot/,
    )
    assert.equal(postCount, 1)

    // 显式获取新盘后，调用方同时拿到完整 JSON 并建立可信快照。
    const fetched = JSON.parse(await toolByName(tools, 'grafana_get').execute({ urlOrUid: 'new456' }, execution()))
    fetched.dashboard.title = 'Staging overview v2'
    const pushOutput = await push.execute({
      dashboardJson: JSON.stringify(fetched.dashboard),
      changeSummary: 'Rename the clone',
      message: 'Rename clone',
    }, execution())
    assert.match(pushOutput, /Dashboard updated/)
    assert.equal(postCount, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_health reports the database field from the real /api/health shape', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/health')) {
      // 真实 Grafana /api/health 返回 { commit, database, version }，没有 status 字段。
      return jsonResponse({ commit: 'd14a6b3', database: 'ok', version: '11.0.0' })
    }
    return jsonResponse([{ uid: 'a' }, { uid: 'b' }])
  }

  try {
    const { tools } = createContext()
    const output = await toolByName(tools, 'grafana_health').execute({}, execution())
    assert.equal(output, 'health=ok; credential=valid; sampleDashboards=2')
  } finally {
    globalThis.fetch = originalFetch
  }
})

function createSettingsContext(userSection = {}, credentialState = {}) {
  const tools = []
  let section = { ...userSection }
  const registrations = []
  // 可变的凭证状态：resolve 返回 { value }，unset 清空对应 ref。
  const creds = { ...credentialState }
  const ctx = {
    credentials: {
      async resolve(ref) { return creds[ref] ? { value: creds[ref] } : undefined },
      async unset(ref) { delete creds[ref] },
    },
    inject(services, callback) {
      if (!services.includes('settings')) return
      callback({
        ...ctx,
        effect(setup) { setup() },
        settings: {
          register(ns, schema, options = {}) {
            const scope = {
              get: () => schema({ ...options.base, ...section }),
              async update(patch) { section = { ...section, ...patch } },
              async mutate(ops) {
                for (const op of ops ?? []) {
                  if (op.op === 'unset' && op.path?.[0] === 'baseUrl') {
                    const { baseUrl, ...rest } = section
                    section = rest
                  }
                }
              },
            }
            options.validate?.(scope.get())
            registrations.push({ ns, options, scope, creds })
            return scope
          },
        },
      })
    },
    on() { return () => {} },
    systemPrompt: { section() {} },
    tools: {
      register(tool) { tools.push(tool); return () => {} },
    },
  }
  apply(ctx, {})
  return { registrations, tools, creds }
}

test('apply registers a grafana settings namespace and resolves config through it', async () => {
  const { registrations, tools } = createSettingsContext()
  assert.equal(registrations.length, 1)
  const [{ ns, options, scope }] = registrations
  assert.equal(ns, SETTINGS_NAMESPACE)
  assert.equal(typeof options.validate, 'function')
  assert.throws(() => options.validate({ ...scope.get(), tokenRef: 'bad ref' }), /Invalid credential reference/)

  // 用户设置层的值优先于组合层 base，健康检查按其解析 base URL。
  await scope.update({ baseUrl: 'https://grafana.internal' })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return jsonResponse({ database: 'ok' })
  }
  try {
    await toolByName(tools, 'grafana_health').execute({}, execution())
  } catch {
    // 凭证缺失时第二次请求会失败；第一次请求的 URL 已足以证明动态解析生效。
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls[0], 'https://grafana.internal/api/health')
})

test('apply migrates a legacy credential-stored URL into the settings namespace on startup', async () => {
  // 旧版本把 URL 存在 GRAFANA_BASE_URL 凭证里；settings.baseUrl 为空。
  const { registrations, tools, creds } = createSettingsContext(
    {},
    { GRAFANA_BASE_URL: 'https://grafana.legacy.example.com' },
  )
  const [{ scope }] = registrations
  // 迁移 IIFE 是 fire-and-forget，flush 一次微任务让它跑完。
  await new Promise((resolve) => setImmediate(resolve))

  // URL 已搬到 settings namespace，凭证条目已清空。
  assert.equal(scope.get().baseUrl, 'https://grafana.legacy.example.com')
  assert.equal(creds.GRAFANA_BASE_URL, undefined)

  // 迁移后 resolveBaseUrl 从 settings 解析（settings 优先，凭证兜底已空）。
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return jsonResponse({ database: 'ok' })
  }
  try {
    await toolByName(tools, 'grafana_health').execute({}, execution())
  } catch {
    // 凭证缺失时第二次请求会失败；第一次请求的 URL 已足以证明动态解析生效。
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls[0], 'https://grafana.legacy.example.com/api/health')
})

test('resolveBaseUrl prefers settings.baseUrl over the credential value', async () => {
  // settings 有值、凭证也有旧值时，以 settings 为权威源。
  const { tools, creds } = createSettingsContext(
    { baseUrl: 'https://grafana.from-settings.example.com' },
    { GRAFANA_BASE_URL: 'https://grafana.from-credential.example.com' },
  )
  await new Promise((resolve) => setImmediate(resolve))

  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return jsonResponse({ database: 'ok' })
  }
  try {
    await toolByName(tools, 'grafana_health').execute({}, execution())
  } catch {
    // 凭证缺失时第二次请求会失败；第一次请求的 URL 已足以证明动态解析生效。
  } finally {
    globalThis.fetch = originalFetch
  }
  // settings 值胜出；凭证未被迁移清空（因 settings 已非空，迁移 IIFE 跳过）。
  assert.equal(calls[0], 'https://grafana.from-settings.example.com/api/health')
  assert.equal(creds.GRAFANA_BASE_URL, 'https://grafana.from-credential.example.com')
})

test('grafana_query adhoc default state: saved adhoc filters expand into the ES target Lucene query', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'elasticsearch', uid: 'c336bd55-e7bd-4e79-8fdc-16293e6575f0' },
        // Grafana 10 的 adhoc 保存态存在 filters 字段（无 current）。
        filters: [{ key: 'host.keyword', operator: '=', value: 'www.ttpai.cn' }],
      }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'Requests',
      datasource: { type: 'elasticsearch', uid: 'c336bd55-e7bd-4e79-8fdc-16293e6575f0' },
      targets: [{ refId: 'A', query: 'count(*)' }],
    }],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    const output = await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    assert.equal(queryBodies.length, 1)
    const body = queryBodies[0]
    // adhoc 条件拼进 target 的 lucene 查询串（原串非空时括号包裹再 AND）。
    assert.equal(body.queries[0].query, '(count(*)) AND host.keyword:"www.ttpai.cn"')
    // 请求体不得再出现请求级 adhocFilters（Grafana 10.x 的 /api/ds/query 不消费该字段）。
    assert.ok(!('adhocFilters' in body), 'request must not carry top-level adhocFilters')
    // scopedVars 包含 adhoc 变量。
    assert.ok(body.scopedVars, 'request should include scopedVars')
    assert.ok(body.scopedVars.Filters, 'scopedVars should include Filters')
    assert.ok(Array.isArray(body.scopedVars.Filters.value), 'scopedVars.Filters.value should be array')
    assert.equal(body.scopedVars.Filters.value[0].key, 'host.keyword')
    assert.match(output, /panel id=1/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc override: passed filters fully replace saved adhoc filters', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'elasticsearch', uid: 'es' },
        current: { value: [{ key: 'old.field', operator: '=', value: 'old' }] },
      }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'QPS',
      datasource: { type: 'elasticsearch', uid: 'es' },
      targets: [{ refId: 'A', query: 'count(*)' }],
    }],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({
      urlOrUid: 'abc123',
      variables: JSON.stringify({ Filters: [{ key: 'host.keyword', operator: '=', value: 'www.ttpai.cn' }] }),
    }, execution())

    assert.equal(queryBodies.length, 1)
    const body = queryBodies[0]
    // 整体替换：lucene 串只含传入条件，不含保存态。
    assert.equal(body.queries[0].query, '(count(*)) AND host.keyword:"www.ttpai.cn"')
    assert.ok(!('adhocFilters' in body), 'request must not carry top-level adhocFilters')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc multi-operator: = != and numeric > < are expanded into the Lucene query', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'elasticsearch', uid: 'es' },
        current: { value: [
          { key: 'a', operator: '=', value: 'x' },
          { key: 'b', operator: '!=', value: 'y' },
          { key: 'c', operator: '>', value: '10' },
          { key: 'd', operator: '<', value: '20.5' },
          // 值含引号与空格：双引号包裹，内部引号转义。
          { key: 'msg', operator: '=', value: 'say "hello" world' },
        ] },
      }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'Multi',
      datasource: { type: 'elasticsearch', uid: 'es' },
      targets: [{ refId: 'A', query: 'count(*)' }],
    }],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    const body = queryBodies[0]
    assert.equal(
      body.queries[0].query,
      '(count(*)) AND a:"x" AND NOT b:"y" AND c:>10 AND d:<20.5 AND msg:"say \\"hello\\" world"',
    )
    assert.ok(!('adhocFilters' in body), 'request must not carry top-level adhocFilters')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc regex operators map to Lucene regex; non-numeric ranges and bad fields throw', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const makeDashboard = (filters) => ({
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'elasticsearch', uid: 'es' },
        current: { value: filters },
      }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'QPS',
      datasource: { type: 'elasticsearch', uid: 'es' },
      targets: [{ refId: 'A', query: 'count(*)' }],
    }],
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard: makeDashboard([{ key: 'a', operator: '=', value: 'x' }]) })
  }

  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_query')

    // =~ / !~ → Lucene 正则 field:/pattern/；值内 / 转义为 \/。
    await tool.execute({
      urlOrUid: 'abc123',
      variables: JSON.stringify({ Filters: [
        { key: 'path', operator: '=~', value: '/api/v[12]/.*' },
        { key: 'host.keyword', operator: '!~', value: 'www.ttpai.cn|m.ttpai.cn' },
      ] }),
    }, execution())
    assert.equal(
      queryBodies[0].queries[0].query,
      '(count(*)) AND path:/\\/api\\/v[12]\\/.*/ AND NOT host.keyword:/www.ttpai.cn|m.ttpai.cn/',
    )

    // 空正则 → 显式报错，禁止生成 field://。
    await assert.rejects(
      tool.execute({
        urlOrUid: 'abc123',
        variables: JSON.stringify({ Filters: [{ key: 'a', operator: '=~', value: '  ' }] }),
      }, execution()),
      /regex pattern is empty/,
    )

    // > 搭配非数字值 → lucene 不支持字符串范围 → 显式报错。
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/ds/query')) return jsonResponse({ results: { A: { frames: [] } } })
      return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard: makeDashboard([{ key: 'a', operator: '>', value: 'abc' }]) })
    }
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123' }, execution()),
      /numeric/,
    )

    // 含 lucene 特殊字符的字段名 → 拒绝拼接，避免注入歧义。
    await assert.rejects(
      tool.execute({
        urlOrUid: 'abc123',
        variables: JSON.stringify({ Filters: [{ key: 'a:b', operator: '=', value: 'x' }] }),
      }, execution()),
      /cannot be safely mapped/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc priority: query/custom override and [] clears adhoc', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [
        { name: 'env', type: 'query', current: { value: 'staging' } },
        {
          name: 'Filters',
          type: 'adhoc',
          datasource: { type: 'elasticsearch', uid: 'es' },
          current: { value: [{ key: 'host.keyword', operator: '=', value: 'old.example.com' }] },
        },
      ],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'QPS',
      datasource: { type: 'elasticsearch', uid: 'es' },
      targets: [{ refId: 'A', expr: 'rate{env="$env"}', query: '' }],
    }],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    // query 变量 override 生效 + adhoc 清空。
    await toolByName(tools, 'grafana_query').execute({
      urlOrUid: 'abc123',
      variables: JSON.stringify({ env: 'prod', Filters: [] }),
    }, execution())

    assert.equal(queryBodies.length, 1)
    const body = queryBodies[0]
    // query 变量被 override 为 prod。
    assert.equal(body.queries[0].expr, 'rate{env="prod"}')
    // adhoc 被清空：查询串保持原样（空串），请求体无 adhocFilters 键。
    assert.equal(body.queries[0].query, '')
    assert.ok(!('adhocFilters' in body), 'adhoc filters should be cleared with [] — no adhocFilters key')
    // scopedVars 包含两个变量。
    assert.equal(body.scopedVars.env.value, 'prod')
    assert.deepEqual(body.scopedVars.Filters.value, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc explicit errors: unsupported type, unknown variable, invalid filter, non-ES panel', async () => {
  const originalFetch = globalThis.fetch
  const makeDashboard = (extraVars = [], extraPanels = []) => ({
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [
        { name: 'env', type: 'custom', current: { value: 'prod' } },
        {
          name: 'Filters',
          type: 'adhoc',
          datasource: { type: 'elasticsearch', uid: 'es' },
          current: { value: [{ key: 'host.keyword', operator: '=', value: 'www.example.com' }] },
        },
        { name: 'ds', type: 'datasource', current: { value: 'prom' } },
        ...extraVars,
      ],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'QPS',
      datasource: { type: 'elasticsearch', uid: 'es' },
      targets: [{ refId: 'A', query: 'count(*)' }],
    }, ...extraPanels],
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) return jsonResponse({ results: { A: { frames: [] } } })
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard: makeDashboard() })
  }

  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_query')

    // override 指向 datasource 类型变量但值不是 uid 字符串 → rejects。
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123', variables: JSON.stringify({ ds: 123 }) }, execution()),
      /is a datasource variable/,
    )
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123', variables: JSON.stringify({ ds: ['prom'] }) }, execution()),
      /is a datasource variable/,
    )

    // override 指向不存在的变量名 → rejects。
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123', variables: JSON.stringify({ nonexistent: 'x' }) }, execution()),
      /does not exist/,
    )

    // adhoc filter 缺 key → rejects。
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123', variables: JSON.stringify({ Filters: [{ operator: '=', value: 'x' }] }) }, execution()),
      /missing or empty "key"/,
    )

    // adhoc filter operator 非法（~= 不在允许列表） → rejects。
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123', variables: JSON.stringify({ Filters: [{ key: 'f', operator: '~=', value: 'x' }] }) }, execution()),
      /unsupported operator/,
    )

    // 不支持 adhoc 的数据源类型 + 生效 adhoc filters → 整工具报错（含支持矩阵）。
    const unsupportedDsDashboard = {
      id: 7, uid: 'abc123', title: 'Overview', version: 1,
      templating: {
        list: [{
          name: 'Filters',
          type: 'adhoc',
          current: { value: [{ key: 'host.keyword', operator: '=', value: 'x' }] },
        }],
      },
      panels: [{
        id: 1, type: 'timeseries', title: 'Influx',
        datasource: { type: 'influxdb', uid: 'influx' },
        targets: [{ refId: 'A', query: 'from(bucket: "b")' }],
      }],
    }
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/api/ds/query')) return jsonResponse({ results: { A: { frames: [] } } })
      return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard: unsupportedDsDashboard })
    }
    // prometheus/loki/SQL 已受支持；influxdb 等其余类型 → 显式报错并给出支持矩阵。
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123' }, execution()),
      /not supported for datasource type "influxdb".*Supported: elasticsearch.*prometheus.*loki.*SQL/s,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc scoping: bound uid expands per target and expression panels stay in one batch request', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'elasticsearch', uid: 'es1' },
        current: { value: [{ key: 'host.keyword', operator: '=', value: 'www.ttpai.cn' }] },
      }],
    },
    panels: [
      {
        // QPS 面板：A 是 ES 查询，B 是表达式 $A / 60 —— 必须在同一个批量请求里，
        // 否则表达式引擎找不到 refId A 会 500。
        id: 8, type: 'timeseries', title: 'QPS',
        targets: [
          { refId: 'A', datasource: { type: 'elasticsearch', uid: 'es1' }, query: 'count(*)' },
          { refId: 'B', datasource: { type: '__expr__', uid: '__expr__' }, expression: '$A / 60' },
        ],
      },
      {
        id: 2, type: 'timeseries', title: 'ES2 Panel',
        datasource: { type: 'elasticsearch', uid: 'es2' },
        targets: [{ refId: 'B', query: 'rate(*)' }],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] }, p2xB: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    const output = await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    // 单次批量请求：含 __expr__ 面板时表达式引用天然正常（回归：不再按数据源分组拆分）。
    assert.equal(queryBodies.length, 1, 'should send a single batch request')
    assert.equal(queryBodies[0].queries.length, 3)
    assert.ok(!('adhocFilters' in queryBodies[0]), 'request must not carry top-level adhocFilters')

    // es1 target（面板 8 的 A）：adhoc 变量绑定 es1 → 拼进 lucene 串。
    const es1Query = queryBodies[0].queries.find((query) => query.refId === 'A')
    assert.ok(es1Query, 'should have es1 query')
    assert.equal(es1Query.query, '(count(*)) AND host.keyword:"www.ttpai.cn"')

    // 表达式 target（面板 8 的 B）：原样透传，不拼 adhoc。
    const exprQuery = queryBodies[0].queries.find((query) => query.refId === 'B')
    assert.ok(exprQuery, 'should have expression query')
    assert.equal(exprQuery.expression, '$A / 60')
    assert.ok(!('query' in exprQuery), 'expression query should not gain a query field')

    // es2 target（面板 2）：adhoc 变量绑定 es1，es2 不受影响 → 查询串原样。
    const es2Query = queryBodies[0].queries.find((query) => query.refId === 'p2xB')
    assert.ok(es2Query, 'should have es2 query')
    assert.equal(es2Query.query, 'rate(*)')

    assert.match(output, /panel id=8/)
    assert.match(output, /panel id=2/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc scoping: unbound adhoc expands into all non-expr targets in one batch request', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        // 未绑定 uid（无 datasource 字段）→ 通配所有非 __expr__ 数据源。
        current: { value: [{ key: 'host.keyword', operator: '=', value: 'www.ttpai.cn' }] },
      }],
    },
    panels: [
      {
        id: 1, type: 'timeseries', title: 'ES1 Panel',
        datasource: { type: 'elasticsearch', uid: 'es1' },
        targets: [{ refId: 'A', query: 'count(*)' }],
      },
      {
        id: 2, type: 'timeseries', title: 'ES2 Panel',
        datasource: { type: 'elasticsearch', uid: 'es2' },
        targets: [{ refId: 'B', query: 'rate(*)' }],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    // 仍是单次批量请求；两个 ES target 的 lucene 串都拼上条件（未绑定 → 通配）。
    assert.equal(queryBodies.length, 1, 'should send a single batch request')
    assert.equal(queryBodies[0].queries.length, 2)
    for (const query of queryBodies[0].queries) {
      assert.match(query.query, /AND host\.keyword:"www\.ttpai\.cn"$/)
    }
    assert.ok(!('adhocFilters' in queryBodies[0]), 'request must not carry top-level adhocFilters')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc fallback: per-panel degradation keeps the expanded Lucene clause', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  let queryCalls = 0
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'elasticsearch', uid: 'es' },
        current: { value: [{ key: 'host.keyword', operator: '=', value: 'www.ttpai.cn' }] },
      }],
    },
    panels: [
      { id: 1, type: 'stat', title: 'One', datasource: { type: 'elasticsearch', uid: 'es' }, targets: [{ refId: 'A', query: 'count(*)' }] },
      { id: 2, type: 'stat', title: 'Two', datasource: { type: 'elasticsearch', uid: 'es' }, targets: [{ refId: 'A', query: 'sum(bytes)' }] },
    ],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      const body = JSON.parse(init.body)
      queryBodies.push(body)
      queryCalls += 1
      // 第一次批量请求失败，触发逐面板降级。
      if (queryCalls === 1) throw new Error('request timed out')
      return jsonResponse({
        results: Object.fromEntries(body.queries.map((query) => [query.refId, { frames: [] }])),
      })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }
  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    // 1 次批量失败 + 2 次逐面板降级；降级请求体同样不含请求级 adhocFilters，
    // 且每个 target 的 lucene 串都带着展开后的 adhoc 条件。
    assert.equal(queryBodies.length, 3)
    for (const body of queryBodies) {
      assert.ok(!('adhocFilters' in body), 'no request-level adhocFilters on any path')
      for (const query of body.queries) {
        assert.match(query.query, /AND host\.keyword:"www\.ttpai\.cn"$/)
      }
    }
    assert.equal(queryBodies[1].queries.length, 1)
    assert.equal(queryBodies[2].queries.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc prometheus: label matchers injected into every vector selector', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'prometheus', uid: 'prom' },
        current: { value: [{ key: 'host', operator: '=', value: 'www.ttpai.cn' }] },
      }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'Prom',
      datasource: { type: 'prometheus', uid: 'prom' },
      targets: [
        // 裸 metric 名 → 补 {matcher}。
        { refId: 'A', expr: 'up' },
        // 已有选择器 + 内建区间变量 → 追加 matcher，$__rate_interval 不受影响。
        { refId: 'B', expr: 'rate(http_requests_total{env="prod"}[$__rate_interval])' },
        // by()/on()/group_left() 的标签列表不是 metric，不得误伤。
        { refId: 'C', expr: 'sum by (instance) (cpu_total) / on(job) group_left(node) mem_used' },
        // 子查询与字符串字面量。
        { refId: 'D', expr: 'max_over_time(({__name__="cpu"}[5m:1m]) > 10) or label_replace(up, "d", "$1", "src", "(.*)")' },
      ],
    }],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: Object.fromEntries(['A', 'B', 'C', 'D'].map((refId) => [refId, { frames: [] }])) })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    assert.equal(queryBodies.length, 1)
    const queries = queryBodies[0].queries
    const m = 'host="www.ttpai.cn"'
    assert.equal(queries.find((query) => query.refId === 'A').expr, `up{${m}}`)
    assert.equal(
      queries.find((query) => query.refId === 'B').expr,
      `rate(http_requests_total{env="prod",${m}}[$__rate_interval])`,
    )
    assert.equal(
      queries.find((query) => query.refId === 'C').expr,
      `sum by (instance) (cpu_total{${m}}) / on(job) group_left(node) mem_used{${m}}`,
    )
    // 子查询选择器与 {__name__} 形态也注入；label_replace 的字符串参数原样。
    assert.equal(
      queries.find((query) => query.refId === 'D').expr,
      `max_over_time(({__name__="cpu",${m}}[5m:1m]) > 10) or label_replace(up{${m}}, "d", "$1", "src", "(.*)")`,
    )
    assert.ok(!('adhocFilters' in queryBodies[0]))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc prometheus: regex operators map to matchers, numeric range throws', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const makeDashboard = (filters) => ({
    id: 7, uid: 'abc123', title: 'Overview', version: 1,
    templating: {
      list: [{ name: 'Filters', type: 'adhoc', datasource: { type: 'prometheus', uid: 'prom' }, current: { value: filters } }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'Prom',
      datasource: { type: 'prometheus', uid: 'prom' },
      targets: [{ refId: 'A', expr: 'up{job="api"}' }],
    }],
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard: makeDashboard([{ key: 'a', operator: '=', value: 'x' }]) })
  }

  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_query')

    // =~ / !~ 在 PromQL 里原生支持 → 直接映射为正则 matcher。
    await tool.execute({
      urlOrUid: 'abc123',
      variables: JSON.stringify({ Filters: [{ key: 'host', operator: '=~', value: 'www|m\\.' }, { key: 'env', operator: '!~', value: 'staging' }] }),
    }, execution())
    assert.equal(queryBodies[0].queries[0].expr, 'up{job="api",host=~"www|m\\\\.",env!~"staging"}')

    // > / < 无法用 label matcher 表达数值比较 → 显式报错。
    await assert.rejects(
      tool.execute({
        urlOrUid: 'abc123',
        variables: JSON.stringify({ Filters: [{ key: 'latency', operator: '>', value: '100' }] }),
      }, execution()),
      /not supported for label matchers/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc loki: matchers injected into stream selectors only', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Logs', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'loki', uid: 'loki' },
        current: { value: [{ key: 'host', operator: '=', value: 'www.ttpai.cn' }, { key: 'level', operator: '!=', value: 'debug' }] },
      }],
    },
    panels: [{
      id: 1, type: 'logs', title: 'Logs',
      datasource: { type: 'loki', uid: 'loki' },
      targets: [
        // pipeline 阶段（json 等裸标识符）不是 stream selector，不得注入。
        { refId: 'A', expr: '{app="api"} |= "error" | json | line_format "{{.level}}"' },
        { refId: 'B', expr: 'rate({job="x"}[5m])' },
      ],
    }],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    assert.equal(queryBodies.length, 1)
    const matchers = 'host="www.ttpai.cn",level!="debug"'
    assert.equal(
      queryBodies[0].queries.find((query) => query.refId === 'A').expr,
      `{app="api",${matchers}} |= "error" | json | line_format "{{.level}}"`,
    )
    assert.equal(
      queryBodies[0].queries.find((query) => query.refId === 'B').expr,
      `rate({job="x",${matchers}}[5m])`,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc sql: conditions replace the ${__adhoc} placeholder in rawSql', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'SQL', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        // 未绑定 → 通配所有数据源（含 MySQL 面板）。
        current: { value: [{ key: 'host', operator: '=', value: "www.ttpai'cn" }] },
      }],
    },
    panels: [
      {
        id: 1, type: 'timeseries', title: 'PG',
        datasource: { type: 'postgres', uid: 'pg' },
        targets: [{ refId: 'A', rawSql: 'SELECT * FROM logs WHERE ${__adhoc} AND level > 1' }],
      },
      {
        id: 2, type: 'timeseries', title: 'MySQL',
        datasource: { type: 'mysql', uid: 'my' },
        targets: [{ refId: 'B', rawSql: 'SELECT count(*) FROM t WHERE $__adhoc' }],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_query')

    // = 映射为带转义的字符串字面量；${__adhoc} 与 $__adhoc 两种占位符都替换。
    await tool.execute({
      urlOrUid: 'abc123',
      variables: JSON.stringify({ Filters: [{ key: 'host', operator: '=', value: "www.ttpai'cn" }] }),
    }, execution())
    const body = queryBodies[0]
    // 值内单引号翻倍转义，防注入。
    assert.equal(body.queries.find((query) => query.refId === 'A').rawSql, "SELECT * FROM logs WHERE host = 'www.ttpai''cn' AND level > 1")
    assert.equal(body.queries.find((query) => query.refId === 'B').rawSql, "SELECT count(*) FROM t WHERE host = 'www.ttpai''cn'")

    // != → <>；=~ → LIKE；> 数字 → 裸数字比较。
    queryBodies.length = 0
    await tool.execute({
      urlOrUid: 'abc123',
      variables: JSON.stringify({ Filters: [
        { key: 'host', operator: '!=', value: 'old' },
        { key: 'path', operator: '=~', value: '/api%' },
        { key: 'status', operator: '>', value: '399' },
      ] }),
    }, execution())
    assert.equal(
      queryBodies[0].queries.find((query) => query.refId === 'A').rawSql,
      "SELECT * FROM logs WHERE host <> 'old' AND path LIKE '%/api%%' AND status > 399 AND level > 1",
    )

    // rawSql 缺占位符 → 无法应用过滤 → 面板 skipped；全部面板都失败时报错。
    queryBodies.length = 0
    const noPlaceholder = JSON.parse(JSON.stringify(dashboard))
    noPlaceholder.panels = [{
      id: 1, type: 'timeseries', title: 'PG',
      datasource: { type: 'postgres', uid: 'pg' },
      targets: [{ refId: 'A', rawSql: 'SELECT * FROM logs' }],
    }]
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/api/ds/query')) return jsonResponse({ results: { A: { frames: [] } } })
      return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard: noPlaceholder })
    }
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123' }, execution()),
      /no executable query.*\$\{__adhoc\} placeholder/s,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc mixed datasources stay in one batch request with per-type translation', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Mixed', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        // 未绑定 → 通配所有非 __expr__ 数据源。
        current: { value: [{ key: 'host', operator: '=', value: 'www.ttpai.cn' }] },
      }],
    },
    panels: [
      {
        id: 1, type: 'timeseries', title: 'ES',
        datasource: { type: 'elasticsearch', uid: 'es' },
        targets: [{ refId: 'A', query: 'count(*)' }],
      },
      {
        id: 2, type: 'timeseries', title: 'Prom',
        datasource: { type: 'prometheus', uid: 'prom' },
        targets: [{ refId: 'B', expr: 'up' }],
      },
      {
        id: 3, type: 'timeseries', title: 'PG',
        datasource: { type: 'postgres', uid: 'pg' },
        targets: [{ refId: 'C', rawSql: 'SELECT 1 FROM t WHERE ${__adhoc}' }],
      },
      {
        id: 4, type: 'timeseries', title: 'Expr',
        targets: [{ refId: 'D', datasource: { type: '__expr__', uid: '__expr__' }, expression: '$A * 2' }],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] }, C: { frames: [] }, D: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())

    // 单次批量请求：混合数据源（含表达式面板）不拆分。
    assert.equal(queryBodies.length, 1)
    assert.equal(queryBodies[0].queries.length, 4)
    const byRef = Object.fromEntries(queryBodies[0].queries.map((query) => [query.refId, query]))
    // 各类型各自翻译。
    assert.equal(byRef.A.query, '(count(*)) AND host:"www.ttpai.cn"')
    assert.equal(byRef.B.expr, 'up{host="www.ttpai.cn"}')
    assert.equal(byRef.C.rawSql, "SELECT 1 FROM t WHERE host = 'www.ttpai.cn'")
    // 表达式 target 原样透传。
    assert.equal(byRef.D.expression, '$A * 2')
    assert.ok(!('adhocFilters' in queryBodies[0]))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query multi-value variables expand with format modifiers in queries', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Multi', version: 1,
    templating: {
      list: [{ name: 'hosts', type: 'query', current: { value: 'a' } }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'Prom',
      datasource: { type: 'prometheus', uid: 'prom' },
      targets: [{ refId: 'A', expr: 'up{host=~"(${hosts:regex})"}' }],
    }],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    // 多值 override + regex 格式修饰符：Grafana 语义是逐值转义正则特殊字符再以 | 连接。
    await toolByName(tools, 'grafana_query').execute({
      urlOrUid: 'abc123',
      variables: JSON.stringify({ hosts: ['www.ttpai.cn', 'm.ttpai.cn'] }),
    }, execution())
    assert.equal(queryBodies[0].queries[0].expr, 'up{host=~"(www\\.ttpai\\.cn|m\\.ttpai\\.cn)"}')

    // csv 等格式修饰符的展开在 target JSON 插值阶段统一生效。
    queryBodies.length = 0
    await toolByName(tools, 'grafana_query').execute({
      urlOrUid: 'abc123',
      variables: JSON.stringify({ hosts: ['a', 'b'] }),
    }, execution())
    assert.equal(queryBodies[0].queries[0].expr, 'up{host=~"(a|b)"}')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query resolves legacy string datasource uids via the datasource index', async () => {
  // 旧格式大盘：panel.datasource 是纯字符串 uid（Grafana 8 及更早保存的大盘）。
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const apiCalls = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Legacy', version: 1,
    templating: { list: [] },
    panels: [{
      id: 1, type: 'timeseries', title: 'CPU',
      datasource: 'legacy-uid-0001',
      targets: [{ refId: 'A', expr: 'node_cpu_seconds_total{mode="idle"}' }],
    }],
  }
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    apiCalls.push(path)
    if (path.includes('/api/datasources')) {
      return jsonResponse([
        { uid: 'legacy-uid-0001', type: 'prometheus', name: 'Prom Legacy', isDefault: false },
        { uid: 'prom-default', type: 'prometheus', name: 'Prom Default', isDefault: true },
      ])
    }
    if (path.includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())
    assert.ok(apiCalls.some((path) => path.includes('/api/datasources')), 'index must be fetched when a string ref appears')
    assert.equal(queryBodies.length, 1)
    // 字符串 uid 解析出 type，请求体携带完整 {type, uid}。
    assert.deepEqual(queryBodies[0].queries[0].datasource, { type: 'prometheus', uid: 'legacy-uid-0001' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query resolves $datasource references, maps "default", and supports datasource variable override', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Alertmanager', version: 1,
    templating: {
      list: [
        { name: 'datasource', type: 'datasource', current: { text: 'default', value: 'default' } },
        { name: 'instance', type: 'query', current: { value: ['10.0.0.1:9093'] } },
      ],
    },
    panels: [{
      id: 4, type: 'stat', title: 'Instances',
      datasource: { uid: '$datasource' },
      targets: [{ refId: 'A', expr: 'count(alertmanager_build_info{instance=~"$instance"})' }],
    }],
  }
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.includes('/api/datasources')) {
      return jsonResponse([
        { uid: 'prom-default', type: 'prometheus', name: 'Prom Default', isDefault: true },
        { uid: 'prom-two', type: 'prometheus', name: 'Prom Two', isDefault: false },
      ])
    }
    if (path.includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_query')

    // 保存态默认值 "default" 映射到 isDefault 数据源；$instance 单值数组裸渲染。
    await tool.execute({ urlOrUid: 'abc123' }, execution())
    assert.deepEqual(queryBodies[0].queries[0].datasource, { type: 'prometheus', uid: 'prom-default' })
    assert.equal(queryBodies[0].queries[0].expr, 'count(alertmanager_build_info{instance=~"10.0.0.1:9093"})')

    // datasource 型变量按 uid 字符串覆盖：整盘切换数据源。
    queryBodies.length = 0
    await tool.execute({ urlOrUid: 'abc123', variables: JSON.stringify({ datasource: 'prom-two' }) }, execution())
    assert.deepEqual(queryBodies[0].queries[0].datasource, { type: 'prometheus', uid: 'prom-two' })

    // datasource 变量引用无保存值 → 面板级 skip，整工具报错列出原因与面板标题。
    const emptyDashboard = {
      ...dashboard,
      templating: {
        list: [
          { name: 'datasource', type: 'datasource', current: {} },
          { name: 'instance', type: 'query', current: { value: ['10.0.0.1:9093'] } },
        ],
      },
    }
    globalThis.fetch = async (url, init) => {
      const path = String(url)
      if (path.includes('/api/datasources')) {
        return jsonResponse([{ uid: 'prom-default', type: 'prometheus', name: 'Prom Default', isDefault: true }])
      }
      if (path.includes('/api/ds/query')) return jsonResponse({ results: { A: { frames: [] } } })
      return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard: emptyDashboard })
    }
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123' }, execution()),
      (error) => {
        assert.match(error.message, /yielded no executable query/)
        assert.match(error.message, /panel id=4 "Instances"/)
        assert.match(error.message, /Unresolved Grafana template variable "datasource"/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query skips row-panel leftover targets and dedupes per-panel skip reasons', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Alertmanager', version: 1,
    templating: {
      list: [
        { name: 'datasource', type: 'datasource', current: { text: 'default', value: 'default' } },
        { name: 'instance', type: 'query', current: { value: ['10.0.0.1:9093'] } },
      ],
    },
    panels: [
      // row 面板：Grafana 保存残留的空 target（只有 datasource/refId，无 expr）。
      // 原样发给 /api/ds/query 会让 Prometheus 报 400 "no expression found in input"。
      {
        id: 36, type: 'row', title: 'General info',
        datasource: { type: 'prometheus', uid: 'prom-default' },
        targets: [
          { refId: 'A', datasource: { type: 'prometheus', uid: 'prom-default' } },
          { refId: 'B', datasource: { type: 'prometheus', uid: 'prom-default' } },
        ],
      },
      {
        id: 4, type: 'stat', title: 'Instances',
        datasource: { uid: '$datasource' },
        targets: [{ refId: 'A', expr: 'count(alertmanager_build_info{instance=~"$instance"})' }],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.includes('/api/datasources')) {
      return jsonResponse([{ uid: 'prom-default', type: 'prometheus', name: 'Prom Default', isDefault: true }])
    }
    if (path.includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    const tool = toolByName(tools, 'grafana_query')
    const out = await tool.execute({ urlOrUid: 'abc123' }, execution())
    // 空载荷 target 绝不发给数据源；$datasourse 引用面板的 expr 原样保留。
    const sentExprs = queryBodies.flatMap((body) => body.queries.map((query) => query.expr))
    assert.equal(sentExprs.length, 1)
    assert.equal(sentExprs[0], 'count(alertmanager_build_info{instance=~"10.0.0.1:9093"})')
    // row 的两条空 target 去重为一条 skip 说明，附 refId 列表。
    assert.match(out, /panel id=36 "General info": skipped \(the target carries no query payload[^)]*\) \(targets A, B\)/)
    assert.equal(out.split('carries no query payload').length - 1, 1)

    // 同一面板多个 target 因同一原因（未解析变量）被跳过 → 报错只出现一次。
    const unresolved = {
      ...dashboard,
      panels: [{
        id: 9, type: 'timeseries', title: 'Unresolved',
        datasource: { type: 'prometheus', uid: 'prom-default' },
        targets: [
          { refId: 'A', expr: 'up{job="$missing"}' },
          { refId: 'B', expr: 'down{job="$missing"}' },
          { refId: 'C', expr: 'other{job="$missing"}' },
        ],
      }],
    }
    globalThis.fetch = async () => jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard: unresolved })
    await assert.rejects(
      tool.execute({ urlOrUid: 'abc123' }, execution()),
      (error) => {
        assert.match(error.message, /yielded no executable query/)
        assert.equal(error.message.split('Unresolved Grafana template variable "missing"').length - 1, 1)
        assert.match(error.message, /\(targets A, B, C\)/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query passes unknown datasource uids through when the index is unavailable', async () => {
  // GET /api/datasources 无权限（403）时索引为 null：字符串 uid 原样透传，
  // 由 Grafana 自行解析裸 uid。
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Legacy', version: 1,
    templating: { list: [] },
    panels: [{
      id: 1, type: 'timeseries', title: 'CPU',
      datasource: 'unknown-uid',
      targets: [{ refId: 'A', expr: 'up' }],
    }],
  }
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.includes('/api/datasources')) return jsonResponse({ message: 'access denied' }, 403)
    if (path.includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())
    assert.deepEqual(queryBodies[0].queries[0].datasource, { uid: 'unknown-uid' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query throws when adhoc filters hit a passthrough datasource of unknown type', async () => {
  const originalFetch = globalThis.fetch
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Legacy', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        current: { value: [{ key: 'host', operator: '=', value: 'www.ttpai.cn' }] },
      }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'CPU',
      datasource: 'unknown-uid',
      targets: [{ refId: 'A', expr: 'up' }],
    }],
  }
  globalThis.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/api/datasources')) return jsonResponse({ message: 'access denied' }, 403)
    if (path.includes('/api/ds/query')) return jsonResponse({ results: { A: { frames: [] } } })
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    // 索引不可用 + 生效 adhoc：无法安全翻译 → 显式报错（含数据源 uid）。
    await assert.rejects(
      toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution()),
      /cannot be applied to datasource uid "unknown-uid"/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query renders bare multi-value variables as (a|b) inside Prometheus and Loki targets', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Multi', version: 1,
    templating: {
      list: [
        { name: 'job', type: 'query', current: { value: ['node-exporter', 'other'] } },
        { name: 'host', type: 'query', current: { value: ['10.0.0.1'] } },
        { name: 'addr', type: 'query', current: { value: ['82.156.207.97:9100', '119.45.27.31:9100'] } },
        { name: 'app', type: 'query', current: { value: ['api', 'web'] } },
        { name: 'env', type: 'query', current: { value: ['prod', 'staging'] } },
      ],
    },
    panels: [
      {
        id: 1, type: 'timeseries', title: 'Prom',
        datasource: { type: 'prometheus', uid: 'prom' },
        targets: [{ refId: 'A', expr: 'up{job=~"$job", host=~"$host", instance=~"$addr"}' }],
      },
      {
        id: 2, type: 'timeseries', title: 'Loki',
        datasource: { type: 'loki', uid: 'loki' },
        targets: [{ refId: 'A', expr: '{app=~"$app"} |= "error"' }],
      },
      {
        id: 3, type: 'timeseries', title: 'ES',
        datasource: { type: 'elasticsearch', uid: 'es' },
        targets: [{ refId: 'A', query: 'env:($env)' }],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] }, C: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())
    const byDs = new Map(queryBodies[0].queries.map((q) => [q.datasource.uid, q]))
    // 多值裸引用 → (a|b)，值保持原样（PromQL 双引号内 \. 是非法转义）；
    // 单值数组保持裸值。
    assert.equal(byDs.get('prom').expr, 'up{job=~"(node-exporter|other)", host=~"10.0.0.1", instance=~"(82.156.207.97:9100|119.45.27.31:9100)"}')
    assert.equal(byDs.get('loki').expr, '{app=~"(api|web)"} |= "error"')
    // ES target 不受 promql 模式影响：裸多值仍是全局默认逗号连接。
    assert.equal(byDs.get('es').query, 'env:(prod,staging)')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc prometheus: leading-colon recording rules receive matchers too', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Recording rules', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'prometheus', uid: 'prom' },
        current: { value: [{ key: 'instance', operator: '=', value: 'web-1' }] },
      }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'Rules',
      datasource: { type: 'prometheus', uid: 'prom' },
      targets: [
        // kube-prometheus 风格的 :node_xxx: 录制规则，前导冒号不能让它逃过注入。
        { refId: 'A', expr: ':node_memory_utilisation: * 100' },
        // 聚合函数里包裹的前导冒号规则。
        { refId: 'B', expr: 'sum(:node_memory_MemAvailable_bytes:sum)' },
        // 前导冒号规则自带选择器时追加而非覆盖。
        { refId: 'C', expr: ':node_load1{env="prod"}' },
      ],
    }],
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] }, C: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())
    assert.equal(queryBodies.length, 1)
    const queries = queryBodies[0].queries
    const m = 'instance="web-1"'
    assert.equal(queries.find((q) => q.refId === 'A').expr, `:node_memory_utilisation:{${m}} * 100`)
    assert.equal(queries.find((q) => q.refId === 'B').expr, `sum(:node_memory_MemAvailable_bytes:sum{${m}})`)
    assert.equal(queries.find((q) => q.refId === 'C').expr, `:node_load1{env="prod",${m}}`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc: saved OR conditions throw instead of being silently rewritten to AND', async () => {
  const originalFetch = globalThis.fetch
  const dashboard = {
    id: 7, uid: 'abc123', title: 'Or filters', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: { type: 'elasticsearch', uid: 'es1' },
        current: { value: [
          { key: 'host', operator: '=', value: 'a' },
          { key: 'host', operator: '=', value: 'b', condition: 'OR' },
        ] },
      }],
    },
    panels: [{
      id: 1, type: 'timeseries', title: 'ES',
      targets: [{ refId: 'A', datasource: { type: 'elasticsearch', uid: 'es1' }, query: 'count(*)' }],
    }],
  }
  globalThis.fetch = async () => jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })

  try {
    const { tools } = createContext()
    await assert.rejects(
      () => toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution()),
      (error) => error instanceof Error && /OR/.test(error.message) && /Filters/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc scoping: legacy datasource-name binding resolves through the index', async () => {
  // 旧格式大盘的 adhoc variable.datasource 是数据源“名称”字符串而非 uid，
  // 必须经索引解析到真实 uid 后再做绑定匹配，不能静默丢过滤。
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'LegacyBind', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: 'Prod ES',
        current: { value: [{ key: 'host.keyword', operator: '=', value: 'www.ttpai.cn' }] },
      }],
    },
    panels: [
      {
        id: 1, type: 'timeseries', title: 'Bound',
        datasource: { type: 'elasticsearch', uid: 'es-prod' },
        targets: [{ refId: 'A', query: 'count(*)' }],
      },
      {
        id: 2, type: 'timeseries', title: 'Other',
        datasource: { type: 'elasticsearch', uid: 'es-other' },
        targets: [{ refId: 'B', query: 'count(*)' }],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.includes('/api/datasources')) {
      return jsonResponse([
        { uid: 'es-prod', type: 'elasticsearch', name: 'Prod ES', isDefault: false },
        { uid: 'es-other', type: 'elasticsearch', name: 'Other ES', isDefault: false },
      ])
    }
    if (path.includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())
    assert.equal(queryBodies.length, 1)
    const queries = queryBodies[0].queries
    assert.equal(queries.find((q) => q.refId === 'A').query, '(count(*)) AND host.keyword:"www.ttpai.cn"')
    assert.equal(queries.find((q) => q.refId === 'B').query, 'count(*)')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('grafana_query adhoc scoping: "default" pseudo uid binding maps to the default datasource', async () => {
  const originalFetch = globalThis.fetch
  const queryBodies = []
  const dashboard = {
    id: 7, uid: 'abc123', title: 'DefaultBind', version: 1,
    templating: {
      list: [{
        name: 'Filters',
        type: 'adhoc',
        datasource: 'default',
        current: { value: [{ key: 'host.keyword', operator: '=', value: 'www.ttpai.cn' }] },
      }],
    },
    panels: [
      {
        id: 1, type: 'timeseries', title: 'DefaultDs',
        datasource: { type: 'elasticsearch', uid: 'es-main' },
        targets: [{ refId: 'A', query: 'count(*)' }],
      },
      {
        id: 2, type: 'timeseries', title: 'Secondary',
        datasource: { type: 'elasticsearch', uid: 'es-2' },
        targets: [{ refId: 'B', query: 'count(*)' }],
      },
    ],
  }
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.includes('/api/datasources')) {
      return jsonResponse([
        { uid: 'es-main', type: 'elasticsearch', name: 'Main ES', isDefault: true },
        { uid: 'es-2', type: 'elasticsearch', name: 'Second ES', isDefault: false },
      ])
    }
    if (path.includes('/api/ds/query')) {
      queryBodies.push(JSON.parse(init.body))
      return jsonResponse({ results: { A: { frames: [] }, B: { frames: [] } } })
    }
    return jsonResponse({ meta: { folderUid: '', canSave: true }, dashboard })
  }

  try {
    const { tools } = createContext()
    await toolByName(tools, 'grafana_query').execute({ urlOrUid: 'abc123' }, execution())
    assert.equal(queryBodies.length, 1)
    const queries = queryBodies[0].queries
    assert.equal(queries.find((q) => q.refId === 'A').query, '(count(*)) AND host.keyword:"www.ttpai.cn"')
    assert.equal(queries.find((q) => q.refId === 'B').query, 'count(*)')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internals exports the stable debug surface across the lib/ split', () => {
  // internals 是测试与调试依赖的稳定契约：lib/ 拆分后键集合不得增减或更名。
  assert.deepEqual(Object.keys(internals).sort(), [
    'approvalReason',
    'approvalUid',
    'cloneApprovalReason',
    'dashboardSummary',
    'diffDashboards',
    'interpolateVariables',
    'normalizeBaseUrl',
    'parseDashboardUrl',
    'parseUid',
    'readLimitedText',
    'safeApiErrorDetail',
    'summarizeFrames',
  ])
  for (const key of Object.keys(internals)) {
    assert.equal(typeof internals[key], 'function', `internals.${key} must stay a function`)
  }
  assert.ok(Object.isFrozen(internals))
})
