# dsh-grafana

[English](./README.md)

一个用于通过对话读取、编辑并安全写回 Grafana 大盘的 DeepSeek Harness 插件。插件直接操作 Dashboard JSON，不需要截图。

> 项目状态：1.0 前版本。核心写回路径已经具备安全保护和自动化测试，但尚未完成 Grafana 12+ 兼容性认证。

## 核心能力

- 通过浏览器 URL 或 UID 获取大盘。
- 按标题和标签搜索大盘。
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

Windows 可使用 `link:C:/path/to/dsh-grafana` 形式的绝对路径。插件运行本身支持跨平台；`publish.sh` 需要 Git Bash、WSL、macOS 或 Linux。

## 配置

在 DSH Web 中打开 **设置 → 插件 → Grafana dashboard editor**。

需要配置：

- **Service Account Token**：例如 `glsa_...`。
- **Grafana URL**：例如 `https://grafana.example.com` 或 `https://example.com/grafana`。

两项配置都使用 DSH 仅允许 loopback same-origin 访问的特权凭证 RPC。保存后的值不会被读取或回显，界面支持替换和删除。

默认情况下，非本机地址必须使用 HTTPS。如确实需要访问内网 HTTP，可在插件配置中显式启用：

```yaml
baseUrl: http://grafana.internal:3000
allowInsecureHttp: true
```

`GRAFANA_BASE_URL` 凭证优先于 `baseUrl`。Token 凭证名默认为 `GRAFANA_TOKEN`，可通过 `tokenRef` 修改。

### Grafana 权限

优先使用最小权限 RBAC，只授予目标大盘及文件夹所需范围：

- `dashboards:read`
- `dashboards:write`
- 目标文件夹的 `folders:read`

不支持细粒度 RBAC 时才使用 Editor 角色，避免使用 Admin token。

## 工具

| 工具 | 行为 |
| --- | --- |
| `grafana_get` | 获取完整大盘，并保存一个短期可信的版本和目录快照。 |
| `grafana_push` | 在审批、身份校验、版本校验和目录保持后写回最近读取的大盘。 |
| `grafana_search` | 按标题和精确标签搜索，最多返回 50 条。 |
| `grafana_health` | 检查 Grafana 连通性与 Service Account 凭证。 |

### 安全写回流程

1. 让 DSH 获取大盘 URL 或 UID。
2. 描述需要修改的内容。
3. 检查审批窗口中的大盘身份和变更摘要。
4. 批准或拒绝写回。
5. 刷新 Grafana；再次写入前重新获取大盘。

`grafana_push` 默认使用 `overwrite: false`。写回前会立即重新读取大盘并拒绝过期版本，同时自动保持当前目录。移动目录需要 `allowFolderMove: true`；强制覆盖需要 `forceOverwrite: true`，且仍会触发审批。

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

普通手工 `git push` 不会触发版本号、tag 或 Release。只有主动运行发布脚本才会进入发布流程：

```bash
bash ./publish.sh patch
# 也可以使用 minor 或 major
```

首次发布前需要运行一次 `gh auth login`。脚本要求 `main` 工作区干净且变更已经提交。它会验证代码、递增版本、创建 release commit 与 tag、原子推送并生成 GitHub Release notes；修改 Git 历史和远端前会再次要求明确确认。

在 npm 所有者账号和包名配置完成前，脚本不会执行 npm 发布。

### 稍后占用 npm 包名

npm 没有独立的“占位”操作，第一次成功发布就会占用包名。准备好后：

1. 在 npmjs.com 注册账号、验证邮箱，并为写操作开启双因素认证。
2. 执行 `npm login`，再用 `npm whoami` 确认身份。
3. 用 `npm view dsh-grafana` 再次检查；返回 `404` 表示名字仍未被占用。
4. 在当前无作用域名称 `dsh-grafana` 与 `@guhanfei-ai/dsh-grafana` 这类 npm 组织作用域名称之间做选择；作用域名称需要先修改 `package.json`。
5. 在不可变的 release commit 上执行 `npm publish --access public`。

如果需要供应链来源证明，应先通过独立 CI 工作流配置 npm Trusted Publishing，再在该工作流中加入 `--provenance`。本地用户名/密码或 2FA 登录不具备可信来源证明所需的 CI OIDC 身份。在这套配置完成前，`publish.sh` 仍明确不包含 npm 发布动作。

不建议发布空壳占位包，应直接发布已经验证过的插件版本，让包名从第一天起就有可审计的有效内容。

## 许可证

[MIT](./LICENSE)
