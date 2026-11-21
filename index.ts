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
 * - Runs after the run settles (agent_settled) and never delays or competes
 *   with the agent's turn; a failed apply retries on the next eligible prompt.
 * - Reads herdr's session.json once per invocation and reuses that snapshot;
 *   one live `workspace get` per run, right before the apply.
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

/** One workspace entry of herdr's session.json. */
export interface WorkspaceEntry {
	custom_name?: string | null;
	identity_cwd?: string | null;
}

export interface SessionEntryReaderDeps {
	workspaceId: string | undefined;
	/** Resolved lazily, so one invocation pays for the path lookup once. */
	sessionFile: () => string;
	readFile: (file: string) => string;
}

/**
 * One invocation's view of herdr's session.json.
 *
 * The file grows with the session (workspaces, panes, and
 * `experimental.pane_history` scrollback), so it is read and parsed at most
 * once per invocation and every consumer — the eligibility pre-check, the
 * auto-label comparison and the skip log — shares that snapshot. It is never
 * cached across prompts: the next prompt gets its own fresh read.
 */
export function createSessionEntryReader(deps: SessionEntryReaderDeps): () => WorkspaceEntry | null {
	let loaded = false;
	let entry: WorkspaceEntry | null = null;
	return () => {
		if (loaded) return entry;
		loaded = true;
		const wsId = deps.workspaceId;
		if (!wsId) return entry;
		try {
			const data = JSON.parse(deps.readFile(deps.sessionFile()));
			if (!Array.isArray(data?.workspaces)) return entry;
			const workspace = data.workspaces.find((candidate: any) => candidate?.id === wsId);
			if (workspace && typeof workspace === "object") entry = workspace;
		} catch {
			entry = null;
		}
		return entry;
	};
}

/** The workspace cwd herdr derives its label from, trimmed, or null. */
export function identityCwdOf(entry: WorkspaceEntry | null | undefined): string | null {
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

export interface AutoTitleContext {
	workspaceId: string | undefined;
	/** The invocation's session.json snapshot (see createSessionEntryReader). */
	sessionEntry: () => WorkspaceEntry | null;
	probeWorkspace: (wsId: string, timeoutMs: number) => Promise<any | null>;
	log: (message: string) => void;
}

/**
 * The cheap half of the eligibility check: no subprocess and no second read of
 * herdr's session file, only the invocation's snapshot.
 *
 * Conservative on purpose: when in doubt, do not touch (fail closed) —
 * overwriting a hand-set name is far worse than leaving a workspace untitled.
 * Fails closed when the session file cannot be read or the cwd is unknown.
 */
export function canAutoTitleFromSession(ctx: AutoTitleContext): boolean {
	const wsId = ctx.workspaceId;
	if (!wsId) return false;

	const entry = ctx.sessionEntry();
	if (!entry) {
		ctx.log(`skip: session file unreadable or workspace ${wsId} not found in session`);
		return false;
	}
	if (typeof entry.custom_name === "string" && entry.custom_name.trim().length > 0) {
		ctx.log(`skip: ${wsId} carries a custom_name in the session`);
		return false;
	}

	const identityCwd = identityCwdOf(entry);
	if (!autoLabelFor(identityCwd)) {
		ctx.log(`skip: cannot determine auto-label for cwd "${identityCwd}"`);
		return false;
	}

	return true;
}

/**
 * The live half: one `herdr workspace get`, run immediately before the apply so
 * a name the user set while the title was being redacted still wins. It reuses
 * the invocation's session snapshot instead of reading the file again, and it
 * is the only subprocess query of a run.
 */
export async function canAutoTitleNow(ctx: AutoTitleContext): Promise<boolean> {
	const wsId = ctx.workspaceId;
	if (!wsId) return false;

	const live = await ctx.probeWorkspace(wsId, 2000);
	if (!live) {
		ctx.log(`skip: workspace get failed or malformed for ${wsId}`);
		return false;
	}
	const tokens = live.tokens ?? {};
	if (typeof tokens.title === "string" && tokens.title.trim().length > 0) {
		ctx.log(`skip: ${wsId} already carries the title token`);
		return false;
	}

	const label = typeof live.label === "string" ? live.label.trim() : "";
	const identityCwd = identityCwdOf(ctx.sessionEntry());
	const autoLabel = autoLabelFor(identityCwd);
	if (!autoLabel) {
		ctx.log(`skip: cannot determine auto-label for cwd "${identityCwd}"`);
		return false;
	}
	if (label !== autoLabel) {
		ctx.log(`skip: ${wsId} carries its own label "${label}"`);
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

export interface TitleControllerDeps {
	workspaceId: string | undefined;
	sessionFile: () => string;
	readFile: (file: string) => string;
	probeWorkspace: (wsId: string, timeoutMs: number) => Promise<any | null>;
	generateTitle: (prompt: string, ctx: any) => Promise<string | null>;
	applyTitle: (title: string) => Promise<boolean>;
	heuristic: (prompt: string | null | undefined) => string | null;
	minPromptChars: number;
	log: (message: string) => void;
}

export interface TitleController {
	/** Record the prompt of the run that is starting. Does no I/O. */
	beforeAgentStart(prompt: string | null | undefined, ctx: unknown): void;
	/** Start the recorded prompt's title work; call once the run settled. */
	agentSettled(ctx?: unknown): Promise<void> | null;
	getLastTask(): Promise<void> | null;
}

/**
 * The title pipeline, split from the event wiring so its two hot-path
 * guarantees are testable: no work while the run is starting (F5) and one
 * session.json read per invocation (F4).
 */
export function createTitleController(deps: TitleControllerDeps): TitleController {
	let handled = false;
	let inFlight = false;
	let pending: { prompt: string; ctx: unknown } | null = null;
	let lastTask: Promise<void> | null = null;

	async function run(prompt: string, ctx: unknown): Promise<void> {
		const autoCtx: AutoTitleContext = {
			workspaceId: deps.workspaceId,
			sessionEntry: createSessionEntryReader({
				workspaceId: deps.workspaceId,
				sessionFile: deps.sessionFile,
				readFile: deps.readFile,
			}),
			probeWorkspace: deps.probeWorkspace,
			log: deps.log,
		};

		if (!canAutoTitleFromSession(autoCtx)) return;

		let title = await deps.generateTitle(prompt, ctx);
		if (!title) title = deps.heuristic(prompt);
		if (!title) {
			// No title does not burn the one chance: the next eligible prompt
			// retries.
			handled = false;
			return;
		}

		// The single live query of the run, immediately before the async
		// apply: another hook or the user may have named the workspace in
		// between.
		if (!(await canAutoTitleNow(autoCtx))) return;

		if (!(await deps.applyTitle(title))) {
			// A failed apply retries on the next eligible prompt.
			handled = false;
		}
	}

	function start(prompt: string, ctx: unknown): Promise<void> {
		if (inFlight) return Promise.resolve();
		inFlight = true;
		handled = true;
		const task = run(prompt, ctx).finally(() => {
			inFlight = false;
		});
		lastTask = task;
		return task;
	}

	return {
		beforeAgentStart(prompt, ctx) {
			// A prompt whose run never settled (no settle event, or a hard
			// abort) runs its title here instead of stacking a second pending
			// prompt, so the first eligible prompt still wins.
			if (pending) {
				const stale = pending;
				pending = null;
				void start(stale.prompt, stale.ctx);
				return;
			}
			if (handled || inFlight) return;
			const text = typeof prompt === "string" ? prompt.trim() : "";
			if (text.length < deps.minPromptChars) return;
			pending = { prompt: text, ctx };
		},
		agentSettled(ctx) {
			if (!pending) return null;
			const { prompt, ctx: queued } = pending;
			pending = null;
			// Prefer the settled run's context when it carries a model, so the
			// redaction uses the model that is actually active now.
			return start(prompt, hasModel(ctx) ? ctx : queued);
		},
		getLastTask() {
			return lastTask;
		},
	};
}

function hasModel(ctx: unknown): boolean {
	const model = (ctx as any)?.model;
	return typeof model === "object" && model !== null;
}

let activeController: TitleController | null = null;

export function getLastTask(): Promise<void> | null {
	return activeController?.getLastTask() ?? null;
}

/** Registers a notification-only run boundary; false when the build lacks it. */
function onRunSettled(
	pi: ExtensionAPI,
	event: "agent_settled" | "agent_end",
	handler: (event: any, ctx: ExtensionContext) => void,
): boolean {
	try {
		pi.on(event, handler);
		return true;
	} catch (error) {
		log(`${event} unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export default function initHerdrWorkspaceTitle(pi: ExtensionAPI): void {
	registerCommand(pi);
	if (!enabled() || !readToggle()) return;

	const controller = createTitleController({
		workspaceId: getWorkspaceId(),
		sessionFile: getHerdrSessionFile,
		readFile: (file) => fs.readFileSync(file, "utf-8"),
		probeWorkspace: workspaceJSON,
		generateTitle,
		applyTitle,
		heuristic: heuristicTitle,
		minPromptChars: MIN_PROMPT_CHARS,
		log,
	});
	activeController = controller;

	pi.on("before_agent_start", (event: any, ctx: ExtensionContext) => {
		if (event?.messageType !== "user") return;
		// Record only: the title work starts once the run settles, so the
		// nested model call never competes with the first real turn for the
		// event loop or the session's credentials.
		controller.beforeAgentStart(event.prompt, ctx);
	});

	const settled = (_event: any, ctx: ExtensionContext) => {
		void controller.agentSettled(ctx);
	};
	// `agent_settled` is the run's final, non-reentrant boundary; `agent_end`
	// only brackets one low-level run, so it is the fallback for builds without
	// it. Without either, the next prompt flushes the pending title.
	if (!onRunSettled(pi, "agent_settled", settled)) {
		if (!onRunSettled(pi, "agent_end", settled)) {
			log("no run settle event: the next prompt flushes the pending title");
		}
	}
}
