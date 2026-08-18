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

Windows 可使用 `link:C:/path/to/dsh-grafana` 形式的绝对路径。插件运行本身支持跨平台；`deploy.sh` 需要 Git Bash、WSL、macOS 或 Linux。

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

普通手工 `git push` 不会触发版本号、tag 或 Release。发布是一个显式的三步流程，要求 `main` 工作区干净且变更已提交：

```bash
./deploy.sh release   # 锁版本：递增版本、提交、打 tag、推送（patch/minor/major 或 x.y.z）
./deploy.sh build     # 验证并打包，产物输出到 dist/
./deploy.sh publish   # 先将安装包发布到 npm，再创建 GitHub Release 并上传同一产物
```

直接运行 `./deploy.sh`（不带参数）可查看内置帮助。首次发布前需要运行一次 `gh auth login` 和 `npm login`。每一步都有自我守卫：`release` 要求 `main` 干净且与远端同步，`build` 要求 tag 已锁定在 `HEAD` 上，`publish` 要求打包产物存在且 GitHub 与 npm 凭证就绪；所有会改动远端的操作都会先要求明确确认。

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
