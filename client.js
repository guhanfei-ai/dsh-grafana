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

		const inject = ["slots", "connection"];

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
				save: "保存",
				saved: "已保存。新会话将使用更新后的配置。",
				invalidUrl: "Grafana URL 必须是不含凭证、查询参数或片段的绝对 HTTP(S) 地址。",
				confirmRemoveSource: "确定要移除该源站吗？其已存储的令牌也会一并清除。"
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
				save: "Save",
				saved: "Saved. New conversations will use the updated configuration.",
				invalidUrl: "Grafana URL must be an absolute HTTP(S) URL without credentials, query, or fragment.",
				confirmRemoveSource: "Remove this source? Its stored token will also be cleared."
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

		function GrafanaCard(props) {
			const face = props.grafanaCard;
			// sources 每项：{ id, name, baseUrl, tokenRef, tokenConfigured, tokenDraft, tokenFocus }。
			const [sources, setSources] = react.useState([]);
			const [defaultSource, setDefaultSource] = react.useState("");
			// 已移除且此前已配置令牌的源站 ref：保存时统一 unset。
			const [removedRefs, setRemovedRefs] = react.useState([]);
			const [saving, setSaving] = react.useState(false);
			const [saved, setSaved] = react.useState(false);
			const [error, setError] = react.useState("");
			const [lang, setLang] = react.useState(detectLanguage);
			// 展开状态是卡片本地的阅读手势，Host 与设置页都不参与（同官方 PluginCard）。
			const [open, setOpen] = react.useState(false);
			const T = STRINGS[lang] ?? STRINGS.en;

			// 生效默认源站：显式选择命中优先；否则唯一源站即默认（与 Host runtime 一致）。
			const effectiveDefault = (defaultSource && sources.some((s) => s.id === defaultSource))
				? defaultSource
				: (sources.length === 1 ? sources[0].id : "");

			react.useEffect(() => {
				let alive = true;
				face.describe().then((r) => {
					if (!alive) return;
					setSources((r.sources ?? []).map((s) => ({ ...s, tokenDraft: "", tokenFocus: false })));
					setDefaultSource(r.defaultSource ?? "");
				}).catch(() => {});
				return () => { alive = false; };
			}, [face]);

			// GUI 自身的语言偏好（locale 命名空间）优先于浏览器语言。
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

			function onRemove(id) {
				if (!window.confirm(T.confirmRemoveSource)) return;
				const target = sources.find((s) => s.id === id);
				// 仅当该源站此前已写入令牌时才需要 unset；未保存的草稿直接丢弃。
				if (target && target.tokenConfigured) setRemovedRefs((prev) => [...prev, target.tokenRef]);
				setSources((prev) => prev.filter((s) => s.id !== id));
				if (defaultSource === id) setDefaultSource("");
			}

			async function onSave() {
				setSaving(true); setSaved(false); setError("");
				try {
					const finalSources = sources.map((s) => ({
						id: s.id,
						name: String(s.name ?? "").trim(),
						baseUrl: String(s.baseUrl ?? "").trim(),
						tokenRef: s.tokenRef || tokenRefForId(s.id)
					}));
					// 先完成全部校验再开始任何写入，避免名称/URL 非法时令牌已落库的半保存状态。
					validateSources(finalSources, T);
					// 默认源站：当前选择命中则用之，否则回退到第一个（保证省略 source 时可用）。
					const def = finalSources.some((s) => s.id === defaultSource)
						? defaultSource
						: (finalSources[0] ? finalSources[0].id : "");
					// 1) 写入有新令牌草稿的源站令牌（各自 ref）。
					for (const s of sources) {
						const t = String(s.tokenDraft ?? "").trim();
						if (t) await face.setToken(s.tokenRef || tokenRefForId(s.id), t);
					}
					// 2) 写入整个 sources 数组 + defaultSource。
					await face.writeSources(finalSources, def);
					// 3) 清除已移除源站的令牌。
					for (const ref of removedRefs) await face.unsetToken(ref);
					// 重新读回权威状态，清空草稿。
					const r = await face.describe();
					setSources((r.sources ?? []).map((s) => ({ ...s, tokenDraft: "", tokenFocus: false })));
					setDefaultSource(r.defaultSource ?? "");
					setRemovedRefs([]);
					setSaved(true);
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setSaving(false);
				}
			}

			function renderSource(s) {
				const isDefault = effectiveDefault === s.id;
				// 已配置时显示虚假掩码；聚焦后展示空白的替换草稿（沿用单源站掩码/聚焦逻辑）。
				const tokenValue = s.tokenConfigured && !s.tokenFocus && s.tokenDraft === "" ? MASK : s.tokenDraft;
				return hs("div", { key: s.id, style: S.sourceCard, children: [
					hs("div", { style: S.sourceHeader, children: [
						h("span", { style: S.label, children: T.sourceNameLabel }),
						isDefault ? h("span", { style: { ...S.badge, ...S.badgeOk }, children: T.defaultBadge }) : null,
						h("span", { style: S.spacer }),
						isDefault ? null : h("button", { type: "button", style: S.smallButton, disabled: saving, onClick: () => setDefaultSource(s.id), children: T.setDefault }),
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
					sources.length === 0 ? h("p", { style: S.hint, children: T.sourcesEmpty }) : null,
					hs("div", { style: S.list, children: sources.map(renderSource) }),
					hs("div", { style: S.footer, children: [
						h("button", { type: "button", style: S.button, disabled: saving, onClick: onAdd, children: T.addSource })
					] }),
					hs("div", { style: S.footer, children: [
						h("button", { type: "button", style: S.button, disabled: saving, onClick: onSave, children: saving ? T.saving : T.save }),
						saved ? h("p", { style: S.msg, children: T.saved }) : null,
						error ? h("p", { style: S.err, children: error }) : null
					] })
				] }) : null
			] });
		}

	// settings describe 应答的双代信封解析：dsh ≤0.1.1 的远端把描述符聚合在
	// result.value.namespaces[]；0.1.2-rc.1 起直接返回描述符数组（每项
	// {ns, schema, value, …}，字段两代同名）。数组优先、namespaces 兜底。
	function settingsNamespacesOf(res) {
		const value = res?.result?.value;
		if (Array.isArray(value)) return value;
		const list = value?.namespaces;
		return Array.isArray(list) ? list : [];
	}

	function apply(ctx) {
		const { api } = ctx.get("connection");
		const face = {
			// sources + 各源站令牌 configured 状态 + defaultSource。
			// URL/名称存 settings（非 secret，返回明文）；令牌存凭证库（只返回 configured）。
			describe: async () => {
				const setRes = api.settings?.describe ? await api.settings.describe({}) : null;
				const grafanaNs = settingsNamespacesOf(setRes).find((n) => n?.ns === SETTINGS_NS);
				const value = grafanaNs?.value ?? {};
				const rawSources = Array.isArray(value.sources) ? value.sources : [];
				const sources = rawSources.map(normalizeSource).filter(Boolean);
				const refs = sources.map((s) => s.tokenRef);
				let creds = {};
				if (refs.length && api.credentials?.describe) {
					const credRes = await api.credentials.describe({ refs });
					creds = credRes?.result?.value?.credentials ?? {};
				}
				const defaultSource = typeof value.defaultSource === "string" ? value.defaultSource : "";
				return {
					sources: sources.map((s) => ({ ...s, tokenConfigured: Boolean(creds[s.tokenRef]?.configured) })),
					defaultSource
				};
			},
			// 令牌走凭证库（仅写不读）。
			setToken: (ref, value) => api.credentials.set({ ref, value }),
			unsetToken: (ref) => api.credentials.unset({ ref }),
			// 写入整个 sources 数组 + defaultSource。两步：先 mutate unset ['sources']
			// 清掉旧数组（避免 update 对数组按下标深合并留下陈旧项），再 update 写新值。
			// 仅用仓库已验证的原语（mutate 的 unset op + update 的 deep-merge）。
			writeSources: async (sources, defaultSource) => {
				const normalized = sources.map((s) => ({
					id: s.id,
					name: s.name,
					baseUrl: s.baseUrl,
					tokenRef: s.tokenRef || tokenRefForId(s.id)
				}));
				await api.settings.mutate({ ns: SETTINGS_NS, ops: [{ op: "unset", path: ["sources"] }] });
				await api.settings.update({ ns: SETTINGS_NS, patch: { sources: normalized, defaultSource } });
			},
			// 读取 GUI 的语言偏好（locale 命名空间的 preference 字段）；不可用时返回空串。
			localePreference: async () => {
				if (!api.settings?.describe) return "";
				const res = await api.settings.describe({});
				const namespaces = settingsNamespacesOf(res);
				const locale = namespaces.find((n) => n?.ns === "locale");
				const pref = locale?.value?.preference;
				return typeof pref === "string" ? pref : "";
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
		// 供测试驱动的纯函数与双代信封解析（不参与运行时契约）。
		exports.internals = Object.freeze({ settingsNamespacesOf, generateSourceId, tokenRefForId, normalizeSource, validateSources });
		return module.exports;
	}
});
