# Install

[Back to the README](../README.md)

## From npm

```bash
gentle-shell install npm:pi-herdr-workspace-title   # Gentle Shell
pi install npm:pi-herdr-workspace-title             # Pi
```

Inside Gentle Shell, `/gentle:install pi-herdr-workspace-title` does the same.
Run `/reload` afterwards.

## From a checkout

```bash
ln -s "$PWD/pi-herdr-workspace-title/index.ts" \
      ~/.gentle-shell/agent/extensions/herdr-workspace-title.ts
```

Use `~/.pi/agent/extensions/` for a plain Pi install.

## Requirements

- Pi ≥ 1.5.0 with the extensions API (`before_agent_start`,
  `modelRegistry.complete`). No TypeScript compiler needed: Pi loads the `.ts`
  with strip-types.
- herdr with `workspace report-metadata` (0.9.x; present since the metadata API
  landed — the extension fails safe and retries on older builds).
- An authenticated model session in Pi for the redaction; without it the local
  heuristic takes over (no auth needed).

No dependency on `hu` / herdr-utils: this extension and `hu title set` are two
independent entrances to the same display-only token, with the same skip rules.

## Debugging

Set `HERDR_TITLE_DEBUG=1` to log to `/tmp/herdr-workspace-title.log`.
