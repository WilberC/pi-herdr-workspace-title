# How it works

[Back to the README](../README.md)

## Flow

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

Everything runs in the background and never delays the agent's turn. The title
work also never competes with the turn: it starts only after the run settles, so
the nested model call does not share the event loop or the credentials with the
request the user is waiting for.

herdr's `session.json` grows with the session (workspaces, panes, and the
pane-history scrollback), so a run reads and parses it once and every check in
that run reuses the same snapshot; the next prompt reads it fresh.

## Rules

- Only acts inside herdr (`HERDR_ENV=1` + `HERDR_WORKSPACE_ID`).
- One title per workspace: a workspace that already carries the `title` token
  is skipped.
- **A name you set by hand always wins** (fail closed): a `custom_name` in
  herdr's session, or a live label that differs from the one herdr derives from
  the workspace cwd, skips the workspace. When in doubt, it does not touch
  anything.
- The immediate re-check before the async apply closes the race with another
  hook or a manual rename; it costs one live `herdr workspace get` per run and
  no second read of the session file.
- A failed apply retries on the next eligible prompt.
