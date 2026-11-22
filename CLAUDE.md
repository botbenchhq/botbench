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
  - Critique against this file's hard rules + engineering standards (STRIDE for any new trust boundary) + DESIGN.md Never list + original intent.
  - Use the same model or a different one. Prefer a fresh context for the critic.
  - Return structured findings (violations, incompleteness, weak evidence).
  - Revise once based on the critique. Attach the critique summary as evidence.
  - Do not ask the owner for style, density, or completeness feedback the agent can generate itself.
- After any correction from the owner: update this file or `docs/lessons.md` with the pattern so it does not repeat.
- Complex or parallel research: use subagents. Keep main context clean.
- Read DESIGN.md before any UI work.

## Hard rules
- Nothing fake. No mocks, fake CLIs, demo data, empty screens. Stop and ask if a unit needs one. One exception the owner approved: a session captured from a real CLI run may be replayed through the driver contract for scenarios a live model cannot produce on demand.
- Drive existing CLIs. Never store or read credentials/API keys. Never force metered billing on a subscription session. Connecting a subscription from the client means running the vendor CLI's own sign-in and relaying its link or code; the credentials stay with the CLI.
- One git worktree per task. Never modify owner's checkout or current branch. Smelt commits.
- Approvals required before anything leaves the machine. Dangerous actions always ask. Broker failure = deny.
- Local only. No data leaves owner's machine. No push, no PRs this plan.
- Test-first. Real temp git repo, real SQLite, real HTTP, real CLIs (live).

## Engineering standards
Apply in proportion to a one-owner, local tool. Each line says what it means here, not the whole framework.
- Core: DRY, KISS, YAGNI. One owner per rule; no abstraction before its second use. SOLID and separation of concerns at module edges (store, drivers, approvals, engine, api, web). Errors carry what failed and what to do; nothing is swallowed.
- Security: STRIDE per unit that adds a trust boundary; update `docs/security/threat-model.md` in the same PR. OWASP ASVS as the checklist for auth, sessions, input and files. Least privilege and secure defaults: deny on failure, loopback only, owner-only file modes.
- Dependencies and secrets: zero runtime dependencies unless an ADR says why. `npm audit` clean, lockfile committed, no secret or token in the repo, logs or responses.
- Architecture: domain terms from the plan are the names in code (run, task, attempt, station, approval, grant). A decision that is costly to reverse gets a short ADR in `docs/adr/`. 12-factor where it applies: config from file and env, one process, logs to stdout.
- Supply chain: every change traces to a unit and a PR with its evidence. Copied files are listed in `NOTICE`. SBOM (`npm sbom`) and build provenance arrive with the first release, not before.
- Agentic AI security (OWASP Agentic Top 10): repository text, web text and model output are data, never instructions to Smelt. Tool permissions go through the broker and the safety floor. Every agent action that ran is in the append-only log. Isolation claims are stated exactly: a worktree separates changes, it is not a sandbox.

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
