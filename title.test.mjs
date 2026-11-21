// Tests for the herdr-workspace-title extension. Run with:
//   npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initHerdrWorkspaceTitle, {
	createTitleController,
	sanitizeTitle,
	heuristicTitle,
	autoLabelFor,
	herdrSessionFile,
	getLastTask,
} from "./index.ts";

test("sanitizeTitle keeps a fitting title", () => {
	assert.equal(sanitizeTitle("Fix login redirect loop"), "Fix login redirect loop");
});

test("sanitizeTitle strips prefixes, quotes and trailing punctuation", () => {
	// The markdown-prefix strip only eats the leading run of # > * - and
	// spaces, so the bold markers before the label survive it while the
	// label-specific strip takes over — the reference's own behavior.
	assert.equal(sanitizeTitle('**Title:** "Fix login redirect loop."'), "** Fix login redirect loop");
	assert.equal(sanitizeTitle("Título: Editar titulos de herdr."), "Editar titulos de herdr");
});

test("sanitizeTitle clips at the last word boundary inside the cap", () => {
	const got = sanitizeTitle("Fix the login redirect loop in the auth middleware service");
	assert.ok(got.length <= 34, `length ${got.length}`);
	assert.ok(!got.endsWith(" "), "no trailing space");
});

test("sanitizeTitle rejects empty and whitespace-only input", () => {
	assert.equal(sanitizeTitle(null), null);
	assert.equal(sanitizeTitle(""), null);
	assert.equal(sanitizeTitle("   \n  "), null);
});

test("heuristicTitle filters stopwords and caps the word count", () => {
	assert.equal(heuristicTitle("fix the login redirect loop in the auth middleware"), "fix login redirect loop");
});

test("heuristicTitle keeps the request language", () => {
	assert.equal(heuristicTitle("Arreglar el bucle de redirección del login en el servicio"), "arreglar bucle redirección login");
});

test("heuristicTitle drops code fences before filtering", () => {
	// The surviving backtick pairs swallow `el bucle` as inline code — the
	// reference's own behavior; only words outside code survive.
	const got = heuristicTitle("arreglar `el bucle` ```js\nx=1\n``` del login");
	assert.equal(got, "arreglar login");
});

test("heuristicTitle rejects ineligible input", () => {
	assert.equal(heuristicTitle(null), null);
	assert.equal(heuristicTitle(""), null);
});

test("autoLabelFor maps cwd to herdr's default label", () => {
	assert.equal(autoLabelFor("/home/wilber/Projects/Personal/herdr-sidecar/"), "herdr-sidecar");
	assert.equal(autoLabelFor(process.env.HOME), "~");
	assert.equal(autoLabelFor(null), null);
	assert.equal(autoLabelFor("   "), null);
});

const HOME = process.env.HOME;
const legacy = `${HOME}/.config/herdr/session.json`;
const fake = (present) => (p) => present.has(p);

// herdr persists the active session at sessions/<name>/session.json; the
// extension must read there before the legacy top-level file — the old path
// went stale (it froze with an old session's only workspace) and every
// lookup missed, so no workspace ever got a title.
test("herdrSessionFile prefers the per-session file when it exists", () => {
	const perSession = `${HOME}/.config/herdr/sessions/Others/session.json`;
	assert.equal(
		herdrSessionFile(undefined, "Others", fake(new Set([perSession]))),
		perSession,
	);
});

test("herdrSessionFile falls back to the legacy file without a per-session one", () => {
	assert.equal(herdrSessionFile(undefined, "Others", fake(new Set())), legacy);
	assert.equal(herdrSessionFile(undefined, "  ", fake(new Set())), legacy);
	assert.equal(herdrSessionFile(undefined, undefined, fake(new Set())), legacy);
});

test("herdrSessionFile honors the explicit override", () => {
	assert.equal(
		herdrSessionFile("/tmp/x.json", "Others", fake(new Set())),
		"/tmp/x.json",
	);
});

// --- Hot-path behavior (odd/tasks/latency-pareto T5: F4, F5) -----------------
// herdr's session.json grows with the session (workspaces, panes, scrollback),
// so every extra synchronous read on Pi's event loop costs more as the session
// runs, and the nested autotitle model call must never compete with the
// triggering turn for the event loop or the model credentials.

const SESSION_FILE = "/tmp/herdr-test/session.json";
const IDENTITY_CWD = "/home/wilber/Projects/Personal/demo";
const TITLED = "Fix login redirect loop";
const PROMPT = "fix the login redirect loop in the auth middleware";

function makeController(customize = () => ({})) {
	const calls = { reads: 0, files: [], probes: 0, generated: 0, applied: [] };
	const controller = createTitleController({
		workspaceId: "ws1",
		sessionFile: () => SESSION_FILE,
		readFile: (file) => {
			calls.reads += 1;
			calls.files.push(file);
			return JSON.stringify({ workspaces: [{ id: "ws1", identity_cwd: IDENTITY_CWD }] });
		},
		probeWorkspace: async () => {
			calls.probes += 1;
			return { tokens: {}, label: "demo" };
		},
		generateTitle: async () => {
			calls.generated += 1;
			return TITLED;
		},
		applyTitle: async (title) => {
			calls.applied.push(title);
			return true;
		},
		heuristic: heuristicTitle,
		minPromptChars: 12,
		log: () => {},
		...customize(calls),
	});
	return { controller, calls };
}

test("one invocation reads herdr's session file at most once, however many consumers need it", async () => {
	const { controller, calls } = makeController();
	controller.beforeAgentStart(PROMPT, {});
	await controller.agentSettled({});

	assert.equal(calls.reads, 1, "session.json is read from disk once per invocation");
	assert.deepEqual(calls.files, [SESSION_FILE]);
	assert.deepEqual(calls.applied, [TITLED], "the pre-check and the label check share one snapshot");
	assert.equal(calls.generated, 1);
});

test("scheduling a title does no work while the turn is starting", () => {
	const { controller, calls } = makeController();
	controller.beforeAgentStart(PROMPT, {});

	assert.equal(calls.reads, 0, "no synchronous session read in before_agent_start");
	assert.equal(calls.probes, 0, "no herdr subprocess in before_agent_start");
	assert.equal(calls.generated, 0, "no nested model call while the turn is in flight");
	assert.equal(controller.getLastTask(), null);
});

test("a failed apply retries on the next prompt with a fresh snapshot", async () => {
	const { controller, calls } = makeController((calls) => ({
		applyTitle: async (title) => {
			calls.applied.push(title);
			return false;
		},
	}));

	controller.beforeAgentStart(PROMPT, {});
	await controller.agentSettled({});
	controller.beforeAgentStart(PROMPT, {});
	await controller.agentSettled({});

	assert.equal(calls.reads, 2, "the snapshot is per invocation, never cached across prompts");
	assert.deepEqual(calls.applied, [TITLED, TITLED], "a failed apply retries on the next eligible prompt");
});

test("a workspace that already got its title is never retitled", async () => {
	const { controller, calls } = makeController();
	controller.beforeAgentStart(PROMPT, {});
	await controller.agentSettled({});

	assert.equal(controller.agentSettled({}), null, "no pending work settles twice");
	controller.beforeAgentStart("another prompt that is long enough", {});
	assert.equal(calls.generated, 1, "one title per session");
	assert.deepEqual(calls.applied, [TITLED]);
});

test("a custom_name in the session skips the workspace before any model call", async () => {
	const { controller, calls } = makeController(() => ({
		readFile: () =>
			JSON.stringify({
				workspaces: [{ id: "ws1", identity_cwd: IDENTITY_CWD, custom_name: "Mi workspace" }],
			}),
	}));

	controller.beforeAgentStart(PROMPT, {});
	await controller.agentSettled({});

	assert.equal(calls.generated, 0, "a hand-set name costs no model call");
	assert.deepEqual(calls.applied, []);
});

test("a live label that differs from the cwd label wins over the generated title", async () => {
	const { controller, calls } = makeController(() => ({
		probeWorkspace: async () => ({ tokens: {}, label: "renamed-by-hand" }),
	}));

	controller.beforeAgentStart(PROMPT, {});
	await controller.agentSettled({});

	assert.deepEqual(calls.applied, [], "a hand-set label is never overwritten");
});

test("a workspace that already carries the title token is not titled again", async () => {
	const { controller, calls } = makeController(() => ({
		probeWorkspace: async () => ({ tokens: { title: "Already titled" }, label: "demo" }),
	}));

	controller.beforeAgentStart(PROMPT, {});
	await controller.agentSettled({});

	assert.deepEqual(calls.applied, []);
});

async function waitFor(predicate, timeoutMs) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started >= timeoutMs) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return true;
}

function fakePi() {
	const handlers = new Map();
	const commands = new Map();
	return {
		handlers,
		commands,
		pi: {
			registerCommand: (name, options) => commands.set(name, options),
			on: (name, handler) => handlers.set(name, handler),
		},
	};
}

// An isolated herdr: a stub binary that answers `workspace get` with
// HERDR_TITLE_TEST_GET, records every `workspace report-metadata` call, and a
// session.json beside it. Everything lives in one temp dir, removed on teardown.
function herdrEnv(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-title-"));
	const sessionFile = path.join(dir, "session.json");
	const appliedLog = path.join(dir, "applied.log");
	const bin = path.join(dir, "herdr");

	fs.writeFileSync(
		sessionFile,
		JSON.stringify({ workspaces: [{ id: "ws1", identity_cwd: path.join(dir, "demo") }] }),
	);
	fs.writeFileSync(
		bin,
		[
			"#!/bin/sh",
			'if [ "$1" = "workspace" ] && [ "$2" = "get" ]; then',
			'  printf "%s" "$HERDR_TITLE_TEST_GET"',
			"  exit 0",
			"fi",
			'if [ "$1" = "workspace" ] && [ "$2" = "report-metadata" ]; then',
			'  printf "%s\\n" "$*" >> "$HERDR_TITLE_TEST_LOG"',
			"  exit 0",
			"fi",
			"exit 1",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);

	const keys = [
		"HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_SESSION_FILE", "HERDR_SESSION",
		"HERDR_BIN_PATH", "HERDR_TITLE_DISABLE", "HERDR_TITLE_DEBUG",
		"PI_HERDR_TITLE_STATE_DIR", "HERDR_TITLE_TEST_GET", "HERDR_TITLE_TEST_LOG",
	];
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	t.after(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "ws1";
	process.env.HERDR_SESSION_FILE = sessionFile;
	delete process.env.HERDR_SESSION;
	process.env.HERDR_BIN_PATH = bin;
	delete process.env.HERDR_TITLE_DISABLE;
	delete process.env.HERDR_TITLE_DEBUG;
	process.env.PI_HERDR_TITLE_STATE_DIR = path.join(dir, "state");
	process.env.HERDR_TITLE_TEST_GET = JSON.stringify({
		result: { workspace: { id: "ws1", label: "demo", tokens: {} } },
	});
	process.env.HERDR_TITLE_TEST_LOG = appliedLog;

	return { dir, sessionFile, appliedLog };
}

test("the nested autotitle model call waits for the turn to settle", async (t) => {
	const { appliedLog } = herdrEnv(t);
	const { pi, handlers } = fakePi();
	initHerdrWorkspaceTitle(pi);

	const complete = [];
	const ctx = {
		model: { id: "test/model" },
		modelRegistry: {
			complete: async () => {
				complete.push("called");
				return { content: [{ type: "text", text: TITLED }] };
			},
		},
	};

	await handlers.get("before_agent_start")({ messageType: "user", prompt: PROMPT }, ctx);
	const calledDuringTurn = await waitFor(() => complete.length > 0, 300);
	assert.equal(calledDuringTurn, false, "no autotitle model call while the triggering turn is in flight");

	const settle = handlers.get("agent_settled");
	assert.ok(settle, "the title runs from the run's settled boundary");
	await settle({ aborted: false }, ctx);
	await (getLastTask() ?? Promise.resolve());

	assert.equal(complete.length, 1, "exactly one nested model call, after the turn");
	assert.match(
		fs.readFileSync(appliedLog, "utf-8"),
		/--token title=Fix login redirect loop/,
		"the title is still applied through report-metadata",
	);
});

test("/workspace-title off persists and stops new titling", async (t) => {
	herdrEnv(t);
	const { pi, handlers, commands } = fakePi();
	initHerdrWorkspaceTitle(pi);

	const reply = await commands.get("workspace-title").handler(["off"]);
	assert.equal(reply, "workspace-title: disabled (persisted; HERDR_TITLE_DISABLE=1 still wins)");
	const stateFile = path.join(process.env.PI_HERDR_TITLE_STATE_DIR, "state.json");
	assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf-8")).enabled, false);

	// A reload after `off` keeps titling off.
	assert.equal(handlers.has("before_agent_start"), true);
	const reloaded = fakePi();
	initHerdrWorkspaceTitle(reloaded.pi);
	assert.equal(reloaded.handlers.has("before_agent_start"), false);
});
