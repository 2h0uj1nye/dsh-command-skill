window.__ModuleLoader__.load({
	id: "dsh-command-skill",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");
		//#region lib/client.js
		/**
		* Browser half of dsh-command-skill.
		*
		* Two surfaces:
		*  1. Settings → 技能 section: a full skill manager — list every
		*     available skill with enable/disable state, view a skill's full
		*     instructions, translate them English → Chinese (DeepSeek), toggle
		*     enable/disable, remove user-level skills, and import new skills
		*     from a local path or URL. All actions go through the host's
		*     `/skill-manage` HTTP routes (session-free).
		*  2. `/skill` command decoration: the composer popup selector that
		*     picks preferred skills for the current session (kept from v0).
		* @module dsh-command-skill/client
		*/
		/** Required client services: the slot registry plus the command/connection faces. */
		const inject = [
			"slots",
			"commandUi",
			"connection",
			"remote",
			"remote.commands",
			"sessions"
		];
		/** Picked-name rows: `✓ name — description` (machine-parseable list format). */
		const PICKED_LINE = /^\u2713\s+([a-z0-9-]+)\s+\u2014/u;
		/** Fallback row explaining how to import. */
		const IMPORT_ROW_ID = "__import__";
		/** Per-session pick cache so a popup open does not re-run `/skill list`. */
		const pickCache = new Map();
		const h = react.createElement;

		/** Shared inline styles (theme variables with safe fallbacks). */
		const css = {
			root: { display: "flex", flexDirection: "column", gap: 14, padding: "0 2px 8px" },
			title: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #333)", margin: 0, lineHeight: "24px" },
			sub: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", margin: 0, lineHeight: "18px" },
			importRow: { display: "flex", gap: 8, alignItems: "center" },
			input: { flex: 1, minWidth: 0, height: 32, border: "1px solid var(--dsw-alias-border-l2, #ddd)", borderRadius: 8, background: "var(--dsw-alias-bg-module-platform, #fff)", color: "var(--dsw-alias-label-primary, #333)", padding: "0 10px", fontSize: 13, fontFamily: "inherit", outline: "none" },
			button: { height: 32, border: "1px solid var(--dsw-alias-border-inverted, #ccc)", background: "var(--dsw-alias-interactive-bg-hover, #eee)", color: "var(--dsw-alias-label-primary, #333)", borderRadius: 8, padding: "0 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit", flex: "none" },
			buttonGhost: { height: 26, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "transparent", color: "var(--dsw-alias-label-secondary, #555)", borderRadius: 6, padding: "0 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flex: "none" },
			buttonDanger: { height: 26, border: "1px solid var(--dsw-alias-state-error-primary, #d33)", background: "transparent", color: "var(--dsw-alias-state-error-primary, #d33)", borderRadius: 6, padding: "0 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flex: "none" },
			buttonPrimary: { height: 26, border: "none", background: "var(--dsw-alias-state-ok-primary, #2a7)", color: "#fff", borderRadius: 6, padding: "0 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flex: "none" },
			list: { display: "flex", flexDirection: "column", gap: 8 },
			row: { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--dsw-alias-border-l2, #eee)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1, #fafafa)" },
			rowMain: { flex: 1, minWidth: 0 },
			rowName: { fontSize: 13.5, fontWeight: 500, color: "var(--dsw-alias-label-primary, #333)", display: "flex", alignItems: "center", gap: 8, lineHeight: "20px" },
			badge: { fontSize: 11, borderRadius: 4, padding: "1px 6px", lineHeight: "16px", flex: "none" },
			badgeOn: { background: "var(--dsw-alias-state-ok-primary, #2a7)", color: "#fff" },
			badgeOff: { background: "var(--dsw-alias-state-error-primary, #d33)", color: "#fff" },
			badgeSource: { background: "var(--dsw-alias-interactive-bg-hover, #eee)", color: "var(--dsw-alias-label-secondary, #555)" },
			rowDesc: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", marginTop: 2, lineHeight: "18px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			rowMeta: { fontSize: 11, color: "var(--dsw-alias-label-caption, #aaa)", marginTop: 2, lineHeight: "16px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			rowActions: { display: "flex", gap: 6, flex: "none" },
			error: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #d33)", lineHeight: "18px" },
			ok: { fontSize: 12, color: "var(--dsw-alias-state-ok-primary, #2a7)", lineHeight: "18px" },
			loading: { fontSize: 13, color: "var(--dsw-alias-label-tertiary, #888)", padding: "8px 0" },
			overlay: { position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.4))" },
			modal: { width: 740, maxWidth: "calc(100vw - 48px)", height: "min(720px, calc(100vh - 48px))", display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-layer-2, #fff)", borderRadius: 16, boxShadow: "var(--dsw-shadow-lv3, 0 8px 30px rgba(0,0,0,.2))", overflow: "hidden" },
			modalHeader: { display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--dsw-alias-border-l2, #eee)", flex: "none" },
			modalTitle: { fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary, #333)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			modalMeta: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", flex: "none" },
			pre: { flex: 1, overflow: "auto", margin: 0, padding: 14, fontSize: 12.5, lineHeight: 1.65, color: "var(--dsw-alias-label-primary, #333)", whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--dsw-alias-markdown-code-block, #f7f7f8)", fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace" },
			modalFooter: { display: "flex", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--dsw-alias-border-l2, #eee)", flex: "none" },
			spacer: { flex: 1 }
		};

		/** Read the current pick from the host command result text. */
		function parsePickedNames(text) {
			const picked = new Set();
			for (const line of text.split("\n")) {
				const match = PICKED_LINE.exec(line);
				if (match !== null) picked.add(match[1]);
			}
			return picked;
		}

		/** Load the session's pick (cache hit, or one `/skill list` round-trip). */
		async function pickedFor(remote, sessionId) {
			const cached = pickCache.get(sessionId);
			if (cached !== void 0) return cached;
			const result = await remote.commands.execute(sessionId, "/skill list");
			if (!result.ok || result.value === void 0) return new Set();
			const picked = parsePickedNames(result.value.result?.text ?? "");
			pickCache.set(sessionId, picked);
			return picked;
		}

		/** Build the popup rows: all skills with pick marks, plus the import hint row. */
		async function skillOptions(session, api, remote) {
			const [catalog, picked] = await Promise.all([
				api.skills.list({ sessionId: session.sessionId }),
				pickedFor(remote, session.sessionId)
			]);
			if (!catalog.result.ok) throw new Error(`skill.list failed: ${catalog.result.error.code}: ${catalog.result.error.message}`);
			const rows = catalog.result.value.skills.map((skill) => ({
				id: skill.name,
				label: skill.name,
				detail: skill.description,
				active: picked.has(skill.name)
			}));
			rows.push({
				id: IMPORT_ROW_ID,
				label: "导入 skill",
				detail: "使用 /skill import <路径|URL> 从本地或 URL 导入",
				active: false
			});
			return rows;
		}

		/** Toggle the pick for one row through the host command. */
		async function toggleSkill(remote, session, option) {
			const action = option.active === true ? "unselect" : "select";
			const line = `/skill ${action} ${option.id}`;
			const result = await remote.commands.execute(session.sessionId, line);
			if (!result.ok) throw new Error(`skill ${action} failed: ${result.error.code}: ${result.error.message}`);
			if (result.value === void 0) throw new Error(`unknown or malformed command: ${line}`);
			const cached = pickCache.get(session.sessionId) ?? new Set();
			if (action === "select") cached.add(option.id);
			else cached.delete(option.id);
			pickCache.set(session.sessionId, cached);
		}

		/** POST JSON to one /skill-manage route and unwrap the envelope. */
		async function managePost(route, body) {
			const res = await fetch(`/skill-manage/${route}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			let data;
			try {
				data = await res.json();
			} catch {
				throw new Error(`HTTP ${res.status}`);
			}
			if (!data.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
			return data.value;
		}

		/** GET JSON from one /skill-manage route and unwrap the envelope. */
		async function manageGet(route) {
			const res = await fetch(`/skill-manage/${route}`, { cache: "no-store" });
			let data;
			try {
				data = await res.json();
			} catch {
				throw new Error(`HTTP ${res.status}`);
			}
			if (!data.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
			return data.value;
		}

		/** The Settings → 技能 manager panel. */
		function SkillSection() {
			const [skills, setSkills] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [source, setSource] = react.useState("");
			const [importing, setImporting] = react.useState(false);
			const [importResult, setImportResult] = react.useState(null);
			const [busy, setBusy] = react.useState("");
			const [view, setView] = react.useState(null);

			const load = react.useCallback(async () => {
				try {
					const value = await manageGet("list");
					setSkills(value.skills);
					setError(null);
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			}, []);
			react.useEffect(() => {
				load();
			}, [load]);

			const toggle = async (skill) => {
				setBusy(skill.name);
				try {
					await managePost("toggle", { name: skill.name, enabled: skill.disabled });
					await load();
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy("");
				}
			};

			const remove = async (skill) => {
				if (!window.confirm(`确定删除 skill "${skill.name}" 吗？此操作不可恢复。`)) return;
				setBusy(skill.name);
				try {
					await managePost("remove", { name: skill.name });
					if (view !== null && view.name === skill.name) setView(null);
					await load();
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy("");
				}
			};

			const doImport = async () => {
				const src = source.trim();
				if (src.length === 0) return;
				setImporting(true);
				setImportResult(null);
				try {
					const value = await managePost("import", { source: src });
					setImportResult({ ok: true, text: `已导入 skill "${value.name}"` });
					setSource("");
					await load();
				} catch (e) {
					setImportResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
				} finally {
					setImporting(false);
				}
			};

			const openView = async (skill) => {
				setView({ name: skill.name, loading: true, mode: "original" });
				try {
					const value = await manageGet(`show?name=${encodeURIComponent(skill.name)}`);
					setView({ name: value.name, content: value.content, source: value.source, path: value.path, loading: false, mode: "original" });
				} catch (e) {
					setView({ name: skill.name, loading: false, error: e instanceof Error ? e.message : String(e), mode: "original" });
				}
			};

			const translate = async () => {
				if (view === null || view.translating) return;
				setView({ ...view, translating: true, translateError: null });
				try {
					const value = await managePost("translate", { name: view.name });
					setView({ ...view, translated: value.translated, translating: false, mode: "translated" });
				} catch (e) {
					setView({ ...view, translating: false, translateError: e instanceof Error ? e.message : String(e) });
				}
			};

			return h("div", { style: css.root }, [
				h("div", null, [
					h("p", { style: css.title }, "技能"),
					h("p", { style: css.sub }, "管理可用 skill：查看内容、翻译为中文、禁用/启用、删除与导入。禁用后模型将不再看到该 skill。")
				]),
				h("div", { style: css.importRow }, [
					h("input", {
						style: css.input,
						value: source,
						placeholder: "导入：本地路径或 http(s) URL（如 D:\\skills\\my-skill\\SKILL.md 或 https://…/SKILL.md）",
						onChange: (e) => setSource(e.currentTarget.value),
						onKeyDown: (e) => { if (e.key === "Enter") doImport(); },
						disabled: importing
					}),
					h("button", { style: css.button, onClick: doImport, disabled: importing || source.trim().length === 0 }, importing ? "导入中…" : "导入")
				]),
				importResult !== null ? h("div", { style: importResult.ok ? css.ok : css.error }, importResult.text) : null,
				error !== null ? h("div", { style: css.error }, error) : null,
				skills === null ? h("div", { style: css.loading }, "正在加载…") : skills.length === 0
					? h("div", { style: css.loading }, "当前没有可用 skill。")
					: h("div", { style: css.list }, skills.map((skill) => h("div", { key: skill.name, style: css.row }, [
						h("div", { style: css.rowMain }, [
							h("div", { style: css.rowName }, [
								h("span", null, skill.name),
								h("span", { style: { ...css.badge, ...(skill.disabled ? css.badgeOff : css.badgeOn) } }, skill.disabled ? "已禁用" : "已启用"),
								h("span", { style: { ...css.badge, ...css.badgeSource } }, skill.source)
							]),
							h("div", { style: css.rowDesc }, skill.description),
							skill.path !== void 0 ? h("div", { style: css.rowMeta }, skill.path) : null
						]),
						h("div", { style: css.rowActions }, [
							h("button", { style: css.buttonGhost, onClick: () => openView(skill), disabled: busy === skill.name }, "查看"),
							h("button", { style: skill.disabled ? css.buttonPrimary : css.buttonGhost, onClick: () => toggle(skill), disabled: busy === skill.name }, skill.disabled ? "启用" : "禁用"),
							skill.removable ? h("button", { style: css.buttonDanger, onClick: () => remove(skill), disabled: busy === skill.name }, "删除") : null
						])
					]))),
				view !== null ? h("div", { style: css.overlay, onClick: (e) => { if (e.target === e.currentTarget) setView(null); } }, [
					h("div", { style: css.modal }, [
						h("div", { style: css.modalHeader }, [
							h("span", { style: css.modalTitle }, view.name),
							view.source !== void 0 ? h("span", { style: css.modalMeta }, view.source) : null,
							h("button", { style: css.buttonGhost, onClick: () => setView(null) }, "关闭")
						]),
						view.loading ? h("div", { style: { ...css.loading, padding: 16 } }, "正在加载…")
							: view.error !== void 0 && view.content === void 0 ? h("div", { style: { ...css.error, padding: 16 } }, view.error)
							: h("pre", { style: css.pre }, view.mode === "translated" && view.translated !== void 0 ? view.translated : (view.content ?? "")),
						h("div", { style: css.modalFooter }, [
							h("button", {
								style: css.buttonPrimary,
								onClick: translate,
								disabled: view.translating || view.content === void 0
							}, view.translating ? "翻译中…" : "翻译为中文"),
							view.translated !== void 0 ? h("button", {
								style: css.buttonGhost,
								onClick: () => setView({ ...view, mode: view.mode === "translated" ? "original" : "translated" })
							}, view.mode === "translated" ? "显示原文" : "显示译文") : null,
							view.translateError !== void 0 ? h("span", { style: { ...css.error, flex: 1 } }, view.translateError) : h("span", { style: css.spacer }),
							view.path !== void 0 ? h("span", { style: { ...css.modalMeta, ...css.rowMeta } }, view.path) : null
						])
					])
				]) : null
			]);
		}

		/**
		* Client plugin body: register the Settings → 技能 section and decorate
		* the host `/skill` command with the popup selector.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skills",
				order: 10,
				label: () => "技能"
			}, SkillSection));
			const command = ctx.get("commandUi");
			const sessions = ctx.get("sessions");
			const api = ctx.get("connection").api;
			const remote = ctx.get("remote");
			ctx.effect(() => command.decorate({
				name: "skill",
				available: (session) => sessions.subagentAddress(session.sessionId) === void 0,
				ui: {
					kind: "popupSelect",
					options: (session) => skillOptions(session, api, remote),
					onSelect: async (option, session) => {
						if (option.id === IMPORT_ROW_ID) throw new Error("导入请使用 /skill import <路径|URL>，或在 设置 → 技能 中导入");
						await toggleSkill(remote, session, option);
					}
				}
			}), "command-skill: /skill decoration");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
