// dsh-grafana 浏览器设置卡片（多源站）。
// 每个源站：名称（必填、唯一）→ 只读 UID（自动生成、全球唯一、不可改）→ URL → 令牌。
// 令牌走 DSH 凭证库的 loopback same-origin RPC：仅写不读，describe 只返回 configured
// 布尔，客户端永远不会读回明文，故以星号占位。各源站令牌 ref = GRAFANA_TOKEN_<去横线的
// id>（迁移来的默认源站保留旧 ref GRAFANA_TOKEN）。名称/URL/默认源站存 settings
// namespace（grafana）的 sources 数组 + defaultSource（非 secret，describe 返回明文，可回显）。
window.__ModuleLoader__.load({
	id: "dsh-grafana",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const h = react_jsx_runtime.jsx;
		const hs = react_jsx_runtime.jsxs;

		const SETTINGS_NS = "grafana";
		const TOKEN_REF_PREFIX = "GRAFANA_TOKEN_";
		// 与 Host 端 lib/constants.js 的 MAX_SOURCE_NAME_CHARS / MAX_SOURCES 保持一致。
		const MAX_SOURCE_NAME_CHARS = 100;
		const MAX_SOURCES = 50;
		// 仅用于视觉提示的占位符，永远不会写入凭证库。
		const MASK = "*".repeat(28);

		// 只 inject slots。远端门面（remote.settings / remote.credentials）刻意不写进 inject：
		// cordis 4.0.2 里 inject 名单上任一缺席的服务都会让 fiber 永远停在 INACTIVE，插件根本
		// 不加载，卡片会整块从设置页消失——那比降级提示更糟。运行期用 ctx.get 延迟解析即可。
		const inject = ["slots"];

		// 宿主缺少远端门面时抛出的稳定错误码（卡片据此显示本地化升级提示）。
		const HOST_UNSUPPORTED = "HOST_UNSUPPORTED";

		// 以下三个辅助函数与 lib/util.js 同源实现（浏览器 bundle 不能 import 服务端模块，
		// 故内联；输出必须与 Host 端逐字一致，否则令牌 ref 与 Host 解析对不上）。
		// 源站 id：全球唯一、系统生成、只读。优先 crypto.randomUUID，退化到 getRandomValues
		// 拼装 v4 UUID，再退化到时间+随机串（仍足够唯一）。
		function generateSourceId() {
			const c = globalThis.crypto;
			if (c && typeof c.randomUUID === "function") return String(c.randomUUID());
			if (c && typeof c.getRandomValues === "function") {
				const bytes = c.getRandomValues(new Uint8Array(16));
				bytes[6] = (bytes[6] & 0x0f) | 0x40;
				bytes[8] = (bytes[8] & 0x3f) | 0x80;
				const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
				return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
			}
			return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		}

		// 由源站 id 派生令牌凭证 ref：剥离横线等非法字符后加固定前缀（保证以字母开头，
		// 满足 Host 的 CREDENTIAL_REF_PATTERN）。同一 id 恒定映射到同一 ref，改名不影响令牌。
		function tokenRefForId(id) {
			const clean = String(id ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
			return `${TOKEN_REF_PREFIX}${clean}`;
		}

		// 规整 describe 读回的单个源站：无 id 的条目无法管理（丢弃），tokenRef 缺省按 id 派生。
		function normalizeSource(raw) {
			if (!raw || typeof raw !== "object") return null;
			const id = typeof raw.id === "string" && raw.id ? raw.id : "";
			if (!id) return null;
			const name = typeof raw.name === "string" ? raw.name : "";
			const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : "";
			const tokenRef = typeof raw.tokenRef === "string" && raw.tokenRef ? raw.tokenRef : tokenRefForId(id);
			return { id, name, baseUrl, tokenRef };
		}

		// 保存前统一校验：数量受限（与 Host MAX_SOURCES 一致）、名称必填、限长、唯一
		// （trim 后精确匹配、大小写敏感），URL 合法（沿用 new URL 校验：绝对 HTTP(S)、
		// 无凭证/查询/片段）。全部通过再写入，避免半保存。
		function validateSources(sources, m) {
			if (sources.length > MAX_SOURCES) throw new Error(m.tooManySources);
			const seen = new Set();
			for (const s of sources) {
				const name = String(s.name ?? "").trim();
				if (!name) throw new Error(m.nameRequired);
				if (name.length > MAX_SOURCE_NAME_CHARS) throw new Error(m.nameTooLong);
				if (seen.has(name)) throw new Error(m.nameDuplicate);
				seen.add(name);
				const url = String(s.baseUrl ?? "").trim();
				if (url) {
					let u;
					try { u = new URL(url); } catch { throw new Error(m.invalidUrl); }
					if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
						throw new Error(m.invalidUrl);
					}
				}
			}
		}

		const STRINGS = {
			zh: {
				title: "Grafana 仪表盘编辑器",
				desc: "配置一个或多个具名 Grafana 源站，通过对话安全地获取并更新仪表盘。令牌仅保存在本地，永远不会被显示。",
				sourcesHeading: "Grafana 源站",
				sourcesEmpty: "尚未配置源站。点击“新增源站”添加一个。",
				addSource: "新增源站",
				sourceNameLabel: "源站名称",
				sourceNamePlaceholder: "例如：生产 / prod-eu",
				nameRequired: "源站名称不能为空。",
				nameDuplicate: "源站名称必须唯一。",
				nameTooLong: "源站名称不能超过 100 个字符。",
				tooManySources: "源站数量不能超过 50 个。",
				uidLabel: "UID（自动生成、全球唯一、不可修改）",
				urlLabel: "Grafana URL",
				urlPlaceholderEmpty: "https://grafana.example.com",
				urlHint: "支持 HTTP 与 HTTPS（HTTP 会明文传输令牌，建议优先使用 HTTPS）。",
				tokenLabel: "服务账号令牌（Service Account Token）",
				configured: "已配置",
				notConfigured: "未配置",
				tokenPlaceholder: "留空则保留当前令牌；输入新令牌以替换",
				tokenHintConfigured: "已配置。星号只是占位符，并非存储的值。",
				tokenHintEmpty: "存储在本地 DSH 凭证库中，凭证值永远不会被读回。",
				setDefault: "设为默认",
				defaultBadge: "默认",
				removeSource: "移除源站",
				saving: "保存中…",
				saveCurrentSource: "保存当前源站",
				saveAllSources: "保存全部源站",
				unsavedBadge: "未保存",
				saved: "已保存。新会话将使用更新后的配置。",
				invalidUrl: "Grafana URL 必须是不含凭证、查询参数或片段的绝对 HTTP(S) 地址。",
				confirmRemoveSource: "确定要移除该源站吗？其已存储的令牌也会一并清除。",
				removedTokenPending: "源站“{name}”已移除，但其令牌清理失败（源站列表已更新，可点击重试补清）：",
				retryTokenCleanup: "重试清除令牌",
				hostTooOld: "当前 DSH 宿主版本过旧（缺少 remote.settings 远端门面），无法读写 Grafana 源站配置。请升级到 0.1.2 或更新版本后重新打开设置页。"
			},
			en: {
				title: "Grafana dashboard editor",
				desc: "Configure one or more named Grafana sources, then fetch and safely update dashboards through conversation. The token is stored locally and never displayed.",
				sourcesHeading: "Grafana sources",
				sourcesEmpty: "No sources yet. Click “Add source” to create one.",
				addSource: "Add source",
				sourceNameLabel: "Source name",
				sourceNamePlaceholder: "e.g. production / prod-eu",
				nameRequired: "Each Grafana source must have a non-empty name.",
				nameDuplicate: "Grafana source names must be unique.",
				nameTooLong: "Grafana source name must not exceed 100 characters.",
				tooManySources: "Too many Grafana sources (limit 50).",
				uidLabel: "UID (auto-generated, globally unique, read-only)",
				urlLabel: "Grafana URL",
				urlPlaceholderEmpty: "https://grafana.example.com",
				urlHint: "HTTP and HTTPS are both supported (HTTP sends the token in cleartext; HTTPS is recommended).",
				tokenLabel: "Service Account Token",
				configured: "Configured",
				notConfigured: "Not configured",
				tokenPlaceholder: "Leave blank to keep the current token; enter a new token to replace it",
				tokenHintConfigured: "Configured. The stars are a placeholder, not the stored value.",
				tokenHintEmpty: "Stored in the local DSH credential store; the value is never read back.",
				setDefault: "Set as default",
				defaultBadge: "Default",
				removeSource: "Remove source",
				saving: "Saving…",
				saveCurrentSource: "Save this source",
				saveAllSources: "Save all sources",
				unsavedBadge: "Unsaved",
				saved: "Saved. New conversations will use the updated configuration.",
				invalidUrl: "Grafana URL must be an absolute HTTP(S) URL without credentials, query, or fragment.",
				confirmRemoveSource: "Remove this source? Its stored token will also be cleared.",
				removedTokenPending: "The source “{name}” was removed, but clearing its stored token failed (the source list is already updated; retry to finish the cleanup):",
				retryTokenCleanup: "Retry token cleanup",
				hostTooOld: "This DSH host is too old (the remote.settings facade is missing), so Grafana sources can be neither read nor written. Please upgrade to 0.1.2 or newer and reopen the settings page."
			}
		};

		// 非浏览器环境（如测试沙箱）中没有 navigator，回退为英文。
		function detectLanguage() {
			try {
				if (typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().startsWith("zh")) return "zh";
			} catch { /* 忽略，走默认。 */ }
			return "en";
		}

		const S = {
			// 折叠卡片外壳对齐官方 PluginCard（ui-settings-plugins 包）的观感：
			// 收起时用 bg-layer-3，展开后切换到 bg-layer-2。
			card: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", background: "var(--dsw-alias-bg-layer-3)", marginBottom: "12px" },
			cardOpen: { background: "var(--dsw-alias-bg-layer-2)" },
			header: { display: "flex", alignItems: "center", gap: "12px", width: "100%", padding: "16px", margin: 0, background: "none", border: "none", cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit" },
			headerText: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minWidth: 0 },
			chevron: { flexShrink: 0, display: "inline-flex", transition: "transform .16s", color: "var(--dsw-alias-label-tertiary)" },
			body: { borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 16px", padding: "16px 0", display: "flex", flexDirection: "column", gap: "14px" },
			title: { margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			desc: { margin: 0, fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
			list: { display: "flex", flexDirection: "column", gap: "12px" },
			// 单个源站子卡：与外层卡片区分，用更浅的层与内边距。
			sourceCard: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", background: "var(--dsw-alias-bg-layer-3)", padding: "14px", display: "flex", flexDirection: "column", gap: "10px" },
			sourceHeader: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			spacer: { flex: "1 1 auto", minWidth: 0 },
			row: { display: "flex", flexDirection: "column", gap: "6px" },
			head: { display: "flex", alignItems: "center", gap: "8px" },
			label: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
			inputRow: { display: "flex", alignItems: "center", gap: "8px" },
			input: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", height: "34px", color: "var(--dsw-alias-label-primary)", borderRadius: "8px", padding: "0 12px", fontSize: "13px", flex: "1 1 auto", minWidth: 0 },
			// UID 只读展示：淡色小字、等宽，明确不可编辑。
			uidRow: { display: "flex", alignItems: "baseline", gap: "6px", flexWrap: "wrap" },
			uidLabel: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
			uidValue: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", fontFamily: "var(--dsw-alias-font-family-monospace, monospace)", wordBreak: "break-all", userSelect: "all" },
			hint: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			badge: { whiteSpace: "nowrap", borderRadius: "999px", padding: "1px 8px", fontSize: "11px", fontWeight: 500, background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", display: "inline-block" },
			badgeOk: { color: "#2f9e44" },
			footer: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
			button: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", borderRadius: "8px", height: "32px", padding: "0 14px", fontSize: "13px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
			smallButton: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)", borderRadius: "8px", height: "26px", padding: "0 10px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
			msg: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
			err: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-error)" }
		};

		// —— 源站卡片级保存的纯函数（单测覆盖，见 test/client.test.js）——
		// 写入门面只接受 { id, name, baseUrl, tokenRef }；此处统一规范化形态。
		function storedRow(s) {
			return { id: s.id, name: s.name, baseUrl: s.baseUrl, tokenRef: s.tokenRef || tokenRefForId(s.id) };
		}
		// 「保存当前源站」的整表投影：只替换/追加本卡片，其它存储行原样（顺序不变）。
		function nextSourcesFor(stored, draft) {
			const row = storedRow({
				id: draft.id,
				name: String(draft.name ?? "").trim(),
				baseUrl: String(draft.baseUrl ?? "").trim(),
				tokenRef: draft.tokenRef
			});
			const rows = stored.map(storedRow);
			return rows.some((s) => s.id === row.id) ? rows.map((s) => (s.id === row.id ? row : s)) : [...rows, row];
		}
		// 该源站卡片是否有未保存的编辑：新增、字段差异（trim 后比较）、或令牌草稿。
		function rowDirty(draft, storedById) {
			const st = storedById.get(draft.id);
			if (!st) return true;
			if (String(draft.tokenDraft ?? "").trim() !== "") return true;
			const a = storedRow({ id: draft.id, name: String(draft.name ?? "").trim(), baseUrl: String(draft.baseUrl ?? "").trim(), tokenRef: draft.tokenRef });
			const b = storedRow(st);
			return a.name !== b.name || a.baseUrl !== b.baseUrl || a.tokenRef !== b.tokenRef;
		}
		// 写后回读的合并：存储为准刷新权威字段与令牌状态，保留仍存在的草稿编辑、
		// 令牌草稿与聚焦态；存储里已移除的卡片草稿一并丢弃；未保存的新卡片原样保留。
		function mergeDrafts(described, drafts) {
			const describedIds = new Set(described.map((s) => s.id));
			const draftById = new Map(drafts.map((s) => [s.id, s]));
			const merged = described.map((s) => {
				const d = draftById.get(s.id);
				const base = { ...s, tokenDraft: "", tokenFocus: false };
				if (!d) return base;
				return { ...base, name: d.name, baseUrl: d.baseUrl, tokenDraft: d.tokenDraft ?? "", tokenFocus: d.tokenFocus ?? false };
			});
			// 存储里缺席的草稿分两类：令牌「已配置」只可能对曾持久化的源站成立，故这类草稿
			// 说明该卡片已被别处移出存储 → 丢弃其陈旧草稿；从未持久化的新卡片令牌必未配置，
			// 原样保留，免得把用户正在填写、尚未保存的新源站被回读冲掉。
			for (const d of drafts) if (!describedIds.has(d.id) && !d.tokenConfigured) merged.push({ ...d });
			return merged;
		}

		// 未落库的卡片不能设为默认：默认源站指向不存在的 id 会让 Host 端判定多源站
		// 无有效默认（此后每次调用都必须显式传 source），而客户端草稿仍留在列表里，
		// UI 与运行时从此不一致。先保存该源站，再设默认。
		function canSetDefault(draft, storedById) {
			return Boolean(draft) && storedById.has(draft.id);
		}

		// 「移除源站」的远端编排（接线层可单测）：源站列表先写、令牌后清。令牌清理
		// 失败不回滚源站删除——新源站 id 是全新 UUID，不会复用该 ref，残留的只是一条
		// 无引用的孤儿凭证——但必须如实报告失败并保留待重试的 ref，绝不谎报成功。
		// remotes 即 face（只用 writeSources / unsetToken）；plan = { nextSources,
		// nextDefault, tokenRef, tokenConfigured }。返回 { tokenCleaned: true } 或
		// { tokenCleaned: false, tokenRef, error }（error 已收敛为字符串消息；HOST_UNSUPPORTED
		// 等本地化翻译由组件层完成）。
		async function removeSourceRemote(remotes, plan) {
			await remotes.writeSources(plan.nextSources, plan.nextDefault);
			if (!plan.tokenConfigured) return { tokenCleaned: true };
			try {
				await remotes.unsetToken(plan.tokenRef);
			} catch (error) {
				return { tokenCleaned: false, tokenRef: plan.tokenRef, error: String(error && error.message ? error.message : error) };
			}
			return { tokenCleaned: true };
		}

		// 待清理令牌按 ref 累积：连续移除两个源站且令牌都清理失败时，两条提示必须各自
		// 保留——单对象状态会让第二个覆盖第一个，先失败的那条孤儿令牌就再没有重试入口。
		// 同一 ref 再次失败只更新原因，不拆成两条。
		function mergeTokenCleanup(list, entry) {
			const rows = Array.isArray(list) ? list : [];
			const index = rows.findIndex((row) => row.ref === entry.ref);
			if (index === -1) return [...rows, entry];
			const next = rows.slice();
			next[index] = { ...rows[index], ...entry };
			return next;
		}

		// 重试成功只移除自身那一条：其余待清理项的重试入口不受影响。
		function dropTokenCleanup(list, ref) {
			return (Array.isArray(list) ? list : []).filter((row) => row.ref !== ref);
		}

		// 源站删除写入成功后的本地权威推进：远端已生效，界面不得继续依赖回读——
		// 回读失败时若仍按旧状态渲染，用户会看到实际上已被删除的源站卡片并基于它
		// 继续操作。nextSources / nextDefault 就是刚写进存储的值，本地照此推进。
		function localStateAfterRemoval({ sources, removedId, nextSources, nextDefault }) {
			return {
				sources: (Array.isArray(sources) ? sources : []).filter((s) => s.id !== removedId),
				stored: nextSources,
				defaultSource: nextDefault
			};
		}

		function GrafanaCard(props) {
			const face = props.grafanaCard;
			// sources 每项：{ id, name, baseUrl, tokenRef, tokenConfigured, tokenDraft, tokenFocus }（草稿）。
			const [sources, setSources] = react.useState([]);
			// stored：最近一次 describe 读回的权威基线（不含草稿字段），是「只提交本卡片」
			// 与脏判定的对照物。storedById 供 rowDirty 按 id 查找。
			const [stored, setStored] = react.useState([]);
			const [defaultSource, setDefaultSource] = react.useState("");
			// 宿主没有 remote.* 远端门面（dsh < 0.1.2）：显式提示升级，而不是把空列表
			// 渲染成“尚未配置源站”，让用户误以为配置丢了。
			const [hostUnsupported, setHostUnsupported] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const [saved, setSaved] = react.useState(false);
			const [error, setError] = react.useState("");
			// 移除源站后令牌清理失败的待重试列表：每项 { ref, name, error }，按 ref 累积
			// （连续移除多个源站且都失败时，每条都得有自己的重试入口）。源站列表已删，
			// 这里只补凭证库那一刀；某条重试成功才移除该条提示。
			const [tokenCleanups, setTokenCleanups] = react.useState([]);
			const [lang, setLang] = react.useState(detectLanguage);
			// 展开状态是卡片本地的阅读手势，Host 与设置页都不参与（同官方 PluginCard）。
			const [open, setOpen] = react.useState(false);
			const T = STRINGS[lang] ?? STRINGS.en;
			const storedById = new Map(stored.map((s) => [s.id, s]));
			// 任一源站卡片脏（含新增未保存）即存在待保存内容，供「保存全部源站」可用性判断。
			const anyDirty = sources.some((s) => rowDirty(s, storedById));

			// 生效默认源站：显式选择命中优先；否则唯一源站即默认（与 Host runtime 一致）。
			const effectiveDefault = (defaultSource && sources.some((s) => s.id === defaultSource))
				? defaultSource
				: (sources.length === 1 ? sources[0].id : "");

			react.useEffect(() => {
				let alive = true;
				face.describe().then((r) => {
					if (!alive) return;
					setHostUnsupported(Boolean(r.hostUnsupported));
					const described = r.sources ?? [];
					setSources(described.map((s) => ({ ...s, tokenDraft: "", tokenFocus: false })));
					setStored(described);
					setDefaultSource(r.defaultSource ?? "");
				}).catch((e) => {
					// 读取失败必须可见。静默 catch 会把任何远端故障渲染成空白源站列表，
					// 且控制台零报错——正是本卡片曾经读写全废却无人察觉的原因。
					if (alive) setError(String(e && e.message ? e.message : e));
				});
				return () => { alive = false; };
			}, [face]);

			// GUI 自身的语言偏好（locale 命名空间）优先于浏览器语言。失败只影响文案，
			// 不值得打断卡片，故仍退回浏览器语言。
			react.useEffect(() => {
				let alive = true;
				face.localePreference().then((p) => {
					if (alive && (p === "zh" || p === "en")) setLang(p);
				}).catch(() => {});
				return () => { alive = false; };
			}, [face]);

			function patchSource(id, patch) {
				setSources((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
			}

			function onAdd() {
				const id = generateSourceId();
				setSources((prev) => [...prev, { id, name: "", baseUrl: "", tokenRef: tokenRefForId(id), tokenConfigured: false, tokenDraft: "", tokenFocus: false }]);
			}

			// 写入后回读并合并：以存储为准刷新权威字段与令牌状态，保留其它卡片未保存的草稿。
			async function reread() {
				const r = await face.describe();
				const described = r.sources ?? [];
				setSources((prev) => mergeDrafts(described, prev));
				setStored(described);
				setDefaultSource(r.defaultSource ?? "");
			}

			// 统一的写入落点：先写令牌草稿（若有），再整表写 sources + defaultSource，最后回读合并。
			// nextSources 为完整的目标数组（含未改动卡片），tokenDrafts 为待写入的 { ref, value }。
			async function persist(nextSources, nextDefault, tokenDrafts) {
				setSaving(true); setSaved(false); setError("");
				try {
					// 先完成全部校验再开始任何写入，避免名称/URL 非法时令牌已落库的半保存状态。
					validateSources(nextSources, T);
					for (const { ref, value } of tokenDrafts) await face.setToken(ref, value);
					await face.writeSources(nextSources, nextDefault);
					await reread();
					setSaved(true);
				} catch (e) {
					const message = String(e && e.message ? e.message : e);
					setError(message === HOST_UNSUPPORTED ? T.hostTooOld : message);
				} finally {
					setSaving(false);
				}
			}

			// 默认源站解析：显式选择命中则用之，否则回退到第一个（保证省略 source 时可用）。
			function resolveDefault(candidates, preferred) {
				return candidates.some((s) => s.id === preferred) ? preferred : (candidates[0] ? candidates[0].id : "");
			}

			// 「保存当前源站」：只提交本卡片。其它卡片以存储值原样带上（不动它们的草稿），
			// 本卡片用草稿值；新卡片追加到末尾。
			async function onSaveOne(id) {
				const draft = sources.find((s) => s.id === id);
				if (!draft) return;
				const nextSources = nextSourcesFor(stored, draft);
				const tokenDrafts = [];
				const t = String(draft.tokenDraft ?? "").trim();
				if (t) tokenDrafts.push({ ref: draft.tokenRef || tokenRefForId(draft.id), value: t });
				await persist(nextSources, resolveDefault(nextSources, defaultSource), tokenDrafts);
			}

			// 「保存全部源站」：提交所有卡片的草稿（含新增），一次性整表写入。
			async function onSaveAll() {
				const nextSources = sources.map((s) => ({
					id: s.id,
					name: String(s.name ?? "").trim(),
					baseUrl: String(s.baseUrl ?? "").trim(),
					tokenRef: s.tokenRef || tokenRefForId(s.id)
				}));
				const tokenDrafts = [];
				for (const s of sources) {
					const t = String(s.tokenDraft ?? "").trim();
					if (t) tokenDrafts.push({ ref: s.tokenRef || tokenRefForId(s.id), value: t });
				}
				await persist(nextSources, resolveDefault(nextSources, defaultSource), tokenDrafts);
			}

			// 移除即写：确认后立即从存储删除该卡片并清除其令牌，不再等保存按钮。
			async function onRemove(id) {
				if (!window.confirm(T.confirmRemoveSource)) return;
				const target = sources.find((s) => s.id === id);
				if (!target) return;
				// 未保存的新卡片从未落库，直接丢草稿即可，无需远端写入。
				if (!storedById.has(id)) {
					setSources((prev) => prev.filter((s) => s.id !== id));
					if (defaultSource === id) setDefaultSource("");
					return;
				}
				const nextSources = stored.filter((s) => s.id !== id).map(storedRow);
				const nextDefault = defaultSource === id ? "" : resolveDefault(nextSources, defaultSource);
				setSaving(true); setSaved(false); setError("");
				try {
					const outcome = await removeSourceRemote(face, {
						nextSources,
						nextDefault,
						tokenRef: target.tokenRef || tokenRefForId(target.id),
						tokenConfigured: Boolean(target.tokenConfigured),
					});
					// 写入已生效：先按已知结果推进本地权威展示（不等回读），否则回读
					// 失败时界面会留着实际上已删除的源站卡片。
					setSources((prev) => localStateAfterRemoval({ sources: prev, removedId: id, nextSources, nextDefault }).sources);
					setStored(nextSources);
					setDefaultSource(nextDefault);
					// 再记录清理失败（保留重试入口）：即使回读失败，提示也不会丢。
					if (!outcome.tokenCleaned) {
						const error = outcome.error === HOST_UNSUPPORTED ? T.hostTooOld : outcome.error;
						setTokenCleanups((prev) => mergeTokenCleanup(prev, { ref: outcome.tokenRef, name: target.name, error }));
					}
					await reread();
					if (outcome.tokenCleaned) setSaved(true);
				} catch (e) {
					const message = String(e && e.message ? e.message : e);
					setError(message === HOST_UNSUPPORTED ? T.hostTooOld : message);
				} finally {
					setSaving(false);
				}
			}

			// 重试清除某一条孤儿令牌：只补这一条 ref 的那一刀。成功只移除自身提示，
			// 并再同步一次（此前的回读可能失败过，本地不得停留在过期状态）；失败就地
			// 更新该条的原因，其余待清理项的重试入口原样保留。
			async function retryTokenCleanup(ref) {
				if (!ref) return;
				setSaving(true); setSaved(false);
				try {
					await face.unsetToken(ref);
				} catch (e) {
					const message = String(e && e.message ? e.message : e);
					setTokenCleanups((prev) => mergeTokenCleanup(prev, { ref, error: message === HOST_UNSUPPORTED ? T.hostTooOld : message }));
					setSaving(false);
					return;
				}
				setTokenCleanups((prev) => dropTokenCleanup(prev, ref));
				setError("");
				setSaved(true);
				try {
					await reread();
				} catch (e) {
					// 清理已成功，但重同步失败的同步错误仍须显示（不能假装一致）。
					const message = String(e && e.message ? e.message : e);
					setError(message === HOST_UNSUPPORTED ? T.hostTooOld : message);
				}
				setSaving(false);
			}

			// 设为默认即写：只改 defaultSource，sources 数组以存储值原样回写（不动草稿）。
			// 未落库的卡片防御性拒绝：渲染层已不显示该按钮，这里兜底防止未来接线回归。
			async function onSetDefault(id) {
				if (!canSetDefault(sources.find((s) => s.id === id), storedById)) return;
				const nextSources = stored.map(storedRow);
				setSaving(true); setSaved(false); setError("");
				try {
					await face.writeSources(nextSources, id);
					await reread();
					setSaved(true);
				} catch (e) {
					const message = String(e && e.message ? e.message : e);
					setError(message === HOST_UNSUPPORTED ? T.hostTooOld : message);
				} finally {
					setSaving(false);
				}
			}

			function renderSource(s) {
				const isDefault = effectiveDefault === s.id;
				const dirty = rowDirty(s, storedById);
				// 已配置时显示虚假掩码；聚焦后展示空白的替换草稿（沿用单源站掩码/聚焦逻辑）。
				const tokenValue = s.tokenConfigured && !s.tokenFocus && s.tokenDraft === "" ? MASK : s.tokenDraft;
				return hs("div", { key: s.id, style: S.sourceCard, children: [
					hs("div", { style: S.sourceHeader, children: [
						h("span", { style: S.label, children: T.sourceNameLabel }),
						isDefault ? h("span", { style: { ...S.badge, ...S.badgeOk }, children: T.defaultBadge }) : null,
						dirty ? h("span", { style: S.badge, children: T.unsavedBadge }) : null,
						h("span", { style: S.spacer }),
						// 未落库的卡片不显示「设为默认」：默认指向不存在的 id 会造成悬空引用。
					isDefault || !canSetDefault(s, storedById) ? null : h("button", { type: "button", style: S.smallButton, disabled: saving, onClick: () => onSetDefault(s.id), children: T.setDefault }),
						h("button", { type: "button", style: S.smallButton, disabled: saving, onClick: () => onRemove(s.id), children: T.removeSource })
					] }),
					h("input", {
						type: "text",
						style: S.input,
						placeholder: T.sourceNamePlaceholder,
						value: s.name,
						onChange: (e) => patchSource(s.id, { name: e.target.value })
					}),
					// UID 只读展示：纯文本（非 input），淡色小字，用户无法编辑。
					hs("div", { style: S.uidRow, children: [
						h("span", { style: S.uidLabel, children: T.uidLabel }),
						h("span", { style: S.uidValue, children: s.id })
					] }),
					hs("div", { style: S.row, children: [
						h("label", { style: S.label, children: T.urlLabel }),
						h("input", { type: "url", style: S.input, placeholder: T.urlPlaceholderEmpty, value: s.baseUrl, onChange: (e) => patchSource(s.id, { baseUrl: e.target.value }) }),
						h("p", { style: S.hint, children: T.urlHint })
					] }),
					hs("div", { style: S.row, children: [
						hs("div", { style: S.head, children: [
							h("label", { style: S.label, children: T.tokenLabel }),
							h("span", { style: { ...S.badge, ...(s.tokenConfigured ? S.badgeOk : {}) }, children: s.tokenConfigured ? T.configured : T.notConfigured })
						] }),
						hs("div", { style: S.inputRow, children: [
							h("input", {
								type: "password",
								style: S.input,
								placeholder: T.tokenPlaceholder,
								value: tokenValue,
								onFocus: () => patchSource(s.id, { tokenFocus: true }),
								onBlur: () => { if (s.tokenDraft === "") patchSource(s.id, { tokenFocus: false }); },
								onChange: (e) => {
									let v = e.target.value;
									// 处理聚焦后立即输入的边界情况，剥离视觉占位符。
									if (v.startsWith(MASK)) v = v.slice(MASK.length);
									patchSource(s.id, { tokenDraft: v });
								}
							})
						] }),
						h("p", { style: S.hint, children: s.tokenConfigured ? T.tokenHintConfigured : T.tokenHintEmpty })
					] }),
					// 本卡片专属保存：仅当有未保存编辑时可用，只提交本卡片。
					hs("div", { style: S.footer, children: [
						h("button", { type: "button", style: S.button, disabled: saving || !dirty, onClick: () => onSaveOne(s.id), children: saving ? T.saving : T.saveCurrentSource })
					] })
				] });
			}

			return hs("section", { style: open ? { ...S.card, ...S.cardOpen } : S.card, children: [
				hs("button", {
					type: "button",
					style: S.header,
					"aria-expanded": open,
					onClick: () => setOpen(!open),
					children: [
						hs("span", { style: S.headerText, children: [
							h("span", { style: S.title, children: T.title }),
							h("span", { style: S.desc, children: T.desc })
						] }),
						h("svg", {
							width: 14,
							height: 14,
							viewBox: "0 0 14 14",
							fill: "none",
							"aria-hidden": "true",
							style: { ...S.chevron, transform: open ? "rotate(180deg)" : "none" },
							children: h("path", { d: "M3.5 5.25 7 8.75 10.5 5.25", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" })
						})
					]
				}),
				open ? hs("div", { style: S.body, children: [
					h("span", { style: S.title, children: T.sourcesHeading }),
					hostUnsupported ? h("p", { style: S.err, children: T.hostTooOld }) : null,
					!hostUnsupported && sources.length === 0 ? h("p", { style: S.hint, children: T.sourcesEmpty }) : null,
					hostUnsupported ? null : hs("div", { style: S.list, children: sources.map(renderSource) }),
					hs("div", { style: S.footer, children: [
						h("button", { type: "button", style: S.button, disabled: saving || hostUnsupported, onClick: onAdd, children: T.addSource })
					] }),
					hs("div", { style: S.footer, children: [
						h("button", { type: "button", style: S.button, disabled: saving || hostUnsupported || !anyDirty, onClick: onSaveAll, children: saving ? T.saving : T.saveAllSources }),
						saved ? h("p", { style: S.msg, children: T.saved }) : null,
						error ? h("p", { style: S.err, children: error }) : null
					] }),
					// 令牌清理待重试：每条一个独立的提示与重试按钮（按 ref 累积，互不覆盖），
					// 独立于通用 error 展示，提示保留到各自重试成功为止。
					...tokenCleanups.map((entry) => hs("div", { key: entry.ref, style: S.footer, children: [
						h("p", { style: S.err, children: `${T.removedTokenPending.replace("{name}", String(entry.name || entry.ref))} ${entry.error}` }),
						h("button", { type: "button", style: S.button, disabled: saving, onClick: () => retryTokenCleanup(entry.ref), children: T.retryTokenCleanup })
					] }))
				] }) : null
			] });
		}

	// 宿主远端门面（dsh 0.1.2+）：settings / credentials 等命名空间服务由 dsh-api-gateway
	// 以 remote.<ns> 之名挂载（dsh-api-remotes 负责 $mount）。必须用 ctx.get 读而不是
	// ctx.remote.<ns>：cordis 4.0.2 实测，未声明 inject 的点号访问直接抛
	// “cannot get property ... without inject”，而 ctx.get 在服务缺席时只返回 undefined。
	// ≤ 0.1.1 的宿主没有这些服务（当时门面在 connection.api 上，0.1.2 重构后已消失），
	// 返回 undefined 即触发卡片的升级提示。
	function remoteNamespace(ctx, ns) {
		return typeof ctx.get === "function" ? ctx.get(`remote.${ns}`) : undefined;
	}

	// 远端应答统一拆封：remote.* 一律返回 { ok, value } 或 { ok:false, error:{ message } }，
	// 没有 result.value 外层（那是 WebSocket 传输信封，远端门面已经拆过了）。
	// 失败必须抛出可读信息：静默降级成空数据会把故障伪装成“没有配置”。
	function unwrap(response, what) {
		if (!response || response.ok !== true) throw new Error(response?.error?.message || `${what} failed`);
		return response.value;
	}

	// settings.describe() 成功应答的 value 是聚合格 { writable, hasDocument, namespaces[] }，
	// 每个描述符的键集为 [ns, schema, value, base, user, applies, secrets, revision]。
	// 本函数只做结构解析（拆信封与 ok 判定由 unwrap 负责），畸形值回退空数组。
	function settingsNamespacesOf(value) {
		const list = value?.namespaces;
		return Array.isArray(list) ? list : [];
	}

	function apply(ctx) {
		// 每次调用时解析远端门面（不在 apply 时缓存）：卡片挂载发生在设置页渲染之后，
		// 而设置页自身 inject ["remote", "remote.settings"]，缺它整页都渲染不出来，
		// 故此时 dsh-api-remotes 的 $mount 必然已完成，不存在挂载竞态。
		const settingsApi = () => remoteNamespace(ctx, "settings");
		const credentialsApi = () => remoteNamespace(ctx, "credentials");
		const face = {
			// sources + 各源站令牌 configured 状态 + defaultSource。
			// URL/名称存 settings（非 secret，返回明文）；令牌存凭证库（只返回 configured）。
			// 宿主没有 remote.settings 时返回 hostUnsupported:true，让卡片显式提示升级。
			describe: async () => {
				const settings = settingsApi();
				if (!settings?.describe) return { hostUnsupported: true, sources: [], defaultSource: "" };
				const described = unwrap(await settings.describe(), "settings.describe");
				const grafanaNs = settingsNamespacesOf(described).find((n) => n?.ns === SETTINGS_NS);
				const value = grafanaNs?.value ?? {};
				const rawSources = Array.isArray(value.sources) ? value.sources : [];
				const sources = rawSources.map(normalizeSource).filter(Boolean);
				const refs = sources.map((s) => s.tokenRef);
				let creds = {};
				const credentials = credentialsApi();
				if (refs.length && credentials?.describe) {
					// describe(refs)：位置参数数组；value 直接就是 ref → { configured, source?, writable } 的 record。
					creds = unwrap(await credentials.describe(refs), "credentials.describe") ?? {};
				}
				const defaultSource = typeof value.defaultSource === "string" ? value.defaultSource : "";
				return {
					hostUnsupported: false,
					sources: sources.map((s) => ({ ...s, tokenConfigured: Boolean(creds[s.tokenRef]?.configured) })),
					defaultSource
				};
			},
			// 令牌走凭证库（仅写不读）：set(ref, value) / unset(ref)，均为位置参数。
			setToken: async (ref, value) => {
				const credentials = credentialsApi();
				if (!credentials?.set) throw new Error(HOST_UNSUPPORTED);
				unwrap(await credentials.set(ref, value), "credentials.set");
			},
			unsetToken: async (ref) => {
				const credentials = credentialsApi();
				if (!credentials?.unset) throw new Error(HOST_UNSUPPORTED);
				unwrap(await credentials.unset(ref), "credentials.unset");
			},
			// 写入整个 sources 数组 + defaultSource。单次 mutate 双 set op：set 对目标路径
			// 整体赋值（数组整体替换，不做按下标合并），两个 op 在宿主写队列的单个事务里
			// 一起应用、一起持久化——此前「先 mutate unset 再 update」两步写在第二步失败时，
			// sources 已被清空而新值未落地，存量用户的全部源站配置会当场丢失。
			// 位置参数：mutate(ns, ops, expectedRevision?)。网关按声明参数表严格校验 arity
			// （dsh-api-gateway prepareInvocation：values.length !== descriptor.parameters.length
			// 即抛 `client api: <endpoint> expected N argument(s), got M`，0.1.2-rc.1 真机实测），
			// 第三参类型上是 union([undefined, number()]) 但 arity 上不可省，故显式传 void 0
			// 表示不做乐观并发校验（官方 agent-preset 包同此写法）。
			writeSources: async (sources, defaultSource) => {
				const settings = settingsApi();
				if (!settings?.mutate) throw new Error(HOST_UNSUPPORTED);
				const normalized = sources.map((s) => ({
					id: s.id,
					name: s.name,
					baseUrl: s.baseUrl,
					tokenRef: s.tokenRef || tokenRefForId(s.id)
				}));
				unwrap(await settings.mutate(SETTINGS_NS, [
					{ op: "set", path: ["sources"], value: normalized },
					{ op: "set", path: ["defaultSource"], value: defaultSource },
				], void 0), "settings.mutate");
			},
			// 读取 GUI 的语言偏好（locale 命名空间的 preference 字段）；不可用时返回空串。
			// 语言只是外观，失败不值得报错打断卡片，故这里吸掉异常退回浏览器语言。
			localePreference: async () => {
				const settings = settingsApi();
				if (!settings?.describe) return "";
				try {
					const described = unwrap(await settings.describe(), "settings.describe");
					const locale = settingsNamespacesOf(described).find((n) => n?.ns === "locale");
					const pref = locale?.value?.preference;
					return typeof pref === "string" ? pref : "";
				} catch {
					return "";
				}
			}
		};
		ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
			// keyed slot：设置页按 Host 端 settings namespace（见 index.js 的
			// SETTINGS_NAMESPACE）派发卡片，没有 key 的注册永远不会被渲染。
			name: "settings.plugin.item",
			key: "grafana",
			inject: () => ({ grafanaCard: face })
		}, GrafanaCard));
	}

		exports.apply = apply;
		exports.inject = inject;
		// 供测试驱动的纯函数、应答解析与卡片文案（不参与运行时契约）。
		// STRINGS 入列是为了让“宿主过旧”提示的双语存在性可被断言：卡片的 render 路径
		// 本仓库没有 DOM 测试台，文案键缺失只能在这一层拦住。
		exports.internals = Object.freeze({ STRINGS, settingsNamespacesOf, generateSourceId, tokenRefForId, normalizeSource, validateSources, nextSourcesFor, rowDirty, mergeDrafts, canSetDefault, removeSourceRemote, mergeTokenCleanup, dropTokenCleanup, localStateAfterRemoval });
		return module.exports;
	}
});
