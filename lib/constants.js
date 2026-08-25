// lib/constants.js — 超时、大小上限与格式约束等全部常量，集中一处便于审查与调整。

export const TOKEN_REF = 'GRAFANA_TOKEN'
export const BASE_URL_REF = 'GRAFANA_BASE_URL'
export const UID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const REQUEST_TIMEOUT_MS = 15_000
export const TOOL_TIMEOUT_MS = 35_000
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_DASHBOARD_BYTES = 2 * 1024 * 1024
export const SNAPSHOT_TTL_MS = 30 * 60 * 1000
export const MAX_SNAPSHOTS = 100
export const APPROVAL_LIVE_TIMEOUT_MS = 5_000
export const RETRYABLE_STATUS = new Set([502, 503, 504])
export const MAX_DIFF_LINES = 24
export const MAX_DIFF_VALUE_CHARS = 80
export const MAX_DIFF_CHANGED_KEYS = 8
// diff 不比较身份字段与已单独分节展示的 panels/templating。
export const DIFF_SKIP_FIELDS = new Set(['panels', 'templating', 'id', 'uid', 'version'])
export const MAX_QUERY_VARIABLES_BYTES = 4 * 1024
export const DEFAULT_QUERY_MAX_PANELS = 30
export const QUERY_MAX_PANELS_LIMIT = 50
export const MAX_QUERY_POINTS_PER_QUERY = 500
export const MAX_FRAMES_PER_QUERY = 10
export const MAX_QUERY_SUMMARY_LINES = 60
// 数据源查询可能比普通 API 慢，单独放宽；批量失败后还有逐面板降级，工具总超时再放宽。
export const QUERY_REQUEST_TIMEOUT_MS = 30_000
export const QUERY_TOOL_TIMEOUT_MS = 90_000
// 摘要模式的查询文本候选键，取第一个命中的。
export const SUMMARY_QUERY_KEYS = ['expr', 'query', 'rawSql', 'expression', 'lucene', 'queryText']
export const MAX_SUMMARY_LINES = 150
export const RELATIVE_TIME_PATTERN = /^now(-\d+[smhdwy])?$/
export const TIMESTAMP_PATTERN = /^\d{13}$/
export const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g
