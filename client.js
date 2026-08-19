// dsh-grafana 浏览器设置卡片。
// Token 走 DSH 凭证库的 loopback same-origin RPC：仅写不读，
// describe 只返回 configured 布尔，客户端永远不会读回明文，故以星号占位。
// URL 不是敏感信息，存 settings namespace（grafana）：settings.describe 对
// 非 secret 字段返回明文 value，因此保存后可直接回显核对。
window.__ModuleLoader__.load({
	id: "dsh-grafana",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const TOKEN_REF = "GRAFANA_TOKEN";
		const BASE_URL_REF = "GRAFANA_BASE_URL";
		const SETTINGS_NS = "grafana";
		// 仅用于视觉提示的占位符，永远不会写入凭证库。
		const MASK = "*".repeat(28);

		const inject = ["slots", "connection"];

		const STRINGS = {
			zh: {
				title: "Grafana 仪表盘编辑器",
				desc: "通过对话获取并安全地更新 Grafana 仪表盘。令牌仅保存在本地，永远不会被显示。",
				tokenLabel: "服务账号令牌（Service Account Token）",
				configured: "已配置",
				notConfigured: "未配置",
				tokenPlaceholder: "留空则保留当前令牌；输入新令牌以替换",
				tokenHintConfigured: "已配置。星号只是占位符，并非存储的值。",
				tokenHintEmpty: "存储在本地 DSH 凭证库中，凭证值永远不会被读回。",
				removeToken: "移除令牌",
				urlPlaceholderConfigured: "输入新 URL 以替换",
				urlPlaceholderEmpty: "https://grafana.example.com",
				urlHint: "支持 HTTP 与 HTTPS（HTTP 会明文传输令牌，建议优先使用 HTTPS）。URL 保存在设置中，保存后会在此显示以便核对。",
				removeUrl: "移除 URL",
				saving: "保存中…",
				save: "保存",
				saved: "已保存。新会话将使用更新后的配置。",
				invalidUrl: "Grafana URL 必须是不含凭证、查询参数或片段的绝对 HTTP(S) 地址。",
				confirmRemoveToken: "确定要移除已存储的服务账号令牌吗？",
				confirmRemoveUrl: "确定要移除已存储的 Grafana URL 吗？"
			},
			en: {
				title: "Grafana dashboard editor",
				desc: "Fetch and safely update Grafana dashboards through conversation. The token is stored locally and never displayed.",
				tokenLabel: "Service Account Token",
				configured: "Configured",
				notConfigured: "Not configured",
				tokenPlaceholder: "Leave blank to keep the current token; enter a new token to replace it",
				tokenHintConfigured: "Configured. The stars are a placeholder, not the stored value.",
				tokenHintEmpty: "Stored in the local DSH credential store; the value is never read back.",
				removeToken: "Remove token",
				urlPlaceholderConfigured: "Enter a new URL to replace it",
				urlPlaceholderEmpty: "https://grafana.example.com",
				urlHint: "HTTP and HTTPS are both supported (HTTP sends the token in cleartext; HTTPS is recommended). The URL is stored in settings and shown here after saving.",
				removeUrl: "Remove URL",
				saving: "Saving…",
				save: "Save",
				saved: "Saved. New conversations will use the updated configuration.",
				invalidUrl: "Grafana URL must be an absolute HTTP(S) URL without credentials, query, or fragment.",
				confirmRemoveToken: "Remove the stored service-account token?",
				confirmRemoveUrl: "Remove the stored Grafana URL?"
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
			body: { borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 16px", padding: "16px 0", display: "flex", flexDirection: "column", gap: "12px" },
			title: { margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			desc: { margin: 0, fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
			row: { display: "flex", flexDirection: "column", gap: "6px" },
			head: { display: "flex", alignItems: "center", gap: "8px" },
			label: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
			inputRow: { display: "flex", alignItems: "center", gap: "8px" },
			input: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", height: "34px", color: "var(--dsw-alias-label-primary)", borderRadius: "8px", padding: "0 12px", fontSize: "13px", flex: "1 1 auto", minWidth: 0 },
			hint: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			badge: { whiteSpace: "nowrap", borderRadius: "999px", padding: "1px 8px", fontSize: "11px", fontWeight: 500, background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", display: "inline-block" },
			badgeOk: { color: "#2f9e44" },
			footer: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
			button: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", borderRadius: "8px", height: "32px", padding: "0 14px", fontSize: "13px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
			msg: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
			err: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-error)" }
		};

		function GrafanaCard(props) {
			const face = props.grafanaCard;
			const [status, setStatus] = react.useState({ loaded: false, token: false, base: false });
			const [tokenDraft, setTokenDraft] = react.useState("");
			const [baseDraft, setBaseDraft] = react.useState("");
			const [saving, setSaving] = react.useState(false);
			const [saved, setSaved] = react.useState(false);
			const [error, setError] = react.useState("");
			const [tokenFocus, setTokenFocus] = react.useState(false);
			const [lang, setLang] = react.useState(detectLanguage);
			// 展开状态是卡片本地的阅读手势，Host 与设置页都不参与（同官方 PluginCard）。
			const [open, setOpen] = react.useState(false);
			const T = STRINGS[lang] ?? STRINGS.en;

			// 已配置时显示虚假掩码；聚焦后展示空白的替换草稿。
			const tokenValue = status.token && !tokenFocus && tokenDraft === "" ? MASK : tokenDraft;

			react.useEffect(() => {
				let alive = true;
				face.describe().then((r) => {
					if (!alive) return;
					setStatus({ loaded: true, token: r.tokenConfigured, base: r.baseConfigured });
					// URL 存 settings namespace（非 secret），describe 直接返回明文，可靠回显。
					if (r.baseUrl) setBaseDraft(r.baseUrl);
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

			async function onSave() {
				setSaving(true); setSaved(false); setError("");
				try {
					const t = tokenDraft.trim();
					const b = baseDraft.trim();
					if (t !== "") await face.setToken(t);
					if (b !== "") {
						const url = new URL(b);
						if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
							throw new Error(T.invalidUrl);
						}
						await face.setBaseUrl(b);
					}
					const r = await face.describe();
					setStatus({ loaded: true, token: r.tokenConfigured, base: r.baseConfigured });
					setTokenDraft(""); setTokenFocus(false);
					setBaseDraft(b !== "" ? b : (r.baseConfigured ? r.baseUrl : ""));
					setSaved(true);
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setSaving(false);
				}
			}

			async function onClear(kind) {
				const message = kind === "token" ? T.confirmRemoveToken : T.confirmRemoveUrl;
				if (!window.confirm(message)) return;
				setSaving(true); setSaved(false); setError("");
				try {
					// token 走凭证库；base URL 走 settings namespace，移除路径不同。
					await (kind === "token" ? face.unsetToken() : face.unsetBaseUrl());
					const r = await face.describe();
					setStatus({ loaded: true, token: r.tokenConfigured, base: r.baseConfigured });
					setTokenDraft(""); setBaseDraft(""); setTokenFocus(false);
					setSaved(true);
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setSaving(false);
				}
			}

			return (0, react_jsx_runtime.jsxs)("section", { style: open ? { ...S.card, ...S.cardOpen } : S.card, children: [
				(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: S.header,
					"aria-expanded": open,
					onClick: () => setOpen(!open),
					children: [
						(0, react_jsx_runtime.jsxs)("span", { style: S.headerText, children: [
							(0, react_jsx_runtime.jsx)("span", { style: S.title, children: T.title }),
							(0, react_jsx_runtime.jsx)("span", { style: S.desc, children: T.desc })
						] }),
						(0, react_jsx_runtime.jsx)("svg", {
							width: 14,
							height: 14,
							viewBox: "0 0 14 14",
							fill: "none",
							"aria-hidden": "true",
							style: { ...S.chevron, transform: open ? "rotate(180deg)" : "none" },
							children: (0, react_jsx_runtime.jsx)("path", { d: "M3.5 5.25 7 8.75 10.5 5.25", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" })
						})
					]
				}),
				open ? (0, react_jsx_runtime.jsxs)("div", { style: S.body, children: [
					(0, react_jsx_runtime.jsxs)("div", { style: S.row, children: [
						(0, react_jsx_runtime.jsxs)("div", { style: S.head, children: [
							(0, react_jsx_runtime.jsx)("label", { style: S.label, children: T.tokenLabel }),
							status.loaded ? (0, react_jsx_runtime.jsx)("span", { style: { ...S.badge, ...(status.token ? S.badgeOk : {}) }, children: status.token ? T.configured : T.notConfigured }) : null
						] }),
						(0, react_jsx_runtime.jsxs)("div", { style: S.inputRow, children: [
							(0, react_jsx_runtime.jsx)("input", {
								type: "password",
								style: S.input,
								placeholder: T.tokenPlaceholder,
								value: tokenValue,
								onFocus: () => setTokenFocus(true),
								onBlur: () => { if (tokenDraft === "") setTokenFocus(false); },
								onChange: (e) => {
									let v = e.target.value;
									// 处理聚焦后立即输入的边界情况，剥离视觉占位符。
									if (v.startsWith(MASK)) v = v.slice(MASK.length);
									setTokenDraft(v);
								}
							}),
							status.token ? (0, react_jsx_runtime.jsx)("button", { style: S.button, disabled: saving, onClick: () => onClear("token"), children: T.removeToken }) : null
						] }),
						(0, react_jsx_runtime.jsx)("p", { style: S.hint, children: status.token ? T.tokenHintConfigured : T.tokenHintEmpty })
					] }),
					(0, react_jsx_runtime.jsxs)("div", { style: S.row, children: [
						(0, react_jsx_runtime.jsxs)("div", { style: S.head, children: [
							(0, react_jsx_runtime.jsx)("label", { style: S.label, children: "Grafana URL" }),
							status.loaded ? (0, react_jsx_runtime.jsx)("span", { style: { ...S.badge, ...(status.base ? S.badgeOk : {}) }, children: status.base ? T.configured : T.notConfigured }) : null
						] }),
						(0, react_jsx_runtime.jsxs)("div", { style: S.inputRow, children: [
							(0, react_jsx_runtime.jsx)("input", { type: "url", style: S.input, placeholder: status.base ? T.urlPlaceholderConfigured : T.urlPlaceholderEmpty, value: baseDraft, onChange: (e) => setBaseDraft(e.target.value) }),
							status.base ? (0, react_jsx_runtime.jsx)("button", { style: S.button, disabled: saving, onClick: () => onClear("base"), children: T.removeUrl }) : null
						] }),
						(0, react_jsx_runtime.jsx)("p", { style: S.hint, children: T.urlHint })
					] }),
					(0, react_jsx_runtime.jsxs)("div", { style: S.footer, children: [
						(0, react_jsx_runtime.jsx)("button", { style: S.button, disabled: saving, onClick: onSave, children: saving ? T.saving : T.save }),
						saved ? (0, react_jsx_runtime.jsx)("p", { style: S.msg, children: T.saved }) : null,
						error ? (0, react_jsx_runtime.jsx)("p", { style: S.err, children: error }) : null
					] })
				] }) : null
			] });
		}

		function apply(ctx) {
			const { api } = ctx.get("connection");
			const face = {
				describe: async () => {
					// token 走凭证库（只返回 configured）；URL 走 settings namespace（非 secret，返回明文）。
					const [credRes, setRes] = await Promise.all([
						api.credentials.describe({ refs: [TOKEN_REF, BASE_URL_REF] }),
						api.settings?.describe ? api.settings.describe({}) : Promise.resolve(null),
					]);
					const creds = credRes?.result?.value?.credentials ?? {};
					const grafanaNs = (setRes?.result?.value?.namespaces ?? []).find((n) => n?.ns === SETTINGS_NS);
					const baseUrl = typeof grafanaNs?.value?.baseUrl === "string" ? grafanaNs.value.baseUrl : "";
					return {
						tokenConfigured: creds[TOKEN_REF]?.configured ?? false,
						baseConfigured: Boolean(baseUrl),
						baseUrl
					};
				},
				setToken: (value) => api.credentials.set({ ref: TOKEN_REF, value }),
				// URL 存 settings namespace：update 做 deep-merge，不动 tokenRef/allowInsecureHttp。
				setBaseUrl: (value) => api.settings.update({ ns: SETTINGS_NS, patch: { baseUrl: value } }),
				// token 移除走凭证库。
				unsetToken: () => api.credentials.unset({ ref: TOKEN_REF }),
				// URL 移除走 settings.mutate：浏览器只持有 redacted 视图，
				// replace wholesale 会误删 schema 里其它已存字段，故用单字段 op。
				unsetBaseUrl: () => api.settings.mutate({ ns: SETTINGS_NS, ops: [{ op: "unset", path: ["baseUrl"] }] }),
				// 读取 GUI 的语言偏好（locale 命名空间的 preference 字段）；不可用时返回空串。
				localePreference: async () => {
					if (!api.settings?.describe) return "";
					const res = await api.settings.describe({});
					const namespaces = res?.result?.value?.namespaces ?? [];
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
		return module.exports;
	}
});
