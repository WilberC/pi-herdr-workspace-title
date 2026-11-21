# pi-herdr-workspace-title

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that names
your [herdr](https://herdr.dev) workspace once per session, with a short title
redacted from your first real request — «Fix login redirect loop». The
herdr-sidecar dock draws it under the agent name, and herdr's own tokens can
read it.

Adapted from
[`herdr-workspace-title.ts`](https://github.com/RamonsDka/gs3-sidebar/blob/main/extensions/herdr-workspace-title.ts)
by RamonsDka (gs3-sidebar, MIT), with one deliberate change: the title is
applied through `herdr workspace report-metadata` — a display-only token — so
the workspace **label you can rename is never touched**.

## How it works

```
first eligible prompt (≥ 12 chars)
  → before_agent_start records the exact text; no read, no subprocess, no model call
run settles (agent_settled; agent_end on older Pi builds)
  → one read of herdr's session.json decides eligibility
    (no title token, no custom_name, label still the one derived from the cwd)
  → the session's active model redacts the title (one short isolated call, 15s timeout)
  → fallback: local heuristic (stopwords, 2–5 words, 34-char cap, request language)
  → one live `herdr workspace get`, then
    herdr workspace report-metadata <ws> --source herdr-utils --token title=<title>
```

Everything runs in the background and never delays the agent's turn. The
title work also never competes with the turn: it starts only after the run
settles, so the nested model call does not share the event loop or the
credentials with the request the user is waiting for.

herdr's `session.json` grows with the session (workspaces, panes, and the
pane-history scrollback), so a run reads and parses it once and every check
in that run reuses the same snapshot; the next prompt reads it fresh.

## Rules

- Only acts inside herdr (`HERDR_ENV=1` + `HERDR_WORKSPACE_ID`).
- One title per workspace: a workspace that already carries the `title` token
  is skipped.
- **A name you set by hand always wins** (fail closed): a `custom_name` in
  herdr's session, or a live label that differs from the one herdr derives
  from the workspace cwd, skips the workspace. When in doubt, it does not
  touch anything.
- The immediate re-check before the async apply closes the race with another
  hook or a manual rename; it costs one live `herdr workspace get` per run and
  no second read of the session file.
- A failed apply retries on the next eligible prompt.

## Commands

| Command | Effect |
| --- | --- |
| `/workspace-title on` | Enable (persisted) |
| `/workspace-title off` | Disable new titling (persisted; never clears an applied title) |
| `/workspace-title status` | Toggle, env and workspace state |

`HERDR_TITLE_DISABLE=1` is the hard switch and always wins over the toggle.
Set `HERDR_TITLE_DEBUG=1` to log to `/tmp/herdr-workspace-title.log`.

## Install

A Pi package, in the gallery and on npm:

```
/gentle:install pi-herdr-workspace-title
```

(or install the npm package into the agent's package root), then `/reload` in
Pi. From a plain checkout instead:

```bash
ln -s "$PWD/pi-herdr-workspace-title/index.ts" \
      ~/.gentle-shell/agent/extensions/herdr-workspace-title.ts
```

(or `~/.pi/agent/extensions/` for a plain Pi install).

## Requirements

- Pi ≥ 1.5.0 with the extensions API (`before_agent_start`,
  `modelRegistry.complete`). No TypeScript compiler needed: Pi loads the
  `.ts` with strip-types.
- herdr with `workspace report-metadata` (0.9.x; present since the metadata
  API landed — the extension fails safe and retries on older builds).
- A authenticated model session in Pi for the redaction; without it the
  heuristic takes over (no auth needed).

No dependency on `hu` / herdr-utils: this extension and `hu title set` are
two independent entrances to the same display-only token, with the same
skip rules.

## Tests

```sh
npm test
```

Unit tests for the pure functions (sanitize, heuristic, auto-label,
session-file resolution) plus hook-level tests that drive
`before_agent_start` and `agent_settled` against a stub `herdr` binary and a
stub model registry in a temp directory: no network, no real herdr, and the
temp directory is removed afterwards.

## License

MIT — see [LICENSE](LICENSE). Framing core adapted from RamonsDka's
gs3-sidebar extension (MIT); the report-metadata application, the persistent
toggle and the package are this repo's work.
