// Smoke test for dsh-command-skill host half v2 (management features).
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL("C:/Users/Administrator/Documents/dsh-command-skill/lib/index.js").href);
const { apply } = mod;

let failures = 0;
function check(label, cond) {
	if (cond) console.log(`  ok  ${label}`);
	else { failures += 1; console.log(`FAIL  ${label}`); }
}

const skills = [
	{ name: "vision-tools", description: "Native DSH visual engineering tools: screenshots, OCR, layout analysis.", invocation: { modelInvocable: true, userInvocable: true }, source: "bundled" },
	{ name: "pdf-tools", description: "Extract tables and text from PDF documents.", invocation: { modelInvocable: true, userInvocable: true }, source: "user-dsh" },
	{ name: "git-helper", description: "Git workflow helpers for commit hygiene.", invocation: { modelInvocable: true, userInvocable: true }, source: "user-dsh" }
];

// definitions with real temp-file paths so enable/disable/remove can be exercised
const tmp = await mkdtemp(join(tmpdir(), "skill-mgmt-"));
const visionDir = join(tmp, "vision-tools");
const pdfFile = join(tmp, "pdf-tools.md");
await (await import("node:fs/promises")).mkdir(visionDir, { recursive: true });
const visionPath = join(visionDir, "SKILL.md");
await writeFile(visionPath, [
	"---",
	"name: vision-tools",
	"description: Native DSH visual engineering tools.",
	"---",
	"",
	"# Vision Tools",
	"Use vision_glance to inspect screenshots."
].join("\n"), "utf8");
await writeFile(pdfFile, [
	"---",
	"name: pdf-tools",
	"description: Extract tables from PDFs.",
	"---",
	"",
	"# PDF Tools",
	"Use pdf_to_table."
].join("\n"), "utf8");

const definitions = new Map();
definitions.set("vision-tools", { name: "vision-tools", path: visionPath, source: "bundled", provider: "filesystem", content: "# Vision Tools\nUse vision_glance to inspect screenshots." });
definitions.set("pdf-tools", { name: "pdf-tools", path: pdfFile, source: "user-dsh", provider: "filesystem", content: "# PDF Tools\nUse pdf_to_table." });
definitions.set("git-helper", { name: "git-helper", path: void 0, source: "user-dsh", provider: "filesystem", content: "# Git Helper" });

let registered = null;
const ctx = {
	commands: { register(def) { registered = def; return () => {}; } },
	skills: {
		list: async () => skills,
		get: async (name) => definitions.get(name) ?? (skills.find((s) => s.name === name) ? { ...skills.find((s) => s.name === name), path: void 0 } : void 0)
	},
	get(key) { return this[key]; },
	on() {}
};
const agent = { id: "session-test-1", session: { header: { cwd: process.cwd() }, events: [] } };
apply(ctx);

async function run(line) {
	const invocation = { commandId: "cmd-1", agent, rawInput: line.slice("/skill".length), signal: new AbortController().signal };
	return registered.handler(invocation);
}

// --- 1. show ---
console.log("[1] /skill show");
const show = await run("/skill show vision-tools");
check("show success", show.kind === "success");
check("show includes content", show.text.includes("# Vision Tools"));
check("show includes name", show.text.includes("vision-tools"));

// --- 2. disable via command ---
console.log("[2] /skill disable / enable");
const dis = await run("/skill disable vision-tools");
check("disable success", dis.kind === "success" && dis.text.includes("禁用"));
const disabledRaw = await readFile(visionPath, "utf8");
check("frontmatter has disable fields", disabledRaw.includes("disable-model-invocation: true") && disabledRaw.includes("user-invocable: false"));
check("body preserved", disabledRaw.includes("# Vision Tools"));
const en = await run("/skill enable vision-tools");
check("enable success", en.kind === "success");
const enabledRaw = await readFile(visionPath, "utf8");
check("disable fields removed", !enabledRaw.includes("disable-model-invocation") && !enabledRaw.includes("user-invocable"));
check("body still preserved", enabledRaw.includes("# Vision Tools"));

// --- 3. remove ---
console.log("[3] /skill remove");
const rem = await run("/skill remove pdf-tools");
check("remove success", rem.kind === "success" && rem.text.includes("pdf-tools"));
let pdfGone = true;
try { await readFile(pdfFile, "utf8"); pdfGone = false; } catch {}
check("file deleted", pdfGone);
const remBundled = await run("/skill remove vision-tools");
check("bundled not removable", remBundled.kind === "error" && remBundled.text.includes("不可删除"));

// --- 4. translate without a key → clear error ---
console.log("[4] /skill translate (no key)");
const tr = await run("/skill translate vision-tools");
check("translate errors without key", tr.kind === "error" && tr.text.includes("DEEPSEEK_API_KEY"));

// --- 5. list still works ---
console.log("[5] /skill list");
const list = await run("/skill");
check("list success", list.kind === "success");
check("list rows", (list.text.match(/^[✓·] /gmu) ?? []).length === 3);

// cleanup
await rm(tmp, { recursive: true, force: true });
const prefs = join(process.env.USERPROFILE ?? ".", ".dsh", "skill-prefs.json");
await rm(prefs, { force: true }).catch(() => {});
await rm(join(process.env.USERPROFILE ?? ".", ".dsh", "skills"), { recursive: true, force: true }).catch(() => {});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
