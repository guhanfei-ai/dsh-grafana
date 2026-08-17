# dsh-grafana

DeepSeek Harness 插件：贴一个 Grafana 大盘地址，AI 直接拉取大盘 JSON、按对话微调、写回 Grafana。**无需截图**——大盘 JSON 是唯一真相源。

## 工作流

1. 用户把大盘 URL 粘给 AI（如 `http://grafana.example.com/d/<uid>/<slug>?orgId=1`）或直接给 UID
2. AI 调用 `grafana_get` 拉取 dashboard JSON（含 meta）
3. AI 按用户要求修改 panels / targets / 阈值 / 布局 / 变量等 JSON 字段
4. AI 调用 `grafana_push` 写回（默认 overwrite 覆盖原盘；folderUid 用 meta 提供的值可保持文件夹位置）
5. 用户刷新 Grafana 页面查看效果，不满意继续对话微调

## 安装

```bash
# 从 GitHub 安装
dsh plugin --profile <profile> add github:guhanfei-ai/dsh-grafana

# 本地开发
dsh plugin --profile <profile> add link:/path/to/dsh-grafana
```

> 注意：link 安装后需要在本插件目录执行一次 `npm install`，确保依赖在插件目录内可解析。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://grafana.example.com` | Grafana 根地址 |
| `tokenRef` | `GRAFANA_TOKEN` | 凭证引用名，对应 `~/.dsh/.credentials.yaml` 中的键 |

可在 DSH Web 设置界面（插件页）或 profile 的 `cordis.patch.yml` 中覆盖。

## 凭证配置

1. 在 Grafana 中创建 **Service Account**（Editor 权限）并生成 token（`glsa_...`）
2. 把 token 写入本机凭证文件（权限 600，仅本机用户可读）：

```bash
echo 'GRAFANA_TOKEN: glsa_xxxxxxxx' >> ~/.dsh/.credentials.yaml
chmod 600 ~/.dsh/.credentials.yaml
```

3. 聊天记录、插件配置、日志中永远只出现引用名 `GRAFANA_TOKEN`，不出现 token 明文

## 工具

| 工具 | 作用 |
| --- | --- |
| `grafana_get` | 按浏览器 URL 或 UID 拉取大盘完整 JSON（含 meta 与 dashboard） |
| `grafana_push` | 把修改后的 dashboard JSON 写回 Grafana（POST /api/dashboards/db） |
| `grafana_search` | 按标题关键词搜索大盘，返回 uid/title/url |
| `grafana_health` | 检查 Grafana 连通性与凭证可用性 |

## 安全原则

- 写回前向用户复述改动摘要（改了哪些面板/查询）
- 对生产大盘的大改动先征得用户同意
- token 不进入聊天、不进入 git
