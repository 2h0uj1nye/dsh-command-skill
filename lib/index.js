/**
 * dsh-command-skill — host half.
 *
 * Registers the `/skill` slash command (pick preferred skills, import new
 * skills from a local file/directory or URL, clear the pick) and injects the
 * current pick as a model-facing reminder on every agent pre-step.
 *
 * Also serves the `/skill-manage` HTTP route used by the Settings → 技能 panel:
 * list skills (with enable/disable state), show a skill's full content,
 * toggle enable/disable (edits the skill file's YAML frontmatter), remove a
 * user-level skill, import a new skill, and translate a skill's instructions
 * English → Chinese through the DeepSeek API (DEEPSEEK_API_KEY credential).
 *
 * Semantics are deliberately non-restrictive:
 *  - No pick (default): every skill stays available through the `skill` tool.
 *  - With a pick: the picked skills are prioritized, but skills NOT picked
 *    remain fully callable — the reminder says so explicitly.
 *  - Disabled skills (frontmatter `disable-model-invocation: true` and
 *    `user-invocable: false`) drop out of the model catalog entirely.
 *
 * The pick is stored per session in `~/.dsh/skill-prefs.json` so it survives
 * restarts (session ids are durable). Imports write into `~/.dsh/skills`
 * (user-dsh root, rank 400), which the built-in filesystem skill provider
 * watches and advertises automatically.
 *
 * @module dsh-command-skill
 */
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";

const name = "command-skill";
const inject = ["commands", "skills", "webServer"];

const PLUGIN = "dsh-command-skill";
const PREFERENCE_SOURCE_KIND = "skill-preference";
const PREFS_FILE = "skill-prefs.json";
const SKILLS_USER_ROOT = "skills";
const DESCRIPTION_MAX_LENGTH = 120;
const USAGE = "用法：/skill [list|select <名称…>|unselect <名称…>|clear|import <路径|URL>|show <名称>|disable <名称>|enable <名称>|remove <名称>|translate <名称>]";

/** Skill sources that live in user-writable roots and may be removed. */
const REMOVABLE_SOURCES = new Set(["user-dsh", "user-agents", "project-dsh", "project-agents", "custom"]);
/** Frontmatter fields that disable a skill for both model and user invocation. */
const DISABLE_MODEL_FIELD = "disable-model-invocation";
const DISABLE_USER_FIELD = "user-invocable";
const DISABLE_MODEL_LINE = `${DISABLE_MODEL_FIELD}: true`;
const DISABLE_USER_LINE = `${DISABLE_USER_FIELD}: false`;

/** Parse one `/skill` command line into a closed action. */
function parseSkillCommand(rawInput) {
	const tokens = rawInput.trim().split(/\s+/u).filter((token) => token.length > 0);
	if (tokens.length === 0) return { kind: "list" };
	const [head, ...rest] = tokens;
	switch (head) {
		case "list": return { kind: "list" };
		case "clear": return { kind: "clear" };
		case "select": return { kind: "select", names: rest };
		case "unselect":
		case "deselect": return { kind: "unselect", names: rest };
		case "import": return { kind: "import", target: rest.join(" ") };
		case "show": return { kind: "show", name: rest[0] ?? "" };
		case "disable": return { kind: "disable", name: rest[0] ?? "" };
		case "enable": return { kind: "enable", name: rest[0] ?? "" };
		case "remove":
		case "delete": return { kind: "remove", name: rest[0] ?? "" };
		case "translate": return { kind: "translate", name: rest[0] ?? "" };
		default: return { kind: "select", names: tokens };
	}
}

/** Normalized, length-bounded single-line description (mirrors the tool-skill catalog). */
function catalogDescription(value, maxLength = DESCRIPTION_MAX_LENGTH) {
	const normalized = value.replaceAll(/\s+/gu, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

/** Machine-parseable list line: `✓ name — desc` (picked) / `· name — desc` (available). */
function listLine(selected, skill) {
	return `${selected ? "✓" : "·"} ${skill.name} — ${catalogDescription(skill.description)}`;
}

/** Per-session skill pick, lazily loaded from and atomically persisted to ~/.dsh/skill-prefs.json. */
class PreferenceStore {
	constructor(ctx) {
		this.ctx = ctx;
		this.path = join(resolveDshHome(), PREFS_FILE);
		this.sessions = new Map();
		this.loaded = false;
	}
	async ensure() {
		if (this.loaded) return this.sessions;
		this.sessions = await readPrefsFile(this.path);
		this.loaded = true;
		return this.sessions;
	}
	async selected(sessionId) {
		const sessions = await this.ensure();
		const record = sessions.get(sessionId);
		return record?.selected ?? [];
	}
	async set(sessionId, names) {
		const sessions = await this.ensure();
		if (names.length === 0) {
			sessions.delete(sessionId);
		} else {
			sessions.set(sessionId, { selected: names, updatedAt: Date.now() });
		}
		await writePrefsFile(this.path, sessions);
	}
}

/** Load the prefs map; missing or corrupt files behave as empty. */
async function readPrefsFile(path) {
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return new Map();
		throw error;
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return new Map();
	}
	if (typeof data !== "object" || data === null || typeof data.sessions !== "object" || data.sessions === null) return new Map();
	const sessions = new Map();
	for (const [sessionId, record] of Object.entries(data.sessions)) {
		if (typeof record !== "object" || record === null) continue;
		const selected = record.selected;
		if (!Array.isArray(selected) || selected.some((item) => typeof item !== "string")) continue;
		sessions.set(sessionId, { selected, updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0 });
	}
	return sessions;
}

/** Atomic write: temp file + rename, so a crash never leaves a truncated prefs file. */
async function writePrefsFile(path, sessions) {
	const serialized = JSON.stringify({ sessions: Object.fromEntries(sessions.entries()) }, null, 2);
	const temp = `${path}.tmp`;
	await writeFile(temp, serialized, "utf8");
	try {
		await rename(temp, path);
	} catch (error) {
		// Windows rename onto an existing file can fail; fall back to plain write.
		if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "EPERM")) throw error;
		await writeFile(path, serialized, "utf8");
	}
}

/** Latest skill-preference names recorded in the session log, or null when none. */
function preferenceHistory(agent) {
	const events = agent.session.events;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type !== "user/message") continue;
		const source = event.data?.source;
		if (source?.kind !== PREFERENCE_SOURCE_KIND) continue;
		const names = source.names;
		if (!Array.isArray(names) || names.some((item) => typeof item !== "string")) continue;
		return names;
	}
	return null;
}

/** Model-facing reminder: picked skills are prioritized; everything else stays callable. */
function createPreferenceMessage(names) {
	return createUserMessage({
		content: [{
			type: "text",
			text: [
				"<system-reminder>",
				`The user has selected these skills as preferred in this session: ${names.join(", ")}.`,
				"Prioritize loading and following these skills when they match the task.",
				"Skills not listed here remain available — call the `skill` tool with their exact names whenever the task calls for them.",
				"</system-reminder>"
			].join("\n")
		}],
		source: {
			kind: PREFERENCE_SOURCE_KIND,
			form: "preference",
			names
		}
	});
}

/** Render the full `/skill` listing with the machine-parseable ✓/· rows. */
async function renderList(ctx, agent, lookup, store) {
	const summaries = await ctx.skills.list(lookup);
	const selected = await store.selected(agent.id);
	const rows = summaries
		.map((skill) => ({ skill, selected: selected.includes(skill.name) }))
		.sort((left, right) => Number(right.selected) - Number(left.selected) || left.skill.name.localeCompare(right.skill.name));
	const lines = [
		`Skill 偏好：已选择 ${selected.length}/${summaries.length}${selected.length > 0 ? `（${selected.join("、")}）` : ""}`,
		USAGE,
		"",
		...rows.map(({ skill, selected: isSelected }) => listLine(isSelected, skill))
	];
	if (rows.length === 0) lines.push("（当前没有可用 skill。导入：/skill import <路径|URL>）");
	return { kind: "success", text: lines.join("\n") };
}

/** Add names to the session pick; unknown names are reported without touching the pick. */
async function selectSkills(ctx, agent, lookup, store, names) {
	if (names.length === 0) return { kind: "error", text: `需要指定要选择的 skill 名称。${USAGE}` };
	const summaries = await ctx.skills.list(lookup);
	const byName = new Map(summaries.map((skill) => [skill.name, skill]));
	const unknown = names.filter((item) => !isSkillName(item) || !byName.has(item));
	if (unknown.length > 0) {
		return { kind: "error", text: `未知的 skill：${unknown.join("、")}。可用 /skill list 查看全部。` };
	}
	const current = await store.selected(agent.id);
	const merged = [...current];
	for (const item of names) if (!merged.includes(item)) merged.push(item);
	await store.set(agent.id, merged);
	return { kind: "success", text: `已选择 ${names.length} 个 skill：${names.join("、")}\n模型会优先使用这些 skill；未选择的 skill 仍可正常调用。` };
}

/** Remove names from the session pick. */
async function unselectSkills(agent, store, names) {
	if (names.length === 0) return { kind: "error", text: `需要指定要取消选择的 skill 名称。${USAGE}` };
	const current = await store.selected(agent.id);
	const remaining = current.filter((item) => !names.includes(item));
	await store.set(agent.id, remaining);
	const removed = current.filter((item) => names.includes(item));
	return {
		kind: "success",
		text: removed.length === 0
			? "这些 skill 本来就没有被选择。"
			: `已取消选择：${removed.join("、")}。它们仍可被模型按需调用。`
	};
}

/** Parse the YAML frontmatter of a skill markdown file (name + description are required). */
function parseFrontmatter(raw) {
	const firstLineEnd = raw.indexOf("\n");
	if (firstLineEnd < 0) return void 0;
	if (raw.slice(0, firstLineEnd).replace(/\r$/u, "") !== "---") return void 0;
	const start = firstLineEnd + 1;
	let lineStart = start;
	while (lineStart <= raw.length) {
		const nextNewline = raw.indexOf("\n", lineStart);
		const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/u, "") === "---") {
			return {
				yaml: raw.slice(start, lineStart),
				bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1
			};
		}
		if (nextNewline < 0) return void 0;
		lineStart = nextNewline + 1;
	}
	return void 0;
}

/** Line-level YAML field reader (unquotes simple quoted values). */
function yamlField(yaml, key) {
	const match = yaml.match(new RegExp(`^${key}:\\s*(.*)$`, "mu"));
	if (match === null) return void 0;
	let value = match[1].trim();
	if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
		value = value.slice(1, -1);
	}
	return value.length === 0 ? void 0 : value;
}

/** Validate a skill markdown payload and return its canonical name. */
function skillNameOf(raw, subject) {
	const frontmatter = parseFrontmatter(raw);
	if (frontmatter === void 0) throw new Error(`${subject} 缺少 YAML frontmatter（文件必须以 "---" 开头）`);
	const skillName = yamlField(frontmatter.yaml, "name");
	const description = yamlField(frontmatter.yaml, "description");
	if (skillName === void 0 || description === void 0) throw new Error(`${subject} 的 frontmatter 必须包含 name 和 description`);
	if (!isSkillName(skillName)) throw new Error(`${subject} 的 name "${skillName}" 不是合法的 skill 名称（小写字母/数字/连字符）`);
	return skillName;
}

/** Resolve a local import target against a base directory. */
function resolveLocalTarget(target, cwd) {
	if (isAbsolute(target)) return target;
	return join(cwd ?? process.cwd(), target);
}

/** Import one skill from a local file/directory or an http(s) URL into ~/.dsh/skills. Returns the skill name. */
async function importSkillFromSource(target, cwd) {
	const trimmed = target.trim();
	if (trimmed.length === 0) throw new Error(`需要指定导入来源：本地路径或 URL。${USAGE}`);
	const userRoot = join(resolveDshHome(), SKILLS_USER_ROOT);
	await mkdir(userRoot, { recursive: true });
	const isUrl = /^https?:\/\//iu.test(trimmed);
	let skillName;
	if (isUrl) {
		let response;
		try {
			response = await fetch(trimmed, { signal: downloadSignal() });
		} catch (error) {
			throw new Error(`下载失败：${errorMessage(error)}`);
		}
		if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
		const raw = await response.text();
		skillName = skillNameOf(raw, `URL ${trimmed}`);
		const directory = join(userRoot, skillName);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "SKILL.md"), raw, "utf8");
	} else {
		const localPath = resolveLocalTarget(trimmed, cwd);
		let targetStat;
		try {
			targetStat = await stat(localPath);
		} catch (error) {
			throw new Error(`无法读取 ${localPath}：${errorMessage(error)}`);
		}
		if (targetStat.isDirectory()) {
			const skillFile = join(localPath, "SKILL.md");
			let raw;
			try {
				raw = await readFile(skillFile, "utf8");
			} catch (error) {
				throw new Error(`目录 ${localPath} 缺少 SKILL.md：${errorMessage(error)}`);
			}
			skillName = skillNameOf(raw, `目录 ${localPath}`);
			const directory = join(userRoot, skillName);
			await cp(localPath, directory, { recursive: true, force: true });
		} else {
			let raw;
			try {
				raw = await readFile(localPath, "utf8");
			} catch (error) {
				throw new Error(`无法读取 ${localPath}：${errorMessage(error)}`);
			}
			skillName = skillNameOf(raw, `文件 ${localPath}`);
			const directory = join(userRoot, skillName);
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "SKILL.md"), raw, "utf8");
		}
	}
	return skillName;
}

/** Download timeout signal so a hung URL cannot stall forever. */
function downloadSignal() {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	timer.unref?.();
	return controller.signal;
}

/** Whether a skill definition lives in a removable (user-owned) root. */
function isRemovable(definition) {
	return definition?.source !== void 0 && REMOVABLE_SOURCES.has(definition.source);
}

/** Delete a skill's file or its bundle directory. */
async function removeSkillAt(definition) {
	const path = definition.path;
	if (path === void 0) throw new Error(`skill "${definition.name}" 没有本地文件，无法删除`);
	if (basename(path).toLowerCase() === "skill.md") {
		const directory = dirname(path);
		if (basename(directory) === definition.name) {
			await rm(directory, { recursive: true, force: true });
			return;
		}
	}
	await rm(path, { force: true });
}

/** Rewrite a skill markdown body with the invocation fields set (enabled) or unset (disabled). */
function setSkillEnabledInMarkdown(raw, enabled) {
	const frontmatter = parseFrontmatter(raw);
	if (frontmatter === void 0) throw new Error("该 skill 文件缺少 YAML frontmatter，无法修改");
	let yaml = frontmatter.yaml
		.replace(new RegExp(`^${DISABLE_MODEL_FIELD}:.*$`, "gmu"), "")
		.replace(new RegExp(`^${DISABLE_USER_FIELD}:.*$`, "gmu"), "")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
	if (!enabled) {
		yaml = `${yaml}\n${DISABLE_MODEL_LINE}\n${DISABLE_USER_LINE}`;
	}
	return `---\n${yaml}\n---\n${raw.slice(frontmatter.bodyStart)}`;
}

/** Toggle enable/disable for a skill by editing its local file's frontmatter. */
async function setSkillEnabled(definition, enabled) {
	if (definition.path === void 0) throw new Error(`skill "${definition.name}" 没有可编辑的本地文件`);
	const raw = await readFile(definition.path, "utf8");
	const next = setSkillEnabledInMarkdown(raw, enabled);
	await writeFile(definition.path, next, "utf8");
	return enabled;
}

/** Resolve the DeepSeek API key through the credential seam, then the launch environment. */
async function resolveDeepSeekKey(ctx) {
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		const hit = await credentials.resolve("DEEPSEEK_API_KEY");
		if (hit !== void 0 && hit.value.length > 0) return hit.value;
	}
	try {
		const ambient = launchEnvironmentOf(ctx).get("DEEPSEEK_API_KEY");
		if (ambient !== void 0 && ambient.value.length > 0) return ambient.value;
	} catch {}
	return void 0;
}

/** Translate a skill's instructions English → Chinese through the DeepSeek chat API. */
async function translateSkillContent(ctx, content, signal) {
	const apiKey = await resolveDeepSeekKey(ctx);
	if (apiKey === void 0) {
		throw new Error("未找到 DEEPSEEK_API_KEY：请在凭据（Credentials）中配置 DEEPSEEK_API_KEY 后重试");
	}
	const bounded = content.length > 6000 ? `${content.slice(0, 6000)}\n…（已截断）` : content;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	timer.unref?.();
	const abort = controller.signal;
	if (signal !== void 0) signal.addEventListener("abort", () => controller.abort(), { once: true });
	let response;
	try {
		response = await fetch("https://api.deepseek.com/chat/completions", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: "deepseek-chat",
				temperature: 0.2,
				max_tokens: 3000,
				messages: [
					{
						role: "system",
						content: "You are a professional technical translator. Translate the skill instructions from English to Simplified Chinese. Keep code blocks, file paths, command names, skill names, and technical identifiers unchanged. Output only the translated text with no preamble."
					},
					{ role: "user", content: bounded }
				]
			}),
			signal: abort
		});
	} catch (error) {
		throw new Error(`翻译请求失败：${errorMessage(error)}`);
	} finally {
		clearTimeout(timer);
	}
	let data;
	try {
		data = await response.json();
	} catch {
		throw new Error(`翻译失败：响应不是有效 JSON（HTTP ${response.status}）`);
	}
	if (!response.ok) {
		throw new Error(`翻译失败：HTTP ${response.status} ${data?.error?.message ?? ""}`.trim());
	}
	const translated = data?.choices?.[0]?.message?.content;
	if (typeof translated !== "string" || translated.length === 0) {
		throw new Error("翻译失败：模型未返回内容");
	}
	return translated;
}

/** Full management row for one skill (used by the settings panel). */
async function skillRow(ctx, summary) {
	const definition = await ctx.skills.get(summary.name, {});
	return {
		name: summary.name,
		description: summary.description,
		whenToUse: summary.whenToUse,
		source: summary.source,
		invocation: summary.invocation,
		disabled: summary.invocation.modelInvocable === false || summary.invocation.userInvocable === false,
		path: definition?.path,
		removable: isRemovable(definition)
	};
}

/** Execute one parsed /skill command through the domain that owns persistence. */
async function executeSkillCommand(ctx, store, invocation) {
	const parsed = parseSkillCommand(invocation.rawInput);
	const agent = invocation.agent;
	const lookup = {
		cwd: agent.session.header.cwd,
		signal: invocation.signal,
		scope: agent
	};
	try {
		switch (parsed.kind) {
			case "list": return await renderList(ctx, agent, lookup, store);
			case "select": return await selectSkills(ctx, agent, lookup, store, parsed.names);
			case "unselect": return await unselectSkills(agent, store, parsed.names);
			case "clear":
				await store.set(agent.id, []);
				return { kind: "success", text: "已清空 skill 选择。模型将按需使用所有可用 skill。" };
			case "import": {
				const skillName = await importSkillFromSource(parsed.target, agent.session.header.cwd);
				return {
					kind: "success",
					text: `已导入 skill "${skillName}" → ~/.dsh/skills/${skillName}/SKILL.md\n现在可用 /skill select ${skillName} 选择它，或直接使用。`
				};
			}
			case "show": {
				if (!isSkillName(parsed.name)) return { kind: "error", text: `未知的 skill：${parsed.name}` };
				const definition = await ctx.skills.get(parsed.name, lookup);
				if (definition === void 0) return { kind: "error", text: `未知的 skill：${parsed.name}` };
				return {
					kind: "success",
					text: [
						`# ${definition.name}`,
						`来源：${definition.source} · 提供者：${definition.provider}`,
						definition.path !== void 0 ? `路径：${definition.path}` : "",
						"",
						definition.content
					].join("\n")
				};
			}
			case "disable":
			case "enable": {
				if (!isSkillName(parsed.name)) return { kind: "error", text: `未知的 skill：${parsed.name}` };
				const definition = await ctx.skills.get(parsed.name, lookup);
				if (definition === void 0) return { kind: "error", text: `未知的 skill：${parsed.name}` };
				const enabled = parsed.kind === "enable";
				try {
					await setSkillEnabled(definition, enabled);
				} catch (error) {
					return { kind: "error", text: errorMessage(error) };
				}
				return { kind: "success", text: `已${enabled ? "启用" : "禁用"} skill "${parsed.name}"。${enabled ? "" : "模型将不再看到和调用它。"}` };
			}
			case "remove": {
				if (!isSkillName(parsed.name)) return { kind: "error", text: `未知的 skill：${parsed.name}` };
				const definition = await ctx.skills.get(parsed.name, lookup);
				if (definition === void 0) return { kind: "error", text: `未知的 skill：${parsed.name}` };
				if (!isRemovable(definition)) return { kind: "error", text: `skill "${parsed.name}" 来自 ${definition.source}，不可删除（内置 skill 只能禁用）。` };
				await removeSkillAt(definition);
				return { kind: "success", text: `已删除 skill "${parsed.name}"。` };
			}
			case "translate": {
				if (!isSkillName(parsed.name)) return { kind: "error", text: `未知的 skill：${parsed.name}` };
				const definition = await ctx.skills.get(parsed.name, lookup);
				if (definition === void 0) return { kind: "error", text: `未知的 skill：${parsed.name}` };
				const translated = await translateSkillContent(ctx, definition.content, invocation.signal);
				return { kind: "success", text: `【${definition.name} 中文翻译】\n\n${translated}` };
			}
			/* v8 ignore next -- SkillCommand is closed; every member is handled above. */
			default: return { kind: "error", text: `未知操作。${USAGE}` };
		}
	} catch (error) {
		return { kind: "error", text: errorMessage(error) };
	}
}

/** Read a JSON request body up to a byte cap; null when unparseable or oversized. */
async function readJsonBody(req, cap) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		chunks.push(buffer);
		total += buffer.length;
		if (total > cap) return null;
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Write one JSON envelope response. */
function json(res, envelope, status = 200) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(envelope));
}

/** Register the /skill-manage HTTP routes backing the Settings → 技能 panel. */
function registerManageRoutes(ctx) {
	const webServer = ctx.webServer;
	if (webServer === void 0) return;
	webServer.register({
		kind: "prefix",
		path: "/skill-manage",
		handler: async (req, res) => {
			const pathname = new URL(req.url ?? "/", "http://x").pathname;
			try {
				if (req.method === "GET" && pathname === "/skill-manage/list") {
					const summaries = await ctx.skills.list({});
					const rows = [];
					for (const summary of summaries) rows.push(await skillRow(ctx, summary));
					rows.sort((a, b) => a.name.localeCompare(b.name));
					json(res, { ok: true, value: { skills: rows } });
					return;
				}
				if (req.method === "GET" && pathname === "/skill-manage/show") {
					const name = new URL(req.url ?? "/", "http://x").searchParams.get("name") ?? "";
					if (!isSkillName(name)) {
						json(res, { ok: false, error: { code: "rejected", message: `invalid skill name "${name}"` } }, 400);
						return;
					}
					const definition = await ctx.skills.get(name, {});
					if (definition === void 0) {
						json(res, { ok: false, error: { code: "rejected", message: `skill "${name}" is unknown` } }, 404);
						return;
					}
					json(res, { ok: true, value: { name: definition.name, description: definition.description, source: definition.source, path: definition.path, content: definition.content } });
					return;
				}
				if (req.method === "POST" && pathname === "/skill-manage/toggle") {
					const body = await readJsonBody(req, 64 * 1024);
					const name = body?.name;
					const enabled = body?.enabled;
					if (typeof name !== "string" || !isSkillName(name) || typeof enabled !== "boolean") {
						json(res, { ok: false, error: { code: "rejected", message: "body must be { name, enabled }" } }, 400);
						return;
					}
					const definition = await ctx.skills.get(name, {});
					if (definition === void 0) {
						json(res, { ok: false, error: { code: "rejected", message: `skill "${name}" is unknown` } }, 404);
						return;
					}
					await setSkillEnabled(definition, enabled);
					json(res, { ok: true, value: { name, enabled } });
					return;
				}
				if (req.method === "POST" && pathname === "/skill-manage/remove") {
					const body = await readJsonBody(req, 64 * 1024);
					const name = body?.name;
					if (typeof name !== "string" || !isSkillName(name)) {
						json(res, { ok: false, error: { code: "rejected", message: "body must be { name }" } }, 400);
						return;
					}
					const definition = await ctx.skills.get(name, {});
					if (definition === void 0) {
						json(res, { ok: false, error: { code: "rejected", message: `skill "${name}" is unknown` } }, 404);
						return;
					}
					if (!isRemovable(definition)) {
						json(res, { ok: false, error: { code: "rejected", message: `skill "${name}" (${definition.source}) is not removable` } }, 422);
						return;
					}
					await removeSkillAt(definition);
					json(res, { ok: true, value: { name } });
					return;
				}
				if (req.method === "POST" && pathname === "/skill-manage/import") {
					const body = await readJsonBody(req, 64 * 1024);
					const source = body?.source;
					if (typeof source !== "string" || source.trim().length === 0) {
						json(res, { ok: false, error: { code: "rejected", message: "body must be { source }" } }, 400);
						return;
					}
					const skillName = await importSkillFromSource(source, process.cwd());
					json(res, { ok: true, value: { name: skillName } });
					return;
				}
				if (req.method === "POST" && pathname === "/skill-manage/translate") {
					const body = await readJsonBody(req, 64 * 1024);
					const name = body?.name;
					if (typeof name !== "string" || !isSkillName(name)) {
						json(res, { ok: false, error: { code: "rejected", message: "body must be { name }" } }, 400);
						return;
					}
					const definition = await ctx.skills.get(name, {});
					if (definition === void 0) {
						json(res, { ok: false, error: { code: "rejected", message: `skill "${name}" is unknown` } }, 404);
						return;
					}
					const translated = await translateSkillContent(ctx, definition.content, void 0);
					json(res, { ok: true, value: { name, translated } });
					return;
				}
				json(res, { ok: false, error: { code: "rejected", message: `unknown route ${pathname}` } }, 404);
			} catch (error) {
				json(res, { ok: false, error: { code: "internal", message: errorMessage(error) } }, 500);
			}
		}
	});
}

/** Register the `/skill` command, the preference injection, and the manage routes. */
function apply(ctx) {
	// The web profile disables the host-level skill-filesystem row (presets own
	// local discovery), so `ctx.skills.list({})` from this plugin — the
	// Settings → 技能 panel — would only see runtime skills. Register our own
	// host-level filesystem provider so the panel lists every user skill.
	try {
		ctx.skills.registerProvider((control) => new FileSystemSkillProvider(ctx, control, {}));
	} catch (error) {
		ctx.logger?.warn?.(`command-skill: host skill-filesystem provider failed: ${errorMessage(error)}`);
	}
	const store = new PreferenceStore(ctx);
	ctx.commands.register({
		name: "skill",
		description: "选择/导入/管理会话使用的 skill",
		input: { hint: "[list|select <名称…>|unselect <名称…>|clear|import <路径|URL>|show|disable|enable|remove|translate]" },
		handler: (invocation) => executeSkillCommand(ctx, store, invocation)
	});
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject") return decision;
		signal.throwIfAborted();
		const selected = await store.selected(agent.id);
		if (selected.length === 0) return decision;
		const history = preferenceHistory(agent);
		if (history !== null && sameNames(history, selected)) return decision;
		signal.throwIfAborted();
		return {
			kind: "enter",
			messages: [...decision.messages, createPreferenceMessage(selected)]
		};
	});
	registerManageRoutes(ctx);
}

/** Order-insensitive name-set comparison for the injection dedup. */
function sameNames(left, right) {
	if (left.length !== right.length) return false;
	const set = new Set(left);
	for (const item of right) if (!set.has(item)) return false;
	return true;
}

function hasErrorCode(error, code) {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error) {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return "<unrenderable thrown value>";
	}
}

export { apply, inject, name };
