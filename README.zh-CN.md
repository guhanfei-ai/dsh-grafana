# dsh-grafana

[English](./README.md)

一个用于通过对话读取、编辑并安全写回 Grafana 大盘的 DeepSeek Harness 插件。插件直接操作 Dashboard JSON，不需要截图。

> 项目状态：1.0 前版本。核心写回路径已经具备安全保护和自动化测试，但尚未完成 Grafana 12+ 兼容性认证。

## 核心能力

- 通过浏览器 URL 或 UID 获取大盘；超大盘可改用结构化摘要模式，只返回面板/查询/阈值/变量骨架。
- 按标题和标签搜索大盘。
- 粘贴大盘或面板视图 URL，直接查询面板背后的真实数据。
- 把大盘复制为全新大盘，并返回新大盘地址。
- 通过对话调整面板、查询、阈值、变量和布局。
- 写回时自动保持大盘所在文件夹。
- 写入前检测并发修改。
- 每次写入都必须经过 DSH 原生用户审批。
- Service Account 凭证只保存在本机 DSH 凭证库。

## 环境要求

| 组件 | 已支持基线 |
| --- | --- |
| Node.js | 20.11 或更高版本 |
| DeepSeek Harness | `0.1.0-rc.6` |
| Grafana | Grafana 10/11 文档中的传统 Dashboard HTTP API |

Grafana 12 引入了新 Dashboard API。旧接口可能仍然可用，但 Grafana 12+ 暂未进入本插件的正式兼容矩阵。

## 安装

正式使用应安装不可变的 Release tag：

```bash
dsh plugin --profile <profile> add github:guhanfei-ai/dsh-grafana#v<version>
```

仅在测试时安装会持续变化的默认分支：

```bash
dsh plugin --profile <profile> add github:guhanfei-ai/dsh-grafana
```

本地开发：

```bash
npm ci
dsh plugin --profile <profile> add link:/绝对路径/dsh-grafana
```

安装后重启对应 DSH profile。

Windows 可使用 `link:C:/path/to/dsh-grafana` 形式的绝对路径。插件运行本身支持跨平台；`deploy.sh` 需要 Git Bash、WSL、macOS 或 Linux。

## 配置

在 DSH Web 中打开 **设置 → 插件 → Grafana dashboard editor**。

> 提示：设置页按 Host 端注册的 settings 命名空间派发插件卡片（`grafana`）。命名空间列表只在设置文档变更或连接重置时刷新，因此升级插件后如果卡片没有出现，刷新页面（或重连 Web UI）即可。

需要配置：

- **Service Account Token**：例如 `glsa_...`。
- **Grafana URL**：例如 `https://grafana.example.com` 或 `https://example.com/grafana`。

Token 使用 DSH 仅允许 loopback same-origin 访问的特权凭证 RPC：仅写不读，保存后的值不会被读取或回显。URL 存储在 `grafana` settings namespace 的非 secret 字段中，因此可读回明文并在卡片中显示以便核对。界面支持替换和删除。

HTTP 与 HTTPS 开箱即用，内网未配置证书的环境可直接填写 `http://` 地址，无需额外设置。注意：HTTP 会明文传输服务账号令牌，不可信网络环境请务必使用 HTTPS。如需强制仅允许 HTTPS，可在插件配置中关闭：

```yaml
allowInsecureHttp: false
```

settings 中的 `baseUrl` 为权威来源；早期版本存在 `GRAFANA_BASE_URL` 凭证中的 URL 会在启动时自动迁移到 settings，之后凭证值仅作兜底。Token 凭证名默认为 `GRAFANA_TOKEN`，可通过 `tokenRef` 修改。

### Grafana 权限

优先使用最小权限 RBAC，只授予目标大盘及文件夹所需范围：

- `dashboards:read`
- `dashboards:write`
- 目标文件夹的 `folders:read`
- `grafana_query` 需要 `datasources:query` 以及对所查数据源的访问权限

不支持细粒度 RBAC 时才使用 Editor 角色，避免使用 Admin token。

## 工具

| 工具 | 行为 |
| --- | --- |
| `grafana_get` | 获取完整大盘，并保存一个短期可信的版本和目录快照。传 `summary: true` 时改为返回结构化摘要（面板、查询、阈值、变量），不记录写快照，适合超大盘。 |
| `grafana_push` | 在审批、身份校验、版本校验和目录保持后写回最近读取的大盘。 |
| `grafana_clone` | 把大盘复制为全新大盘（全新 UID、版本 1），默认留在源文件夹，并返回新大盘完整地址。同样需要审批，继续写入前必须先调用 `grafana_get`。 |
| `grafana_query` | 执行粘贴的大盘或面板视图 URL（`?viewPanel=` 限定单面板；沿用 URL 里的 `from`/`to` 时间范围）背后的面板数据源查询，返回有界的实时数据摘要。模板变量默认使用大盘保存状态，可通过 `variables` 参数覆盖——单值（`{"env":"prod"}`）、多值（`{"host":["www","m"]}`，按查询中使用的格式修饰符展开）或 adhoc 过滤（见[模板变量覆盖](#模板变量覆盖grafana_query)）。adhoc 过滤按数据源类型翻译：Elasticsearch 拼进各 target 的 Lucene 查询串，Prometheus/Loki 向每个 vector/stream selector 注入 label matcher，SQL 数据源替换 `rawSql` 中的 `${__adhoc}` 占位符；其它数据源类型存在生效的 adhoc 时显式报错并列出支持矩阵。adhoc 覆盖为整体替换保存态，`[]` 表示清空，并按 target 的数据源 uid 逐个生效——绑定某个数据源的变量不会影响其它数据源。不支持的运算符/数据源组合显式报错，绝不静默忽略。仅支持 `query`/`custom`/`interval`/`adhoc`/`textbox`/`constant`/`datasource` 类型变量覆盖（datasource 型变量传 uid 字符串），不支持的类型会显式报错。Prometheus/Loki target 中裸多值变量渲染为 `(a|b)` 以便用于 `=~` matcher。旧格式 datasource 引用自动解析：纯字符串 uid 与 `{"uid":"$datasource"}` 型 datasource 变量引用经 `GET /api/datasources` 解析（保存值 `"default"` 映射到默认数据源）。服务端表达式（`__expr__`，如 `$A / 60`）原样透传；变量插值失败的面板只跳过不阻断整盘——全部跳过时列出每个面板的 id、标题与原因；批量请求失败时自动降级为逐面板查询（正常路径始终整选区单次批量 POST，保证 `$A` 式表达式引用不断链）。只读，不记录写快照。 |
| `grafana_search` | 按标题和精确标签搜索，最多返回 50 条。 |
| `grafana_health` | 检查 Grafana 连通性与 Service Account 凭证。 |

### 模板变量覆盖（`grafana_query`）

`variables` 参数是一个以变量名为键的 JSON 对象。大盘中所有可覆盖变量（`query`/`custom`/`interval`/`adhoc`/`textbox`/`constant`/`datasource` 类型）均可覆盖；不支持的类型显式报错。

单值——替换该变量出现的所有位置（`$env`、`${env}`）：

```json
{ "env": "prod" }
```

多值——传数组，展开方式遵循查询里使用的 Grafana 格式修饰符，为多选变量编写的大盘无需改动即可工作：

```json
{ "host": ["www.ttpai.cn", "m.ttpai.cn"] }
```

**Prometheus / Loki target** 里无修饰符的裸多值引用（`$host`）渲染为 `(www.ttpai.cn|m.ttpai.cn)`——即 `=~` label matcher 里可用的交替形式，与 Grafana 自身渲染一致。值不做正则转义（Grafana 也不转义；双引号 PromQL 字符串里把 `.` 转义成 `\.` 是语法错误）。需要精确匹配时使用显式 `${host:regex}` 修饰符。

| 查询占位符 | 展开结果 |
| --- | --- |
| `$host` / `${host}` | `www.ttpai.cn,m.ttpai.cn`（CSV，Grafana 默认） |
| `${host:csv}` | `www.ttpai.cn,m.ttpai.cn` |
| `${host:doublequote}` | `"www.ttpai.cn","m.ttpai.cn"` |
| `${host:singlequote}` | `'www.ttpai.cn','m.ttpai.cn'` |
| `${host:json}` | `["www.ttpai.cn","m.ttpai.cn"]` |
| `${host:raw}` | `www.ttpai.cn,m.ttpai.cn` |
| `${host:pipe}` | `www.ttpai.cn\|m.ttpai.cn` |
| `${host:percent}` | 逐值 URL 编码后逗号连接（`www.ttpai.cn,m.ttpai.cn`；`["a b"]` → `a%20b`） |
| `${host:querystring}` | `host=www.ttpai.cn&host=m.ttpai.cn`（以变量名为键） |
| `${host:regex}` | `www\.ttpai\.cn\|m\.ttpai\.cn`（逐值正则转义后以 `\|` 连接） |
| `${host:lucene}` | 逐值 Lucene 转义后以空格连接 |
| `${host:sqlstring}` | `'www.ttpai.cn','m.ttpai.cn'`（值内单引号翻倍） |

无修饰符的单值变量展开为裸值（与 `String(value)` 逐字节一致）；修饰符对单值同样生效（`${host:json}` → `"www.ttpai.cn"`，`${host:pipe}` → `www.ttpai.cn`）。未知格式修饰符显式报错。内建变量（`$__interval`、`$__rate_interval`、`${__from:date}` 等）始终原样透传。

adhoc 过滤覆盖——整体替换大盘保存的 adhoc filters（`[]` 表示清空）：

```json
{
  "adhoc": [
    { "key": "host.keyword", "operator": "=", "value": "www.ttpai.cn" },
    { "key": "status", "operator": "!=", "value": "404" }
  ]
}
```

未绑定的 adhoc 条目对所有数据源生效；加 `"datasourceUid": "<uid>"` 可绑定到单个数据源。翻译方式取决于数据源类型：

| 数据源类型 | 翻译方式 | 支持的运算符 |
| --- | --- | --- |
| Elasticsearch | Lucene 条件拼进各 target 的查询串（`host.keyword:"www.ttpai.cn"`；面板自带查询串非空时括号包裹后以 `AND` 连接） | `=` `!=` 恒可；`>` `<` 仅数字；`=~` `!~` 映射为 Lucene 正则 `field:/pattern/`（模式内的 `/` 会转义；空模式报错） |
| Prometheus | label matcher 注入每个 vector selector（`host="www.ttpai.cn"`；裸 metric 名补上 `{...}`） | `=` `!=` `=~` `!~`；`>` `<` 报错 |
| Loki | matcher 注入 stream selector（`{app="api", host="www.ttpai.cn"}`）；pipeline 阶段不动 | `=` `!=` `=~` `!~`；`>` `<` 报错 |
| SQL（MySQL/Postgres/MSSQL/MariaDB/SQLite/ClickHouse） | `rawSql` 中的 `${__adhoc}` / `$__adhoc` 占位符替换为 WHERE 风格条件（`host = 'www.ttpai.cn'`；值做单引号转义） | `=` `!=` `>` `<`（数字）、`=~` `!~`（映射为 `LIKE`/`NOT LIKE`） |
| 其它类型 | 显式报错并列出支持类型 | — |

datasource 型变量——用数据源 uid 字符串覆盖：

```json
{ "datasource": "prom-prod" }
```

datasource 引用了该变量的面板（`{"type":"prometheus","uid":"$datasource"}`）会改查指定的 uid。传入非字符串值（数字、数组）会显式报错。

### 旧格式 datasource 引用（`grafana_query`）

旧版大盘的 datasource 引用形状无法直接用于 `/api/ds/query`，`grafana_query` 会透明解析：

| 面板 datasource 形状 | 解析方式 |
| --- | --- |
| 纯字符串 uid（Grafana 8 及更早） | 经 `GET /api/datasources` 查找，随查询发送解析出的 `{type, uid}` |
| `{"uid":"$datasource"}` / `{"type":"prometheus","uid":"$datasource"}`（datasource 型模板变量） | 用该变量保存的 `current` 值插值进 uid |
| 保存值为 `"default"` | 映射到服务端默认数据源（`"default"` 是 `/api/ds/query` 不接受的保留伪 uid） |
| 索引不可用（403）或 uid 未知 | 裸 `{uid}` 透传，由 Grafana 自行报错；若此时还有生效的 adhoc 过滤无法对未知类型翻译，则显式报错 |

数据源索引按需懒加载——仅当大盘确实存在需要解析的引用时才请求一次。当所有面板都被跳过时，报错会列出每个面板的 id、标题与跳过原因，而不是一句干巴巴的 "no executable query"。

真机验收矩阵（变量覆盖 × 运算符 × 数据源类型、旧格式大盘形状）记录于 [INTEGRATION.md](INTEGRATION.md)。

### 安全写回流程

1. 让 DSH 获取大盘 URL 或 UID。
2. 描述需要修改的内容。
3. 检查审批窗口中的大盘身份和变更摘要。
4. 批准或拒绝写回。
5. 刷新 Grafana；再次写入前重新获取大盘。

`grafana_push` 默认使用 `overwrite: false`。写回前会立即重新读取大盘并拒绝过期版本，同时自动保持当前目录。移动目录需要 `allowFolderMove: true`；强制覆盖需要 `forceOverwrite: true`，且仍会触发审批。

审批弹窗中展示的大盘身份（UID、标题、版本、所在文件夹）以及「快照于 X 分钟前获取」全部来自 `grafana_get` 保存的服务端可信快照，而不是模型提交的大盘 JSON，因此模型幻觉或被篡改的标题不会误导审批。没有可信快照时，弹窗会直接说明写回会被拒绝并要求先 `grafana_get`。审批弹出前插件还会实时核对 Grafana 端当前状态：版本或文件夹与快照不一致时，弹窗会给出醒目警示并列出两侧版本号；无法连接 Grafana 时，弹窗会注明「无法确认当前状态」。实时复核只用于丰富审批文案，写入前的最终校验始终在写回时重新执行。实时复核成功时，弹窗还会附上有界且经过清洗的内容 diff（新增/删除/修改的面板、模板变量与顶层字段），让审批人核对真实改动，而不只是模型自述的变更摘要。

## 安全与数据边界

- Token 不会进入工具参数、模型消息、日志或 Git。
- 带凭证的请求拒绝 HTTP 重定向，避免凭证被转发到其他来源。
- 默认禁止非本机明文 HTTP。
- 请求支持取消、超时、响应大小限制和 Dashboard 输入大小限制。
- API 错误只暴露有限的状态和消息。
- Grafana 返回内容始终作为不可信数据处理，而不是模型指令。

Dashboard JSON 仍可能包含 SQL、内部域名、链接、标签和业务信息。获取大盘会把这些 JSON 作为工具上下文发送给当前模型提供商。在处理机密大盘前，请先确认模型提供商的数据政策。

漏洞报告和支持策略参见 [SECURITY.md](./SECURITY.md)。

## 开发验证

```bash
npm ci
npm run verify
npm pack --dry-run --ignore-scripts
```

自动化测试使用 Node 内置测试运行器和模拟 Grafana 响应。CI 覆盖 Node 20、22 和 24。

更多信息参见 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [CHANGELOG.md](./CHANGELOG.md)。

## 发布

普通手工 `git push` 不会触发版本号、tag 或 Release。发布是一个显式的三步流程，要求 `main` 工作区干净且变更已提交：

```bash
./deploy.sh release   # 锁版本：递增版本、提交、打 tag、推送（patch/minor/major 或 x.y.z）
./deploy.sh build     # 验证并打包，产物输出到 dist/
./deploy.sh publish   # 先将安装包发布到 npm，再创建 GitHub Release 并上传同一产物
```

直接运行 `./deploy.sh`（不带参数）可查看内置帮助。首次发布前需要运行一次 `gh auth login` 和 `npm login`。每一步都有自我守卫：`all` 与 `release` 在开始前会先预检 GitHub 与 npm 登录状态（避免版本锁定、tag 推送之后才发现凭证失效白跑一遍），`release` 要求 `main` 干净且与远端同步，`build` 要求 tag 已锁定在 `HEAD` 上，`publish` 要求打包产物存在且 GitHub 与 npm 凭证就绪；所有会改动远端的操作都会先要求明确确认。

`publish` 会先把 `dist/` 里的安装包发布到 npm，再把同一个文件上传到 GitHub Release，两个渠道分发的产物字节完全一致。npm 版本号不可变：如果 `dsh-grafana@<version>` 已在 npm 上存在，则跳过 npm 步骤、只创建 GitHub Release；脚本也绝不会覆盖已存在的 GitHub Release。

### npm 前置条件

首次 npm 发布前的一次性准备：

1. 使用已验证邮箱、并为写操作开启双因素认证的 npmjs.com 账号。
2. 执行 `npm login`，再用 `npm whoami` 确认身份。
3. 无作用域名称 `dsh-grafana` 已由包所有者账号占用。如需改用 `@guhanfei-ai/dsh-grafana` 这类组织作用域名称，请先修改 `package.json`；`deploy.sh` 会从其中读取包名。

开启写操作 2FA 后，`npm publish` 会交互式提示输入一次性验证码；非交互场景可通过 `NPM_OTP` 环境变量传入。

如需供应链来源证明，建议改用独立 CI 工作流配置 npm Trusted Publishing 并加 `--provenance`；本地登录不具备可信来源证明所需的 CI OIDC 身份。

## 许可证

[MIT](./LICENSE)
