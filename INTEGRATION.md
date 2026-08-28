# Integration verification matrix (`grafana_query`)

人工真机验收记录。环境：Grafana 10.4.5（`grafana.ttpai.work`），service account 凭证。
所有结果均为真机实测输出，非推断。面板数值为 `avg`（面板 7「RPM」）或总量，时间窗 `now-1h..now`，数据随时间自然波动。

## 一、变量覆盖 × adhoc 运算符（大盘 `afmepuvbou03ke`，Elasticsearch，adhoc 变量名 `Filters`）

| # | 场景 | 输入 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 假值归零 | `Filters: [{host.keyword = bogus.ttpai.cn}]` | 全 0 | avg=0 | ✅ |
| 2 | `!=` 精确排除 | `Filters: [{host.keyword = www}, {host.keyword != m}]` | ≈ www 单独值，≪ 全量 | avg=5506（全量 36440） | ✅ |
| 3 | 多条件 AND | 同上（两条 filter） | 条件按 AND 合并 | 同上，成立 | ✅ |
| 4 | `[]` 清空 | `Filters: []` | = 全量（无过滤） | avg=36440 | ✅ |
| 5 | 数值 `>` | `Filters: [{date > "1"}]`（epoch 数值字段） | = 全量 | avg=35820（≈全量） | ✅ |
| 6 | 关键字字段 `>` 非数字 | `Filters: [{date > "abc"}]` | 显式报错 | `range comparison only supports numeric values` | ✅ |
| 7 | 第二 ES 数据源 | adhoc 绑定另一 ES 数据源 uid | 同样翻译为 Lucene | 单测覆盖 + 真机通过（第四轮） | ✅ |
| 8 | 变量不存在 | `{nonexistent_var: "x"}` | 显式报错，列出可用变量 | `Variable "nonexistent_var" does not exist... Available variables: Filters` | ✅ |
| 9 | 全盘无 500 | 整盘查询（10 面板 10 查询） | 无服务端错误 | 失败查询数 0 | ✅ |
| 10 | 默认态 = 保存态 | 不传 `variables` | 与大盘保存的过滤一致 | 面板 7 呈保存态（www）数据 | ✅ |

## 二、ES 正则运算符 `=~` / `!~`（大盘 `afmepuvbou03ke`，字段 `host.keyword`）

| 场景 | 输入 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| 正匹配 | `{host.keyword =~ www.ttpai.cn\|m.ttpai.cn}` | ≈ www+m 之和 | avg=7000 | ✅ |
| 负匹配 | `{host.keyword !~ www.ttpai.cn\|m.ttpai.cn}` | = 全量 − (www+m) | avg=29480 | ✅ |
| 互补性 | 上两项之和 | = 全量 | 7000+29480=36480 ≈ 36440 | ✅ |
| 假模式 | `{host.keyword =~ bogus.*}` | 全 0 | avg=0 | ✅ |
| 空模式 | `{host.keyword =~ "  "}` | 显式报错 | `regex pattern is empty` | ✅ |
| 缺失字段 | `{path =~ .*}` | Lucene 语义：缺失字段不匹配 | avg=0（该索引无 path 文档字段，非 bug） | ✅ |

翻译形式：`key:/pattern/`，模式内 `/` 转义为 `\/`；`!~` 渲染为 `NOT key:/pattern/`。lucene 正则不支持 `\d` 简写、为隐式全串匹配，语法错误由 ES 显式报错。

## 三、旧格式 datasource 引用（本轮新增）

### 大盘 `9CWBz0bik`（Node Exporter，面板 datasource 为纯字符串 uid，Grafana 8 旧格式）

| 场景 | 输入 | 实测 | 结论 |
| --- | --- | --- | --- |
| 默认态 | 不传 `variables` | 清晰报错：列出未解析的模板变量与受影响面板（不再是无解释的 "no executable query"） | ✅ |
| job 单值覆盖 | `{job: "node-exporter"}` | 服务器资源总览表返回真实数据 | ✅ |
| job+node 多值覆盖 | `{job: [...], node: [...]}` | 42 个 instance 序列，两个 job 的实例都返回 | ✅ |

### 大盘 `eea-9_sik`（Alertmanager，面板 datasource 引用 `$datasource` 模板变量）

| 场景 | 输入 | 实测 | 结论 |
| --- | --- | --- | --- |
| 默认态 | 不传 `variables` | 面板 4/26 返回真实数据（datasource 变量保存值经 `GET /api/datasources` 解析）；面板 36 空 target 有明确 400 + 逐面板降级 | ✅ |
| instance 单值覆盖 | `{instance: "10.29.249.233:9093"}` | 4 数据行 | ✅ |
| instance 多值覆盖 | `{instance: ["10.29.249.233:9093","1.2.3.4:9093"]}` | `instance=~"(10.29.249.233:9093\|1.2.3.4:9093)"`，返回真实实例数据 | ✅ |
| datasource 覆盖（健康数据源） | `{datasource: "af6e5b5a-…"}`（默认 Prometheus-Prod） | 查询改发该数据源并返回数据 | ✅ |
| datasource 覆盖（坏数据源） | `{datasource: "bfg9l689pd9tsc"}` | 正确透传服务端错误 `parse "": empty url`（该数据源服务端 url 配置为空，直接 curl 同错，非本插件 bug） | ✅ |

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

`npm run verify` → 56/56（含本轮新增：legacy 字符串 uid 索引解析、`$datasource` 解析与 "default" 映射、索引 403 透传、透传+adhoc 报错、promql/loki 裸多值 `(a|b)` 渲染含带点号值、ES 正则成功路径与空模式报错）。
