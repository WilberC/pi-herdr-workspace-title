// Pure-function tests for the herdr-workspace-title extension. Run with:
//   npm test
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeTitle, heuristicTitle, autoLabelFor, herdrSessionFile } from "./index.ts";

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
