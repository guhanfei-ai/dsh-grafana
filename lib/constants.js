// lib/constants.js — 超时、大小上限与格式约束等全部常量，集中一处便于审查与调整。

export const TOKEN_REF = 'GRAFANA_TOKEN'
export const BASE_URL_REF = 'GRAFANA_BASE_URL'
export const UID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
// 多源站：每个源站一个稳定 id（UUID，系统生成、只读、全球唯一），
// 名称唯一且必填（工具按名称逐次选源），令牌凭证 ref 由 id 派生。
export const DEFAULT_SOURCE_NAME = 'default'
// 每源站令牌 ref 前缀：GRAFANA_TOKEN_<id 剥离非法字符>（满足 CREDENTIAL_REF_PATTERN）。
export const TOKEN_REF_PREFIX = 'GRAFANA_TOKEN_'
export const MAX_SOURCES = 50
export const MAX_SOURCE_NAME_CHARS = 100
// 源站 id 允许 UUID（含横线）等；派生凭证 ref 时再剥离横线等非法字符。
// 写入口（index.js validateConfig）强制此模式；运行期 effectiveSources 只要求非空，宽容读。
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
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
// 上游 400 诊断行的长度上限：既有 safeApiErrorDetail 截 300 字符，而诊断要与
// 「Grafana API <status> <METHOD> <path>: 」前缀同行出现，故留 60 字符余量给前缀。
export const UPSTREAM_DIAGNOSIS_CHARS = 240

// ── 只读观测工具：grafana_datasources / grafana_metric / grafana_trend / grafana_alerts ──
// 数据源发现：单屏可读的行数上限，与 MAX_QUERY_SUMMARY_LINES=60 同量级；超出走
// 预算行披露，不引入分页参数（过滤 + 预算已足够，参数面更小）。
export const MAX_DATASOURCE_ROWS = 40
// 裸查询采样点数：默认约为既有 MAX_QUERY_POINTS_PER_QUERY=500 的 1/4（单查询足够
// 看清形状）；上限略低于 500，不新造数量级；低于 10 点已无趋势意义。
export const METRIC_DEFAULT_POINTS = 120
export const METRIC_MAX_POINTS = 480
export const METRIC_MIN_POINTS = 10
// 裸查询文本长度上限（字符）：与 MAX_QUERY_VARIABLES_BYTES=4096 同量级，够写带多层
// 聚合与 label matcher 的 PromQL/LogQL，同时挡住把整段日志当查询塞进来的误用。
export const MAX_METRIC_EXPR_CHARS = 4000
// 序列条数上限：与 MAX_DATASOURCE_ROWS 同值便于记忆；放宽上限取
// MAX_FRAMES_PER_QUERY=10 × 20，够排查用又不失控。
export const MAX_METRIC_SERIES = 40
export const MAX_METRIC_SERIES_LIMIT = 200
// 趋势桶数：与 SPARK_GLYPHS 的 8 档配合，24 桶约每桶 3 字符仍可读；
// 上限 180 桶 = TREND_WINDOW_DAYS=90 天按 12 小时粒度。
export const TREND_DEFAULT_BUCKETS = 24
export const TREND_MAX_BUCKETS = 180
// 一次趋势请求所有 series 的点数总预算：METRIC_MAX_POINTS=480 × 25 条 series 量级。
// 超出时整条 series 丢弃（不半截切）：半截序列会渲染出假走向。
export const MAX_TOTAL_TREND_POINTS = 12_000
// 趋势与裸查询 range 模式的区间上限：大盘排障常用的季度窗。
export const TREND_WINDOW_DAYS = 90
// Loki 返回的是日志行，量级远大于指标点：约为 METRIC_DEFAULT_POINTS 的 4 倍并取整。
export const LOKI_MAX_LINES = 500
// 告警行数：默认与 DEFAULT_QUERY_MAX_PANELS=30 对齐，上限与 MAX_SOURCES=50 同量级；
// 规则定义段与活跃告警各自独立计预算。
export const MAX_ALERT_ROWS = 30
export const ALERT_ROWS_LIMIT = 100
export const MAX_ALERT_RULE_ROWS = 100
// 活跃告警的过滤档位：默认只报 firing（模型问「现在有什么在烧」时，被静默的
// 那些正是它不该被分心的部分）；suppressed 与 all 供排查静默/抑制规则本身时用。
export const ALERT_STATES = new Set(['firing', 'suppressed', 'all'])
// 走向判定：前后半均值相对变化在 5% 内视为持平；峰值超均值 50% 视为抖动（可叠加）。
export const TREND_FLAT_THRESHOLD = 0.05
export const TREND_VOLATILE_RATIO = 1.5
// 火花线字形：8 档，按桶值 min-max 归一映射。
export const SPARK_GLYPHS = '▁▂▃▄▅▆▇█'
// 裸查询支持的数据源类型白名单：这两类的查询文本可由模型直接书写；其它类型
// （SQL、elasticsearch 等）的查询形状依赖大盘 target 的既有配置，走 grafana_panel_query。
export const METRIC_SUPPORTED_TYPES = new Set([PROMETHEUS_DATASOURCE_TYPE, LOKI_DATASOURCE_TYPE])
// 超时：裸查询单请求与既有 QUERY_REQUEST_TIMEOUT_MS 同档，工具级介于
// TOOL_TIMEOUT_MS=35s 与 QUERY_TOOL_TIMEOUT_MS=90s 之间；趋势点多再放宽一档；
// 告警是两次顺序请求，与裸查询同档。
export const METRIC_REQUEST_TIMEOUT_MS = 30_000
export const METRIC_TOOL_TIMEOUT_MS = 45_000
export const TREND_TOOL_TIMEOUT_MS = 120_000
export const ALERT_TOOL_TIMEOUT_MS = 45_000
