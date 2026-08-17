// dsh-grafana — 浏览器端：在「设置 → 插件」页注册配置卡片。
// 由 dsh-client-modules 按 /plugins/dsh-grafana/client.js 加载，
// 通过 window.__ModuleLoader__.load 注册；工厂内为纯 CJS，
// require 由 shell 模块表解析（仅平台种子词与已注册客户端包可用）。
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
			const [status, setStatus] = react.useState({ loaded: false, token: false });
			const [tokenDraft, setTokenDraft] = react.useState("");
			const [baseDraft, setBaseDraft] = react.useState("");
			const [saving, setSaving] = react.useState(false);
			const [saved, setSaved] = react.useState(false);
			const [error, setError] = react.useState("");

			react.useEffect(() => {
				let alive = true;
				face.describe().then((r) => {
					if (alive) setStatus({ loaded: true, token: r.tokenConfigured });
				}).catch((e) => {
					if (alive) { setStatus({ loaded: true, token: false }); setError(String(e?.message ?? e)); }
				});
				return () => { alive = false; };
			}, [face]);

			async function onSave() {
				setSaving(true); setSaved(false); setError("");
				try {
					const t = tokenDraft.trim();
					const b = baseDraft.trim();
					if (t !== "") await face.setToken(t);
					if (b !== "") await face.setBaseUrl(b);
					const r = await face.describe();
					setStatus({ loaded: true, token: r.tokenConfigured });
					setTokenDraft(""); setBaseDraft("");
					setSaved(true);
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setSaving(false);
				}
			}

			return (0, react_jsx_runtime.jsxs)("section", { style: S.card, children: [
				(0, react_jsx_runtime.jsx)("h3", { style: S.title, children: "Grafana 大盘编辑" }),
				(0, react_jsx_runtime.jsx)("p", { style: S.desc, children: "贴大盘 URL 给 AI，对话微调后写回 Grafana。在此配置连接信息，保存后对后续对话生效。" }),
				(0, react_jsx_runtime.jsxs)("div", { style: S.row, children: [
					(0, react_jsx_runtime.jsxs)("div", { style: S.head, children: [
						(0, react_jsx_runtime.jsx)("label", { style: S.label, children: "Service Account Token" }),
						status.loaded ? (0, react_jsx_runtime.jsx)("span", { style: { ...S.badge, ...(status.token ? S.badgeOk : {}) }, children: status.token ? "已配置" : "未配置" }) : null
					] }),
					(0, react_jsx_runtime.jsx)("input", { type: "password", style: S.input, placeholder: "留空保持现有凭证；粘贴 glsa_… 后点保存", value: tokenDraft, onChange: (e) => setTokenDraft(e.target.value) }),
					(0, react_jsx_runtime.jsx)("p", { style: S.hint, children: "写入本机凭证库（~/.dsh/.credentials.yaml，600 权限）；界面永不回显。" })
				] }),
				(0, react_jsx_runtime.jsxs)("div", { style: S.row, children: [
					(0, react_jsx_runtime.jsx)("label", { style: S.label, children: "Grafana 地址" }),
					(0, react_jsx_runtime.jsx)("input", { type: "text", style: S.input, placeholder: "留空保持当前值；如 https://grafana.example.com", value: baseDraft, onChange: (e) => setBaseDraft(e.target.value) }),
					(0, react_jsx_runtime.jsx)("p", { style: S.hint, children: "同样写入本机凭证库（GRAFANA_BASE_URL），保存后即生效。" })
				] }),
				(0, react_jsx_runtime.jsxs)("div", { style: S.footer, children: [
					(0, react_jsx_runtime.jsx)("button", { style: S.button, disabled: saving, onClick: onSave, children: saving ? "保存中…" : "保存" }),
					saved ? (0, react_jsx_runtime.jsx)("p", { style: S.msg, children: "已保存，后续对话使用新配置。" }) : null,
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
				setBaseUrl: (value) => api.credentials.set({ ref: BASE_URL_REF, value })
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
