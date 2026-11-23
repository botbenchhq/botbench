# Design review: Botbench against OpenMausBot

Date: 2026-11-22. Botbench at `db04b48`; OpenMausBot (`milind-soni/OpenMausBot`) at `3aec210`, read from `.reference/OpenMausBot`. Nothing under OpenMausBot's `enterprise/` was opened. No program was run; every claim is from reading the code and its docs.

Each path is relative to the repository its column or line names: the Botbench column and "Botbench today" lines cite Botbench, the OpenMausBot column, "OpenMausBot:" lines and Not worth taking cite OpenMausBot.

## Summary

Stronger: Botbench gives each task its own copy and branch, confines the agent's commands in macOS's sandbox, and has a safety floor that no mode loosens; OpenMausBot defaults every bot to its engine's most permissive mode and, on this computer, works in the person's own folder.
Stronger: Botbench ends in a branch with checks, a review by another vendor's model and an owner decision; no OpenMausBot code was found for checks, a cross-vendor review or a branch hand-back.
Weaker: once a Botbench task is building, the owner cannot tell the agent anything except through an approval card; OpenMausBot takes a message into a running turn.
Weaker: a Botbench task that goes quiet, or meets its usage limit, waits for the owner; OpenMausBot ends a silent turn after an activity window and records when a limit resets.
Weaker: reaching Botbench from a phone means typing a 43-character token; OpenMausBot pairs a phone from a link or QR code.

## Side by side

| Job | Botbench | OpenMausBot |
|---|---|---|
| Driving a CLI | Claude Code over stream-json stdio, one adapter per CLI, reviewers with one turn and no tools or read-only: `src/drivers/claude-code.ts` | Claude over stream-json, Codex over its JSON-RPC server, many CLIs over ACP: `server/drivers/claude.ts`, `server/drivers/acp/core.ts` |
| Resume | Resume cursor per attempt; a cut turn continues once with a labelled prompt, a second cut stops it: `src/engine/recover.ts` | Resume plan from cursors and compaction; a failed resume may replay only when the prompt was provably not accepted: `server/resume-recovery.ts` |
| Approvals | A pre-tool hook asks Botbench; card with Allow once, Always allow, Deny, Deny and say what to do instead; broker failure denies: `src/approvals/broker.ts` | Permission proxy turns native requests into chat cards, also question cards with choices: `server/permission-proxy.ts` |
| Permission rules | Word-by-word grants per task, run or standing, a floor that always asks, three modes fixed at start: `src/approvals/gate.ts` | Four levels per bot (ask, edits, auto, full), Full access by default, saved exact commands: `server/always-allow.ts` |
| Isolation | One git worktree per task, commands in the macOS sandbox, allowlisted env: `src/confinement.ts` | Works in the person's folder; a shadow git repository snapshots it before each turn: `server/checkpoints.ts` |
| Event storage | SQLite with append-only events, task events, approvals and action log: `src/store/schema.ts` | NDJSON per thread with paged reads, plus SQLite for messages and jobs: `server/thread-events.ts` |
| Starting work | One message box; a task, a run with a plan, or a GitHub issue as outside text: `web/src/app/composer.ts` | Chat composer per bot, a headless command, schedules and webhooks: `src/components/Composer.tsx` |
| Steering mid-run | No message to a building task; only the note on Deny and say what to do instead: `src/api/tasks.ts` | Messages sent during a turn are queued and written into it, and survive Stop: `server/steer-queue.ts` |
| Review by another model | Codex, Grok or Antigravity review the change; concerns go back for bounded fix rounds: `src/engine/review.ts` | An "auto" level where an engine's own reviewer answers its permission requests; no review of a finished change found: `server/runtime/capabilities.ts` |
| Delivery | Commit, checks, Accept or Reject, optional pull request with the owner's `gh`, never merged: `src/engine/delivery.ts` | No branch hand-back of its own; a prompt tells bots to return code as a branch and pull request with their GitHub tools: `server/lent-copies.ts` |
| Phone access | Loopback only; phone over the owner's private network (`tailscale serve`), login token, web push: `src/push.ts` | Pairing link or QR, an end-to-end encrypted hosted relay, native phone app: `server/phone-relay.ts` |
| Extending to a new CLI | A new file against the driver contract and its capabilities, tested live: `src/drivers/contract.ts` | Driver registry; any ACP agent added from config without code: `server/drivers/acp/custom.ts` |

## Findings

Ranked by value to a Botbench user who hands work over from a phone, walks away, and comes back to a branch they can trust.

### 1. End a building turn that has gone silent

- OpenMausBot: a host watchdog treats a turn that emits nothing for a set time as wedged; waiting on a person does not count, a running tool gets a longer allowance, and a shell command whose processes keep using CPU counts as working. `server/turn-watchdog.ts`. Handed-off work has a second activity window on the monotonic clock in `server/runtime/runtime.ts`.
- Botbench today: setup and check commands have a time limit (`src/engine/stations.ts`), but no limit on a builder turn was found; a Claude Code process that stops emitting events and stays alive leaves the task Working with nobody told. `src/engine/task.ts`.
- Change: give each builder and reviewer attempt an activity window (configurable, a default such as 20 minutes, waiting on an approval not counted); past it, stop the process group, mark the task Stopped with a reason that names the window, and send the same notification as a task that needs the owner.
- Size: small.
- Acceptance criterion: a task whose agent process emits no event for the configured window ends `interrupted` with a reason naming the window, and its recorded process group is no longer alive.

### 2. Wait for a usage limit to reset, then carry on

- OpenMausBot: reads the reset time from the CLI's refusal and plan usage, saves it across restarts, and uses it to decide when work may run again. `server/limit-resets.ts`, with the refusal parsed in `server/drivers/claude-limits.ts`.
- Botbench today: the driver turns `rate_limit_event` into a `rate_limit` event with `resetsAt` (`src/drivers/claude-code.ts`, the type in `src/drivers/events.ts`), the transcript shows it (`web/src/components/transcript.tsx`), and no engine code reads it, so the task stops and waits for the owner. The voice glossary already names the state "Paused · usage limit (resumes 3:14)" (`docs/product/voice.md`).
- Change: when a builder turn ends refused by the limit with a real reset time, record it on the task, show the paused state, and resume the same session on the same subscription once after the reset; never switch to another account or to metered billing. Without a reset time, stop as today.
- Size: medium.
- Acceptance criterion: replaying a captured session that ends with a rejected `rate_limit_event` leaves the task paused with that `resetsAt` stored, starts no attempt before it, and starts exactly one resume attempt after it.

### 3. Let the owner send a message to a task while it builds

- OpenMausBot: a message sent while a turn runs is held off the transcript, written to the CLI's stdin as a user message, echoed back by Claude Code (`--replay-user-messages`) when the model takes it in, and kept across Stop. `server/steer-queue.ts`, `server/drivers/claude.ts`.
- Botbench today: the task routes are create, list, diff, accept, reject, discard, resume and pull request (`src/api/tasks.ts`); the only way to correct a building agent is the note on Deny and say what to do instead (`src/approvals/broker.ts`), which needs the agent to ask first. The driver already keeps Claude Code's stdin open in stream-json (`src/drivers/claude-code.ts`).
- Change: a message box on a building task that writes one owner message into the running session, recorded in the transcript and the action log as the owner's words; between turns it is kept for the next turn. Only a signed-in owner session can send one, and reviewers are never sent one.
- Size: medium.
- Acceptance criterion: a message posted to a building task is stored as an owner event of that attempt and is written to the agent process's stdin before the attempt's next assistant event.

### 4. Pair a phone with a one-time link instead of the login token

- OpenMausBot: the server prints a pairing link and QR code; the phone opens it and gets its own revocable session. `server/cli-pairing.ts`, `src/pair/PairPage.tsx`.
- Botbench today: the phone signs in by pasting the long-lived login token read from `~/.botbench/login-token`, then keeps a device session. `src/api/auth.ts`.
- Change: Settings on a signed-in device shows a pairing code and QR that is single use and short lived (minutes), opening the sign-in page on the private-network name with the code; using it creates the same device session as the token does. Add the new boundary to `docs/security/threat-model.md` with its STRIDE lines.
- Size: medium.
- Acceptance criterion: a pairing code signs in once; a second use, or a use after its expiry, returns 401 and creates no session.

### 5. Let a run become stricter while it runs

- OpenMausBot: a bot's approval level can be changed while it works and applies from its next provider turn. `docs/approval-levels.md`, `src/components/ApprovalModeSelector.tsx`.
- Botbench today: a run's mode is chosen at start and a database trigger refuses any change. `src/engine/modes.ts`.
- Change: allow moving a running run to a stricter mode only (fully autonomous to semi-autonomous to manual), from the run screen, logged as an owner action; never looser, so the safety floor and the start-time rules for issue runs are untouched.
- Size: small.
- Acceptance criterion: changing a running run from fully autonomous to manual succeeds and the next confined command asks the owner; changing manual to fully autonomous is refused with 409.

## Not worth taking

- Full access as every bot's default level (`docs/approval-levels.md`): it inverts Botbench's rule that commands ask unless a mode chosen per run says otherwise.
- A hosted relay through the vendor's control plane (`server/phone-relay.ts`): traffic would leave the machine through a third party, against local by default; the owner's private network already does the job.
- Engines added from config with no code (`server/drivers/acp/custom.ts`): an unverified driver cannot back the capability claims, such as confined commands, that modes rely on.
- Moving a conversation to a backup engine at a usage limit (`server/limit-failover.ts`): a branch half built by one vendor and finished by another without a decision is harder to trust, and a pay-per-use backup is metered billing.
- A bot answering another bot's question for the person at Full access (`server/runtime/questions.ts`): model output would decide what the owner decides; Botbench refuses in fully autonomous runs instead.

## Could not verify

- Whether any OpenMausBot behaviour above works as written: no program, test or phone was run, and its runtime contract says that module is proven on fake engines.
- The hosted parts OpenMausBot relies on (the relay service, its control plane and push sender, the cloud computers): their server code is not in the repository.
- That OpenMausBot has no review of a finished change by another model: none was found by searching, which does not prove there is none.
- What Botbench does when Claude Code calls its own question tool (AskUserQuestion) in a headless turn: no rule names it, and only a live run shows whether the owner gets a card they can answer.
- How a Botbench task ends today when Claude Code meets its usage limit mid-turn (Stopped or Failed, and with which words): it needs a captured session that hits the limit.
- Whether writing a second user message to Claude Code 2.1.322's stdin mid-turn works with Botbench's flags (empty settings sources, the pre-tool hook, `--permission-prompts none`): OpenMausBot names 2.1.282 as its floor, under different flags.
