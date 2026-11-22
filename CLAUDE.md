# Smelt

Local software factory. Drives owner's Claude Code / Codex / Gemini CLI / Grok. Output: verified branch + evidence. Mac or phone.

## Commands
- typecheck: `npm run typecheck`
- test: `npm test`
- live: `npm run test:live` (real CLIs, owner machine)
- e2e: `npm run e2e`
- client: `npm run build --prefix web`

Done = tests pass. Owner checks batched per milestone.

## Workflow
- Non-trivial change (3+ steps or architecture): plan mode first. Stop and re-plan if it goes sideways.
- After any non-trivial change: run a self-critique pass before presenting.
  - Critique against this file's hard rules + DESIGN.md Never list + original intent.
  - Use the same model or a different one. Prefer a fresh context for the critic.
  - Return structured findings (violations, incompleteness, weak evidence).
  - Revise once based on the critique. Attach the critique summary as evidence.
  - Do not ask the owner for style, density, or completeness feedback the agent can generate itself.
- After any correction from the owner: update this file or `docs/lessons.md` with the pattern so it does not repeat.
- Complex or parallel research: use subagents. Keep main context clean.
- Read DESIGN.md before any UI work.

## Hard rules
- Nothing fake. No mocks, fake CLIs, demo data, empty screens. Stop and ask if a unit needs one. One exception the owner approved: a session captured from a real CLI run may be replayed through the driver contract for scenarios a live model cannot produce on demand.
- Drive existing CLIs. Never store or read credentials/API keys. Never force metered billing on a subscription session.
- One git worktree per task. Never modify owner's checkout or current branch. Smelt commits.
- Approvals required before anything leaves the machine. Dangerous actions always ask. Broker failure = deny.
- Local only. No data leaves owner's machine. No push, no PRs this plan.
- Test-first. Real temp git repo, real SQLite, real HTTP, real CLIs (live).

## Never
- Touch owner's working tree
- Store or forward provider credentials
- Listen on public addresses without explicit owner config
- Copy from OpenMausBot enterprise/
- Ship a control or status before the real behavior exists

## Non-obvious
- Node 24+, one process, `node:sqlite` under `~/.smelt`. No Docker required for first run.
- Drivers: stdio, structured headless protocol, one adapter. No pty, no vendor agent SDKs.
- Launch isolation: allowlist env, strip API-key vars, no personal settings/hooks/MCP.
- Permission broker + never-list overrides all grants.
- Restart: retry mid-turn once, else interrupted. Usage ledger append-only. Subscription turns store no dollars.
- After plan→build→verify→decide works, dogfood remaining units on this repo.

## Deferred
PRs/push, native apps, public internet, local models, issue intake, task deps/parallel, multi-model council, sandboxes, enterprise.

Plan: `docs/plans/`. Design: `DESIGN.md`.
