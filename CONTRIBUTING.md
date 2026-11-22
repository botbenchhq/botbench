# Contributing to Botbench

Fixes and new agents are welcome. Botbench is early and built by one person, so for anything larger than a fix, open an issue first and say what you want to change.

## Run it and its tests

You need macOS, Node 24 or later and git.

```sh
npm install                   # development tools only; Botbench has no runtime dependencies
npm ci --prefix web           # the client
npm run build --prefix web
npm start                     # http://127.0.0.1:4780
npm run typecheck
npm test                      # design check, unit and integration tests; no model turns
```

Two slower suites exist. Run them once, at the end of your change, not while you work:

- `npm run e2e` drives the real app in a browser (Playwright; `npx playwright install` the first time).
- `npm run test:live` runs the real CLIs and needs them installed and signed in on your machine.

## The rules a contribution follows

These come from [`CLAUDE.md`](CLAUDE.md) and [`docs/lessons.md`](docs/lessons.md).

- **Nothing fake.** No mocks, fake CLIs, demo data or empty placeholder screens. Tests use a real temporary git repository, a real SQLite database and a real HTTP server. The one exception: a session recorded from a real CLI run may be replayed (see `test/recordings/`).
- **Tests first.** Write the test and see it fail before the code. Test at the lowest layer that can fail for the right reason.
- **Cheap tests while building.** Run the tests for the files you change. Run the browser and live suites once at the end.
- **No runtime dependencies.** Anything else needs a short decision record in `docs/adr/` saying why.
- **Never read or store credentials.** Sign-ins stay with the vendor CLI, `git` and `gh`. API-key variables are removed from what agents start with.
- **Never touch the owner's checkout or current branch.** Work happens in a separate copy per task.
- **Ship a control or status only when the behaviour behind it exists.**
- **Words on screen follow [`docs/product/voice.md`](docs/product/voice.md)**, and the UI follows the vendored design system in `web/vendor/design-system/` (read its `rules/core.md`; never edit that folder; see [`DESIGN.md`](DESIGN.md)).
- **Security-relevant changes update [`docs/security/threat-model.md`](docs/security/threat-model.md)** in the same change, and say exactly what is and is not isolated.

## How the code is laid out

`src/`
- `api/`: the HTTP routes, sign-in and live updates.
- `approvals/`: the permission check, the always-ask list, approvals and standing permissions.
- `drivers/`: one file per coding CLI, plus the shared contract and launch rules.
- `engine/`: runs, tasks, the plan, build, check, review and decision steps, and restart recovery.
- `store/`: the SQLite database and its migrations.
- Files at the top: `server.ts` (start-up), `config.ts` (settings), `confinement.ts` (confined commands), `worktrees.ts` (the separate copies), `usage.ts`.

`web/src/`
- `screens/`: one file per screen.
- `components/`: the cards, diff, transcript and status pieces the screens share.
- `api/`: the client's calls to the server.
- `app/`: the shell, approvals tray and appearance.
- `brand/`: the logo and icons.

Elsewhere: `test/` (unit, integration and `live/`), `e2e/` (browser tests), `docs/` (plan, decisions, security, product).

## Adding an agent

An agent is a driver: one adapter that runs a vendor's CLI as a child process over its structured, headless protocol. No terminal emulation and no vendor SDKs.

1. Read `src/drivers/contract.ts` for what a driver must provide, and read `src/drivers/claude-code.ts` (plans and builds) and `src/drivers/codex.ts` (reviews) as the two patterns.
2. Start the CLI through `src/drivers/launch.ts`: an allowlisted environment, API-key variables stripped, and no personal settings, hooks or MCP servers loaded.
3. Confinement is required. Every shell command the agent runs must go through the confinement, with no network except the owner's allowed hosts and the sign-in and key folders unreadable. If the CLI cannot be confined, it cannot be a driver yet. Say what you measured on the real CLI.
4. State what the driver can do (resume, interrupt, permission requests, edits). A driver that cannot ask for permission must not be given roles that need it.
5. Add its name to the driver list in `src/config.ts`, add live tests against the real CLI, and update the threat model.

## Reporting a security problem

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (the Security tab, then Report a vulnerability) and tell the maintainer what you found and how to reproduce it.

## Built with itself

Where it can, the project is built with Botbench. The first version of the README came from a Botbench run on this repository. Changes made that way go through the same rules and tests as any other.
