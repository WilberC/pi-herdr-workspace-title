// @ts-nocheck
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Herdr Workspace Title Extension for Pi / Gentle Shell
 *
 * Names the herdr workspace once per session with a short title from the
 * user's first real request ("Fix login redirect loop"), shown by the
 * herdr-sidecar dock under the agent name.
 *
 * Adapted from RamonsDka/gs3-sidebar's extensions/herdr-workspace-title.ts
 * (the reference this feature follows), with one deliberate change: the title
 * is applied through `herdr workspace report-metadata` (display-only token
 * `title`, source `herdr-utils`) instead of `workspace rename` — the label a
 * user may rename stays untouched, and both herdr's tokens and the dock read
 * the result.
 *
 * Rules:
 * - Only acts inside herdr (HERDR_ENV=1 + HERDR_WORKSPACE_ID).
 * - One title per workspace: a workspace that already carries the title
 *   token (or a custom_name in herdr's session.json) is skipped.
 * - A name the user set by hand always wins: a live label that differs from
 *   the one herdr derives from the workspace cwd skips the workspace
 *   (fail closed — when in doubt, do not touch).
 * - The title is redacted by the session's active model with one short
 *   isolated call; on failure (no auth, timeout, empty reply) a local
 *   heuristic takes over.
 * - Runs in the background and never delays the agent's turn; a failed
 *   apply retries on the next eligible prompt.
 * - Uses HERDR_BIN_PATH, falling back to `herdr` on PATH.
 */

const MAX_TITLE_CHARS = 34;
const MIN_PROMPT_CHARS = 12;
const MODEL_TIMEOUT_MS = 15000;
const TITLE_SOURCE = "herdr-utils";

const TITLE_SYSTEM_PROMPT = [
	"You name terminal workspaces for a developer.",
	"The user gives you the first request of a work session.",
	"Reply with ONLY a short title for that session: 2 to 5 words, at most 32 characters.",
	"Write the title in the same language as the request, describing the task, not the tool chatter.",
	"Keep the language's own diacritics: in Spanish write 'Título', never 'Titulo'.",
	"No quotes, no emojis, no trailing period, no prefixes like 'Title:' or 'Workspace:'.",
	"Examples:",
	"request: 'necesito que en herdr el titulo del espacio se ponga solo' -> Editar titulos de herdr",
	"request: 'fix the login redirect loop in the auth middleware' -> Fix login redirect loop",
].join("\n");

const STOPWORDS = new Set([
	// es
	"para", "porque", "cuando", "donde", "como", "quiero", "necesito", "hacer", "hacerlo", "tengo",
	"sobre", "desde", "hasta", "entre", "pero", "este", "esta", "esto", "estos", "estas", "esos",
	"esas", "aquel", "aquella", "tambien", "solo", "sola", "cosas", "cosa", "algo", "algun", "alguna",
	"que", "con", "sin", "los", "las", "una", "uno", "unos", "unas", "del", "mas", "muy", "hay",
	"seria", "pueda", "puedas", "puedo", "deberia", "quisiera", "ademas", "entonces", "ahora",
	"favor", "ayuda", "podrias", "gustaria", "seccion", "espacio",
	// en
	"the", "and", "for", "with", "that", "this", "these", "those", "from", "into", "want", "need",
	"please", "should", "would", "could", "have", "has", "you", "your", "our", "its", "add", "make",
]);

function getWorkspaceId(): string | undefined {
	return process.env.HERDR_WORKSPACE_ID?.trim();
}

function getHerdrBin(): string {
	return process.env.HERDR_BIN_PATH ?? "herdr";
}

function getHerdrSessionFile(): string {
	return herdrSessionFile(process.env.HERDR_SESSION_FILE, process.env.HERDR_SESSION, fs.existsSync);
}

/** Resolves the session file herdr persists the workspace list in: an explicit
 * HERDR_SESSION_FILE always wins; otherwise the per-session file
 * sessions/<name>/session.json when the session has one — herdr stores the
 * active session there (HERDR_SESSION names it) — and the legacy top-level
 * session.json only as the last fallback. */
export function herdrSessionFile(
	override: string | undefined,
	sessionName: string | undefined,
	exists: (path: string) => boolean,
): string {
	if (override && override.trim().length > 0) return override;
	if (sessionName && sessionName.trim().length > 0) {
		const perSession = path.join(
			os.homedir(), ".config", "herdr", "sessions", sessionName.trim(), "session.json",
		);
		if (exists(perSession)) return perSession;
	}
	return path.join(os.homedir(), ".config", "herdr", "session.json");
}

function log(message: string): void {
	if (process.env.HERDR_TITLE_DEBUG !== "1") return;
	try {
		fs.appendFileSync(path.join(os.tmpdir(), "herdr-workspace-title.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {}
}

export function sanitizeTitle(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") return null;
	const line = raw
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	if (!line) return null;

	const title = line
		.replace(/^[#>*\-\s]+/, "")
		.replace(/^(?:t[ií]tulo|title|nombre|name|workspace|espacio|secci[oó]n)\s*[:=\-–]\s*/i, "")
		.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s]+/u, "")
		.replace(/["'`“”‘’«»]/g, "")
		.replace(/\s+/g, " ")
		.replace(/[.,;:!?¿¡、。]+$/u, "")
		.trim();
	if (!title) return null;

	if (title.length <= MAX_TITLE_CHARS) return title;

	const clipped = title.slice(0, MAX_TITLE_CHARS + 1);
	const lastSpace = clipped.lastIndexOf(" ");
	return (lastSpace > 10 ? clipped.slice(0, lastSpace) : title.slice(0, MAX_TITLE_CHARS)).trim();
}

export function heuristicTitle(prompt: string | null | undefined): string | null {
	if (typeof prompt !== "string") return null;
	const text = prompt
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return null;

	const words = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word));
	if (words.length === 0) return null;

	return sanitizeTitle(words.slice(0, 4).join(" "));
}

function readWorkspaceEntry(): { custom_name?: string | null; identity_cwd?: string | null } | null {
	const wsId = getWorkspaceId();
	if (!wsId) return null;
	try {
		const raw = fs.readFileSync(getHerdrSessionFile(), "utf-8");
		const data = JSON.parse(raw);
		if (!Array.isArray(data?.workspaces)) return null;
		const workspace = data.workspaces.find((entry: any) => entry?.id === wsId);
		if (!workspace || typeof workspace !== "object") return null;
		return workspace;
	} catch {
		return null;
	}
}

function readIdentityCwd(): string | null {
	const entry = readWorkspaceEntry();
	const cwd = entry?.identity_cwd;
	return typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
}

/** The label herdr would derive from the workspace cwd alone ("~" for $HOME). */
export function autoLabelFor(identityCwd: string | null | undefined): string | null {
	if (typeof identityCwd !== "string" || identityCwd.trim().length === 0) return null;
	const cleaned = identityCwd.replace(/[\\/]+$/, "");
	if (cleaned === os.homedir().replace(/[\\/]+$/, "")) return "~";
	const base = path.basename(cleaned);
	return base.length > 0 ? base : null;
}

function workspaceJSON(wsId: string, timeoutMs: number): Promise<any | null> {
	return new Promise((resolve) => {
		execFile(getHerdrBin(), ["workspace", "get", wsId], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
			if (error) {
				resolve(null);
				return;
			}
			try {
				const parsed = JSON.parse(stdout);
				if (!parsed?.result?.workspace) {
					resolve(null);
					return;
				}
				resolve(parsed.result.workspace);
			} catch {
				resolve(null);
			}
		});
	});
}

/**
 * Decide whether the workspace is still free for automatic titling.
 *
 * Conservative on purpose: when in doubt, do not touch (fail closed) —
 * overwriting a hand-set name is far worse than leaving a workspace untitled.
 * Fails closed when the session file cannot be read, the cwd is unknown, or
 * the herdr query fails or answers malformed/empty JSON.
 */
export async function shouldAutoTitle(): Promise<boolean> {
	const wsId = getWorkspaceId();
	if (!wsId) return false;

	const entry = readWorkspaceEntry();
	if (!entry) {
		log(`skip: session file unreadable or workspace ${wsId} not found in session`);
		return false;
	}
	if (typeof entry.custom_name === "string" && entry.custom_name.trim().length > 0) {
		log(`skip: ${wsId} carries a custom_name in the session`);
		return false;
	}

	const live = await workspaceJSON(wsId, 2000);
	if (!live) {
		log(`skip: workspace get failed or malformed for ${wsId}`);
		return false;
	}
	const tokens = live.tokens ?? {};
	if (typeof tokens.title === "string" && tokens.title.trim().length > 0) {
		log(`skip: ${wsId} already carries the title token`);
		return false;
	}

	const label = typeof live.label === "string" ? live.label.trim() : "";
	const autoLabel = autoLabelFor(readIdentityCwd());
	if (!autoLabel) {
		log(`skip: cannot determine auto-label for cwd "${readIdentityCwd()}"`);
		return false;
	}
	if (label !== autoLabel) {
		log(`skip: ${wsId} carries its own label "${label}"`);
		return false;
	}

	return true;
}

async function generateTitle(prompt: string, ctx: ExtensionContext): Promise<string | null> {
	const model = ctx?.model;
	const registry: any = ctx?.modelRegistry;
	if (!model || typeof registry?.complete !== "function") return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
	try {
		const reply = await registry.complete(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: prompt.slice(0, 2000), timestamp: Date.now() }],
			},
			{ maxTokens: 40, temperature: 0, signal: controller.signal },
		);
		const text = (reply?.content ?? [])
			.filter((part: any) => part?.type === "text")
			.map((part: any) => part?.text ?? "")
			.join(" ");
		return sanitizeTitle(text);
	} catch (error) {
		log(`nested model call failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Applies the display-only title token; the workspace label stays untouched. */
function applyTitle(title: string): Promise<boolean> {
	const wsId = getWorkspaceId();
	if (!wsId) return Promise.resolve(false);
	return new Promise((resolve) => {
		execFile(
			getHerdrBin(),
			["workspace", "report-metadata", wsId, "--source", TITLE_SOURCE, "--token", `title=${title}`],
			{ timeout: 3000, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					log(`apply failed: ${error.message} ${stdout ?? ""} ${stderr ?? ""}`);
					resolve(false);
					return;
				}
				log(`applied ${wsId} -> "${title}"`);
				resolve(true);
			},
		);
	});
}

function enabled(): boolean {
	return (
		process.env.HERDR_TITLE_DISABLE !== "1" &&
		process.env.HERDR_ENV === "1" &&
		typeof getWorkspaceId() === "string" &&
		getWorkspaceId()!.length > 0
	);
}

/** The persisted toggle's state file, beside Pi's other extension state. */
function toggleFile(): string {
	const base = process.env.PI_HERDR_TITLE_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "pi-herdr-workspace-title");
	return path.join(base, "state.json");
}

/** Persisted user preference: "on" (default) or "off". The HERDR_TITLE_DISABLE
 * env var still wins over both, as the documented hard switch. */
function readToggle(): boolean {
	try {
		const data = JSON.parse(fs.readFileSync(toggleFile(), "utf-8"));
		return data?.enabled !== false;
	} catch {
		return true; // default on; unreadable state is not an opt-out
	}
}

function writeToggle(on: boolean): void {
	try {
		fs.mkdirSync(path.dirname(toggleFile()), { recursive: true });
		fs.writeFileSync(toggleFile(), JSON.stringify({ enabled: on }, null, "\t") + "\n");
	} catch (error) {
		log(`toggle write failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The control surface: /workspace-title on|off|status, persisted like
 * message-frames does. `off` stops new titling immediately; it never clears
 * a title already applied. */
function registerCommand(pi: ExtensionAPI): void {
	try {
		pi.registerCommand("workspace-title", {
			description: "Auto-title the herdr workspace from the session's first real request",
			handler: async (args: string[]) => {
					const arg = (args[0] ?? "status").toLowerCase();
				if (arg === "on" || arg === "off") {
					writeToggle(arg === "on");
				return `workspace-title: ${arg === "on" ? "enabled" : "disabled"} (persisted; HERDR_TITLE_DISABLE=1 still wins)`;
				}
				if (arg === "status") {
					const envOn = process.env.HERDR_TITLE_DISABLE !== "1";
				const inHerdr = process.env.HERDR_ENV === "1" && !!getWorkspaceId();
				const parts = [
					`toggle: ${readToggle() ? "on" : "off"}`,
				`env: ${envOn ? "enabled" : "HERDR_TITLE_DISABLE=1"}`,
				`herdr: ${inHerdr ? getWorkspaceId() : "not inside herdr"}`,
				];
				return `workspace-title: ${parts.join(" · ")}`;
				}
					return "Usage: /workspace-title on|off|status";
				},
		});
	} catch (error) {
		log(`command registration failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

let lastTask: Promise<void> | null = null;

export function getLastTask(): Promise<void> | null {
	return lastTask;
}

export default function initHerdrWorkspaceTitle(pi: ExtensionAPI): void {
	registerCommand(pi);
	if (!enabled() || !readToggle()) return;

	let handled = false;
	let inFlight = false;

	pi.on("before_agent_start", (event: any, ctx: ExtensionContext) => {
		if (event?.messageType !== "user") return;
		if (handled || inFlight) return;

		const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
		if (prompt.length < MIN_PROMPT_CHARS) return;

		handled = true;
		inFlight = true;
		const task = (async () => {
			try {
				if (!(await shouldAutoTitle())) return;

				let title = await generateTitle(prompt, ctx);
				if (!title) {
					title = heuristicTitle(prompt);
				}
				if (!title) {
					// No title does not burn the one chance: the next eligible
					// prompt retries.
					handled = false;
					return;
				}

				// Re-check immediately before the async apply: another hook or
				// the user may have named the workspace in between.
				if (!(await shouldAutoTitle())) return;

				const ok = await applyTitle(title);
				if (!ok) {
					// A failed apply retries on the next eligible prompt.
					handled = false;
				}
			} finally {
				inFlight = false;
			}
		})();
		lastTask = task;
		void task;
	});
}
