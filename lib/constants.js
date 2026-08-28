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
// 模板变量引用：${var}、${var:format}（format 仅限字母，与 Grafana 的命名格式一致）
// 与裸 $var。$__interval 等内建变量由调用方透传。
export const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z]+))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g
// ${var:...} 完整形状（format 可为空或含非字母字符，用于捕获后统一校验报错）。
export const VARIABLE_FORMAT_CLAUSE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*):([^}]*)\}/g
// 支持的 Grafana 标准格式修饰符；未知修饰符显式报错，禁止静默替换。
export const VARIABLE_FORMATS = new Set([
  'csv', 'doublequote', 'singlequote', 'json', 'raw', 'pipe',
  'percent', 'querystring', 'regex', 'lucene', 'sqlstring',
])
export const ADHOC_OPERATORS = new Set(['=', '!=', '>', '<', '=~', '!~'])
export const OVERRIDABLE_VARIABLE_TYPES = new Set(['query', 'custom', 'interval', 'adhoc', 'textbox', 'constant', 'datasource'])
// datasource 型模板变量保存值为 "default" 时指向服务端默认数据源（Grafana 保留伪 uid，
// /api/ds/query 不接受它，需经 /api/datasources 索引映射到 isDefault 的真实数据源）。
export const DEFAULT_DATASOURCE_UID = 'default'
export const ELASTICSEARCH_DATASOURCE_TYPE = 'elasticsearch'
export const PROMETHEUS_DATASOURCE_TYPE = 'prometheus'
export const LOKI_DATASOURCE_TYPE = 'loki'
// SQL 类数据源：adhoc 条件经 ${__adhoc} 占位符替换进 rawSql（Grafana 惯例）。
export const SQL_DATASOURCE_TYPES = new Set(['mysql', 'postgres', 'mssql', 'mariadb', 'sqlite', 'clickhouse'])
// adhoc 支持矩阵的报错/文档文案（单处维护，保持 message 与 README 一致）。
export const ADHOC_DATASOURCE_SUPPORT_TEXT = 'elasticsearch (merged into the Lucene query), prometheus and loki (label matchers added to selectors), and SQL datasources (mysql/postgres/mssql/mariadb/sqlite/clickhouse via the ${__adhoc} placeholder in rawSql)'
