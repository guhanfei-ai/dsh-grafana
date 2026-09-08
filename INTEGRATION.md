# Integration verification matrix

人工真机验收记录。环境：Grafana 10.4.5（`grafana.example.com`），service account 凭证。
所有结果均为真机实测输出，非推断。面板数值为 `avg`（面板 7「RPM」）或总量，时间窗 `now-1h..now`，数据随时间自然波动。
第一至五节针对 `grafana_panel_query` 与多源站；第七节覆盖 0.12.0 新增的四个只读观测工具。

## 一、变量覆盖 × adhoc 运算符（大盘 `fixture-dash-0001`，Elasticsearch，adhoc 变量名 `Filters`）

| # | 场景 | 输入 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 假值归零 | `Filters: [{host.keyword = bogus.example.com}]` | 全 0 | avg=0 | ✅ |
| 2 | `!=` 精确排除 | `Filters: [{host.keyword = www}, {host.keyword != m}]` | ≈ www 单独值，≪ 全量 | avg=5506（全量 36440） | ✅ |
| 3 | 多条件 AND | 同上（两条 filter） | 条件按 AND 合并 | 同上，成立 | ✅ |
| 4 | `[]` 清空 | `Filters: []` | = 全量（无过滤） | avg=36440 | ✅ |
| 5 | 数值 `>` | `Filters: [{date > "1"}]`（epoch 数值字段） | = 全量 | avg=35820（≈全量） | ✅ |
| 6 | 关键字字段 `>` 非数字 | `Filters: [{date > "abc"}]` | 显式报错 | `range comparison only supports numeric values` | ✅ |
| 7 | 第二 ES 数据源 | adhoc 绑定另一 ES 数据源 uid | 同样翻译为 Lucene | 单测覆盖 + 真机通过（第四轮） | ✅ |
| 8 | 变量不存在 | `{nonexistent_var: "x"}` | 显式报错，列出可用变量 | `Variable "nonexistent_var" does not exist... Available variables: Filters` | ✅ |
| 9 | 全盘无 500 | 整盘查询（10 面板 10 查询） | 无服务端错误 | 失败查询数 0 | ✅ |
| 10 | 默认态 = 保存态 | 不传 `variables` | 与大盘保存的过滤一致 | 面板 7 呈保存态（www）数据 | ✅ |

## 二、ES 正则运算符 `=~` / `!~`（大盘 `fixture-dash-0001`，字段 `host.keyword`）

| 场景 | 输入 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| 正匹配 | `{host.keyword =~ www.example.com\|m.example.com}` | ≈ www+m 之和 | avg=7000 | ✅ |
| 负匹配 | `{host.keyword !~ www.example.com\|m.example.com}` | = 全量 − (www+m) | avg=29480 | ✅ |
| 互补性 | 上两项之和 | = 全量 | 7000+29480=36480 ≈ 36440 | ✅ |
| 假模式 | `{host.keyword =~ bogus.*}` | 全 0 | avg=0 | ✅ |
| 空模式 | `{host.keyword =~ "  "}` | 显式报错 | `regex pattern is empty` | ✅ |
| 缺失字段 | `{path =~ .*}` | Lucene 语义：缺失字段不匹配 | avg=0（该索引无 path 文档字段，非 bug） | ✅ |

翻译形式：`key:/pattern/`，模式内 `/` 转义为 `\/`；`!~` 渲染为 `NOT key:/pattern/`。lucene 正则不支持 `\d` 简写、为隐式全串匹配，语法错误由 ES 显式报错。

## 三、旧格式 datasource 引用（本轮新增）

### 大盘 `fixture-dash-0002`（Node Exporter，面板 datasource 为纯字符串 uid，Grafana 8 旧格式）

| 场景 | 输入 | 实测 | 结论 |
| --- | --- | --- | --- |
| 默认态 | 不传 `variables` | 清晰报错：列出未解析的模板变量与受影响面板（不再是无解释的 "no executable query"） | ✅ |
| job 单值覆盖 | `{job: "node-exporter"}` | 服务器资源总览表返回真实数据 | ✅ |
| job+node 多值覆盖 | `{job: [...], node: [...]}` | 42 个 instance 序列，两个 job 的实例都返回 | ✅ |

### 大盘 `fixture-dash-0003`（Alertmanager，面板 datasource 引用 `$datasource` 模板变量）

| 场景 | 输入 | 实测 | 结论 |
| --- | --- | --- | --- |
| 默认态 | 不传 `variables` | 面板 4/26 返回真实数据（datasource 变量保存值经 `GET /api/datasources` 解析）；面板 36 空 target 有明确 400 + 逐面板降级 | ✅ |
| instance 单值覆盖 | `{instance: "192.0.2.233:9093"}` | 4 数据行 | ✅ |
| instance 多值覆盖 | `{instance: ["192.0.2.233:9093","198.51.100.4:9093"]}` | `instance=~"(192.0.2.233:9093\|198.51.100.4:9093)"`，返回真实实例数据 | ✅ |
| datasource 覆盖（健康数据源） | `{datasource: "fixture-ds-a…"}`（默认 Prometheus-Prod） | 查询改发该数据源并返回数据 | ✅ |
| datasource 覆盖（坏数据源） | `{datasource: "fixture-ds-broken"}` | 正确透传服务端错误 `parse "": empty url`（该数据源服务端 url 配置为空，直接 curl 同错，非本插件 bug） | ✅ |

注意：多值渲染为 `(a|b)` 时值不转义——PromQL 双引号字符串里 `\.` 是非法转义（`unknown escape sequence`），Grafana 自身渲染多值 matcher 也不转义。需要精确匹配用显式 `${var:regex}`。

## 四、五条回归底线

| 底线 | 实测 | 结论 |
| --- | --- | --- |
| 假值归零 | 见一/二 | ✅ |
| www ≠ m ≪ 全量 | 见一 #2 | ✅ |
| 默认态 = 保存态 | 见一 #10 | ✅ |
| 表达式面板无 500 | 面板 8（`$A/60` 表达式）全盘查询成功 | ✅ |
| 错误输入清晰报错 | 见一 #6/#8、二空模式 | ✅ |

## 五、单元测试

`npm run verify` → 全绿（测试总数随版本增长，此处不写死计数）。含 `grafana_panel_query` 历轮新增（legacy 字符串 uid 索引解析、`$datasource` 解析与 “default” 映射、索引 403 透传、透传+adhoc 报错、promql/loki 裸多值 `(a|b)` 渲染含带点号值、ES 正则成功路径与空模式报错），以及本轮多源站新增：

- Host：`grafana_sources` 列表输出（名称/UID/URL/令牌状态/默认标记）、`source` 按名称与按 id 解析、省略走默认源站、多源无默认时报错、写快照按 (源站, uid) 复合键跨源站隔离、push/clone 审批文案首行标明目标源站、配置写入口校验（源站 id 只读形状 `SOURCE_ID_PATTERN` 强制、重名拒绝）、legacy 单源配置启动迁移为 `default` 源站（沿用 `GRAFANA_TOKEN`、生成只读 UID）。
- 客户端：源站列表读回与各源站令牌 configured 状态、整体写入的 `mutate unset ['sources']` + `update {sources,defaultSource}` 形状锁定、令牌按各自 ref 增删、移除源站联动 unset 其令牌、UID 生成（crypto.randomUUID 形状、唯一）与只读、名称必填/唯一/限长与数量上限 50 前置校验、URL 合法性校验、双代信封解析回退。

## 六、多源站真机验证清单（待维护者实测）

> 本轮多源站改动已通过全部单元测试（见五），但**真机验证需维护者重启 dsh web profile 并刷新浏览器后自行完成**（插件无热重载；代理不启停服务，也不臆造真机结果）。下表为建议核对项，实测后把 ⬜ 改为 ✅ 并补上观察到的输出。

| # | 场景 | 操作 | 期望 | 实测 |
| --- | --- | --- | --- | --- |
| 1 | 迁移 | 升级前已配单源（URL+令牌）→ 升级重启 | 设置卡片出现一个名为 `default` 的源站，URL/令牌沿用，名称下方有只读 UID | ⬜ |
| 2 | 新增源站 | 卡片里点“新增源站”，填名称/URL/令牌，保存 | 列表新增一项，UID 自动生成且不可编辑，刷新后仍在 | ⬜ |
| 3 | 名称校验 | 两个源站同名 / 名称留空，保存 | 本地化报错，不写入（无半保存） | ⬜ |
| 4 | 按名称选源 | 对话中对某工具传 `source: "<名称>"` | 请求发往该源站 URL（可用 `grafana_status` 验证） | ⬜ |
| 5 | 默认源站 | 省略 `source` | 命中“设为默认”的源站 | ⬜ |
| 6 | `grafana_sources` | 对话中调用 | 列出全部源站名称/UID/URL/令牌状态/默认标记，不泄露令牌 | ⬜ |
| 7 | 跨源站快照隔离 | 两台源站取同一 uid 大盘后分别写回 | 审批文案各自显示本源站标题与目标源站行，互不串号 | ⬜ |
| 8 | 移除源站 | 移除一个已配令牌的源站并保存 | 该源站与其令牌凭证一并清除 | ⬜ |

## 七、0.12.0 观测工具真机验证清单（待维护者实测）

> 四个新工具（`grafana_datasources` / `grafana_metric` / `grafana_trend` / `grafana_alerts`）均为只读，不记录写快照。单测已覆盖（见五），以下为真机核对项。代理不启停服务、不臆造真机结果；实测后把 ⬜ 改为 ✅ 并补观察到的输出与 Grafana 版本。

| # | 工具 | 操作 | 期望 | 实测 |
| --- | --- | --- | --- | --- |
| 1 | `grafana_datasources` | 不传参数调用 | 列出源站全部数据源（uid/类型/名称/默认/访问模式），与 Grafana UI → Connections → Data sources 一致 | ⬜ |
| 2 | `grafana_datasources` | `type: "prometheus"` 或 `nameContains` 子串 | 只返回匹配项；超 40 行时末尾出 `budget:` 行 | ⬜ |
| 3 | `grafana_metric` | `datasource` 传**名称**，`expr: "up"`，instant | 名称被解析为 uid；每条序列一行 scalar 值 | ⬜ |
| 4 | `grafana_metric` | `mode: "range"`，`points: 24` | 每条序列含 buckets/first/last/min/max/avg/trend/spark | ⬜ |
| 5 | `grafana_metric` | 对 mysql 类型数据源调用 | 显式报错并指向 `grafana_panel_query` | ⬜ |
| 6 | `grafana_trend` | 大盘 URL（含 `now-3h`） | 每面板每序列一行趋势判定 + 火花线；表达式面板不带采样键 | ⬜ |
| 7 | `grafana_trend` | 超 90 天的 `from`/`to` | 显式报错（区间上限） | ⬜ |
| 8 | `grafana_alerts` | 默认调用 | 只报 firing 告警；与 Grafana UI → Alerting 当前列表一致 | ⬜ |
| 9 | `grafana_alerts` | 人为静默一条后 `state: "suppressed"` | 该告警归入 suppressed 并标 `silencedBy` | ⬜ |
| 10 | `grafana_alerts` | `dashboard: "<uid>"` | 只返回引用该大盘的告警；无引用时明说而非返回全部 | ⬜ |
| 11 | `grafana_alerts` | `definitions: true`（令牌无 `alert.provisioning:read`） | 活跃告警段正常，规则段单独报缺失权限，不互相拖垮 | ⬜ |
| 12 | 权限诊断 | 用缺 `datasources:read` 的令牌调 `grafana_datasources` | 403 文案指名源站与 `datasources:read` | ⬜ |
