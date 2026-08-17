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

## 配置（全部在 Web 界面完成）

安装并重启后，打开 DSH Web 的 **设置 → 插件** 页，找到 **Grafana 大盘编辑** 卡片：

| 字段 | 说明 |
| --- | --- |
| Service Account Token | 粘贴 `glsa_...` 后点保存；写入本机凭证库（`~/.dsh/.credentials.yaml`，600 权限），界面只显示 已配置/未配置，永不回显明文 |
| Grafana 地址 | 留空使用默认 `http://grafana.example.com`；填写后同样写入本机凭证库（`GRAFANA_BASE_URL`），保存即生效 |

前提：在 Grafana 中创建 **Service Account**（Editor 权限）并生成 token。

### 高级：CLI / 文件方式（等价）

```bash
echo 'GRAFANA_TOKEN: glsa_xxxxxxxx' >> ~/.dsh/.credentials.yaml
chmod 600 ~/.dsh/.credentials.yaml
```

也可以覆盖插件配置（`baseUrl` / `tokenRef`）。token 永远不进聊天、不进 git。

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
