# pi-herdr-workspace-title

**Your [herdr](https://herdr.dev) workspaces name themselves from your first
request.** A [Pi](https://pi.dev) and
[Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) extension.

## What it does

Once per session, after the first real request settles, the session's model
redacts a short title from it — «Fix login redirect loop» — and the extension
applies it to the current herdr workspace as display-only metadata
(`herdr workspace report-metadata … --token title=<title>`). The
[herdr-sidecar](https://github.com/WilberC/herdr-sidecar) dock draws it under
the agent name, and herdr's own tokens can read it.

## What it solves

- **A row of workspaces all called after their folder.** Each one gets a title
  that says what you are doing in it.
- **Naming is a chore you forget.** It happens in the background, after the
  turn, without delaying the agent.
- **Automation must not overwrite you.** The workspace label is never touched:
  a name you set by hand always wins, and when in doubt it does nothing.

## Install

```bash
# Gentle Shell
gentle-shell install npm:pi-herdr-workspace-title

# Pi
pi install npm:pi-herdr-workspace-title
```

Then `/reload` inside the session. It only acts inside herdr
(`HERDR_ENV=1` and `HERDR_WORKSPACE_ID` set). Requirements and a checkout
install: [docs/install.md](docs/install.md).

## Quick reference

| Command | Effect |
| --- | --- |
| `/workspace-title on` | enable (persisted) |
| `/workspace-title off` | disable new titling (persisted; never clears an applied title) |
| `/workspace-title status` | toggle, env and workspace state |

`HERDR_TITLE_DISABLE=1` is the hard switch and always wins over the toggle.

## Documentation

| I want to… | Read |
| --- | --- |
| Check requirements, or install from a checkout | [docs/install.md](docs/install.md) |
| Know when a workspace gets a title, and when it is skipped | [docs/how-it-works.md](docs/how-it-works.md) |
| Run the tests | [docs/development.md](docs/development.md) |

## License

MIT — see [LICENSE](LICENSE). Adapted from
[`herdr-workspace-title.ts`](https://github.com/RamonsDka/gs3-sidebar/blob/main/extensions/herdr-workspace-title.ts)
by RamonsDka (gs3-sidebar, MIT), with one deliberate change: the title goes
through display-only metadata, so the workspace label you can rename is never
touched. The report-metadata application, the persistent toggle and the package
are this repo's work.
