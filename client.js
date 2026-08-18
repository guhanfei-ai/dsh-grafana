// dsh-grafana 浏览器设置卡片。凭证值只通过 DSH 的 loopback same-origin
// 凭证 RPC 单向写入，客户端永远不会读回明文。
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
		// 仅用于视觉提示的占位符，永远不会写入凭证库。
		const MASK = "*".repeat(28);

		const inject = ["slots", "connection"];

		const S = {
			card: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", background: "var(--dsw-alias-bg-layer-2)", padding: "16px", marginBottom: "12px", display: "flex", flexDirection: "column", gap: "12px" },
			title: { margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			desc: { margin: 0, fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
			row: { display: "flex", flexDirection: "column", gap: "6px" },
			head: { display: "flex", alignItems: "center", gap: "8px" },
			label: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
			input: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", height: "34px", color: "var(--dsw-alias-label-primary)", borderRadius: "8px", padding: "0 12px", fontSize: "13px" },
			hint: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" },
			badge: { whiteSpace: "nowrap", borderRadius: "999px", padding: "1px 8px", fontSize: "11px", fontWeight: 500, background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", display: "inline-block" },
			badgeOk: { color: "#2f9e44" },
			footer: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
			button: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", borderRadius: "8px", height: "32px", padding: "0 14px", fontSize: "13px", cursor: "pointer" },
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

			// 已配置时显示虚假掩码；聚焦后展示空白的替换草稿。
			const tokenValue = status.token && !tokenFocus && tokenDraft === "" ? MASK : tokenDraft;

			react.useEffect(() => {
				let alive = true;
				face.describe().then((r) => {
					if (alive) setStatus({ loaded: true, token: r.tokenConfigured, base: r.baseConfigured });
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
							throw new Error("Grafana URL must be an absolute HTTP(S) URL without credentials, query, or fragment.");
						}
						await face.setBaseUrl(b);
					}
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

			async function onClear(kind) {
				const label = kind === "token" ? "service-account token" : "Grafana URL";
				if (!window.confirm(`Remove the stored ${label}?`)) return;
				setSaving(true); setSaved(false); setError("");
				try {
					await face.unset(kind === "token" ? TOKEN_REF : BASE_URL_REF);
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

			return (0, react_jsx_runtime.jsxs)("section", { style: S.card, children: [
				(0, react_jsx_runtime.jsx)("h3", { style: S.title, children: "Grafana dashboard editor" }),
				(0, react_jsx_runtime.jsx)("p", { style: S.desc, children: "Fetch and safely update Grafana dashboards through conversation. Credential values are stored locally and never displayed." }),
				(0, react_jsx_runtime.jsxs)("div", { style: S.row, children: [
					(0, react_jsx_runtime.jsxs)("div", { style: S.head, children: [
						(0, react_jsx_runtime.jsx)("label", { style: S.label, children: "Service Account Token" }),
						status.loaded ? (0, react_jsx_runtime.jsx)("span", { style: { ...S.badge, ...(status.token ? S.badgeOk : {}) }, children: status.token ? "Configured" : "Not configured" }) : null
					] }),
					(0, react_jsx_runtime.jsx)("input", {
						type: "password",
						style: S.input,
						placeholder: "Leave blank to keep the current token; enter a new token to replace it",
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
					(0, react_jsx_runtime.jsx)("p", { style: S.hint, children: status.token ? "Configured. The stars are a placeholder, not the stored value." : "Stored in the local DSH credential store; the value is never read back." }),
					status.token ? (0, react_jsx_runtime.jsx)("button", { style: S.button, disabled: saving, onClick: () => onClear("token"), children: "Remove token" }) : null
				] }),
				(0, react_jsx_runtime.jsxs)("div", { style: S.row, children: [
					(0, react_jsx_runtime.jsxs)("div", { style: S.head, children: [
						(0, react_jsx_runtime.jsx)("label", { style: S.label, children: "Grafana URL" }),
						status.loaded ? (0, react_jsx_runtime.jsx)("span", { style: { ...S.badge, ...(status.base ? S.badgeOk : {}) }, children: status.base ? "Configured" : "Not configured" }) : null
					] }),
					(0, react_jsx_runtime.jsx)("input", { type: "url", style: S.input, placeholder: status.base ? "Configured; enter a new URL to replace it" : "https://grafana.example.com", value: baseDraft, onChange: (e) => setBaseDraft(e.target.value) }),
					(0, react_jsx_runtime.jsx)("p", { style: S.hint, children: "HTTPS is required by default. The stored URL is intentionally not displayed." }),
					status.base ? (0, react_jsx_runtime.jsx)("button", { style: S.button, disabled: saving, onClick: () => onClear("base"), children: "Remove URL" }) : null
				] }),
				(0, react_jsx_runtime.jsxs)("div", { style: S.footer, children: [
					(0, react_jsx_runtime.jsx)("button", { style: S.button, disabled: saving, onClick: onSave, children: saving ? "Saving…" : "Save" }),
					saved ? (0, react_jsx_runtime.jsx)("p", { style: S.msg, children: "Saved. New conversations will use the updated configuration." }) : null,
					error ? (0, react_jsx_runtime.jsx)("p", { style: S.err, children: error }) : null
				] })
			] });
		}

		function apply(ctx) {
			const { api } = ctx.get("connection");
			const face = {
				describe: async () => {
					const res = await api.credentials.describe({ refs: [TOKEN_REF, BASE_URL_REF] });
					const creds = res?.result?.value?.credentials ?? {};
					return {
						tokenConfigured: creds[TOKEN_REF]?.configured ?? false,
						baseConfigured: creds[BASE_URL_REF]?.configured ?? false
					};
				},
				setToken: (value) => api.credentials.set({ ref: TOKEN_REF, value }),
				setBaseUrl: (value) => api.credentials.set({ ref: BASE_URL_REF, value }),
				unset: (ref) => api.credentials.unset({ ref })
			};
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "grafana",
				order: 30,
				inject: () => ({ grafanaCard: face })
			}, GrafanaCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
