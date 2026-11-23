# Design review: Botbench and Rakazo

Date: 2026-11-22. Rakazo read from `.reference/rakazo` at commit 227e713. Rakazo paths below are relative to `.reference/rakazo/`; Botbench paths are relative to this repository.

## Summary

- Stronger: Botbench drives the whole vendor CLI as the coding agent in its own worktree; Rakazo runs its own agent loop and uses Claude Code only as a model with its tools turned off.
- Stronger: Botbench ends each task with a branch, check results, an optional review by another vendor's model, and a pull request opened exactly once; in the files read, Rakazo's only path to a pull request is a prompt to a remote coding agent.
- Weaker: Botbench sends a phone notification only for a waiting approval and for Ready for review; a task that fails or is stopped says nothing, and nothing reminds you of a card left unanswered.
- Weaker: an unanswered approval holds the whole run, because tasks build one at a time and Botbench has no rule for a card nobody answers; Rakazo ends unattended cards after a set time as a No.
- Weaker: you cannot send a building task a message; you can only answer a card or resume. Rakazo feeds a message sent during a run into that run.

## Side by side

| Job | Botbench | Rakazo |
|---|---|---|
| Driving a CLI | Claude Code over stream-json as the agent, allowlisted env, no personal settings: `src/drivers/claude-code.ts`, `src/drivers/launch.ts` | Own loop (Pi); Claude Code is a model with its tools, CLAUDE.md, memory and compaction off: `packages/adapters/src/providers/cli-model/claude-code/cli.ts` |
| Resume | Resume cursor per attempt; after a restart, retry once or park the approval and re-ask the same call: `src/engine/recover.ts` | Transcript checkpoint stored before each human wait; lease-fenced recovery scan: `packages/adapters/src/runtime/pi/pi-runtime-checkpoint.ts` |
| Approvals | Cards with Allow once, Always allow, Deny, Deny and say what to do; answers survive a restart: `src/approvals/broker.ts` | Ask, Auto or Never ask; cards do not block the chat; unattended cards expire after 30 minutes: `packages/adapters/src/approvals/approval-expiry.ts` |
| Permission rules | Never-list floor, word-by-word grants, three run modes, no grants after outside text: `src/approvals/gate.ts` | Allow and Block lists, an always-ask list, repeat of a denied call refused, taint after outside content: `packages/core/src/runs/action-approval.ts` |
| Isolation | One git worktree per task plus the CLI's macOS sandbox for commands; stated as not a sandbox for the CLI: `src/confinement.ts` | One computer per bot or team in Docker or a hosted sandbox; the agent loop runs in the API process: `packages/adapters/src/providers/computer/docker/docker-sandbox.ts` |
| Event storage | SQLite `events` rows; SSE sends rows after `Last-Event-ID`: `src/api/stream.ts` | Postgres `Event` rows numbered per thread; the stream sends content-free signals and clients re-read: `packages/db/src/threads/event-stream.ts` |
| Starting work | One message box for a task, a planned run, or a GitHub issue read as outside text: `web/src/app/composer.ts` | Chat composer, routines, webhooks and a Labs ticket board: `apps/web/src/pages/shell/composer/use-composer-actions.ts` |
| Steering mid-run | Only through an approval answer's note, or Resume after a stop: `src/api/tasks.ts` | A message sent during a run is claimed into the running turn: `packages/db/src/threads/thread-steering.ts` |
| Review by another model | Codex, Grok or Antigravity reviews the diff; fix rounds; shown as opinion, never a check: `src/engine/review.ts` | An approval model judges each action against the request before it runs (Auto mode): `packages/adapters/src/approvals/auto-review.ts` |
| Delivery | Pushes only the task branch, never by force; one pull request, found before opened, in an append-only ledger: `src/engine/delivery.ts` | Asks a remote coding agent to open a pull request through prompt text: `packages/adapters/src/providers/cloud-agent/t3code/t3code-cloud-agent.ts` |
| Phone access | Web app over a private HTTPS name, one login token, Web Push for approvals and Ready for review: `src/push.ts` | Native iOS and Android apps; Tailscale serve documented and an ingress adapter: `packages/adapters/src/providers/ingress/tailscale/tailscale-ingress.ts` |
| Extending to a new CLI | One driver per CLI behind a capability contract, live tests before merge: `src/drivers/contract.ts` | One provider folder per vendor behind a neutral interface; cloud agents via a provider contract: `packages/adapter-kit/src/cloud-agents.ts` |

## Findings

Ranked by value to someone who hands work over from a phone, walks away, and comes back to a branch they can trust.

### 1. Tell the phone when a task fails or stops

- Rakazo: a failed run sends the person a notification, and work that is stopped for waiting too long sends a "stopped" notification.
- Rakazo file: `packages/adapters/src/runs/lifecycle/run-fail.ts`
- Botbench today: `taskChanged` sends only when the status is `awaiting_decision`; a task that ends `failed` or `interrupted` sends nothing (`src/push.ts`).
- Change: also notify once when a task reaches `failed` or `interrupted`, with the same content limits as today (no command, code or file name).
- Size: small.
- Acceptance: with one subscribed device, a task that ends `failed` causes exactly one push to that device, and its text names the task but no command or file.

### 2. Do not let one unanswered card hold a whole run

- Rakazo: an approval card from a run nobody is watching ends after a set time (30 minutes by default, configurable); the action is not done and the run is told nobody answered.
- Rakazo file: `packages/adapters/src/approvals/approval-expiry.ts`
- Botbench today: a pending approval waits until answered (`src/approvals/broker.ts`), and the build line builds tasks one at a time (`src/engine/task.ts`), so a card at minute three can leave every later task unbuilt for hours.
- Change: an optional per-run limit, off by default, after which a pending approval is answered No by Botbench through the broker, logged as Botbench's answer and not the owner's, with words telling the agent it was unanswered. It only ever declines; it never allows.
- Size: medium.
- Acceptance: in a run with a one-minute limit, a pending approval becomes declined after the limit, the action log has one row with a rule distinct from `owner_declined`, and the command never ran.

### 3. Let the owner send a building task a message

- Rakazo: a message sent while a run is going is taken into that run at its next step instead of waiting, and marked with who sent it.
- Rakazo file: `packages/db/src/threads/thread-steering.ts`
- Botbench today: task routes are decision, discard, resume and pull request (`src/api/tasks.ts`); `sendTurn` rejects while a turn runs (`src/drivers/contract.ts`), so the only way to redirect is a note on an approval answer, and a semi-autonomous run may raise no card at all.
- Change: a route and a box on the task screen that queue an owner note for a building task and deliver it as the next turn's prompt (or after interrupting the turn, if the owner chooses), stored in the transcript as the owner's words.
- Size: medium.
- Acceptance: a note posted to a building task appears in its transcript as the owner's prompt for the next turn; a note posted to a task that is not building is refused with 409 and nothing is stored.

### 4. Remind once, and remember what was sent across a restart

- Rakazo: work left waiting gets one reminder after a set time, recorded as a marker so it is sent once per waiting episode, and is ended after a longer time.
- Rakazo file: `packages/core/src/runs/stuck-work.ts`
- Botbench today: what was announced is held in two in-memory sets, so after a restart a still-pending approval is never announced again, and nothing reminds the owner of a card or a Ready for review task left for hours (`src/push.ts`).
- Change: store each notice sent per approval and task, and send one reminder after a configurable wait for an approval still pending or a task still awaiting a decision.
- Size: small.
- Acceptance: an approval pending past the reminder wait produces exactly one reminder push, and restarting Botbench afterwards produces no further push for it.

### 5. Refuse a repeat of a command the owner already declined

- Rakazo: a call that repeats one a person denied earlier in the run is refused without a new card, because telling the model not to retry did not stop it.
- Rakazo file: `packages/core/src/runs/action-approval.ts` (used by `packages/adapters/src/runs/tools/run-tool-gate.ts`)
- Botbench today: each request becomes a new card; the broker matches earlier answers only for an attempt resumed after a restart (`src/approvals/broker.ts`).
- Change: within one task, a request with the same role, tool, command and directory as one the owner declined is declined without a card, passing back the owner's earlier note, and logged.
- Size: small.
- Acceptance: after the owner declines `sh build.sh` in task T, the same request from T in the same directory creates no pending approval, gets a refusal, and adds one action-log row naming the earlier approval.

### 6. Show what a command would get before you leave

- Rakazo: the approval settings offer a Preview of what would happen for a given tool before any rule is changed.
- Rakazo file: `docs/approvals.md`
- Botbench today: the gate is a function of the request, grants and floor (`src/approvals/gate.ts`), but the Permissions screen only lists and revokes grants (`web/src/screens/trust.tsx`), so the owner cannot check whether `npm test` would run unasked in a semi-autonomous run before handing it off.
- Change: a read-only check on the Permissions screen: repository, mode and command in, the gate's verdict and the floor rule behind it out, writing nothing.
- Size: small.
- Acceptance: the check for `git push` in semi-autonomous mode answers "asks" with the floor rule that names it, and the action log and approvals tables have the same row counts before and after.

## Not worth taking

- An own agent loop with the CLI reduced to a model (`packages/adapters/src/providers/cli-model/claude-code/cli.ts`): ADR 0001 drives the whole CLI because that is what the subscription pays for.
- An approval model that lets actions run when it judges them on-task (`packages/adapters/src/approvals/auto-review.ts`): it puts model output into a safety decision; Botbench's floor is rules, and a review is an opinion.
- Postgres, Graphile Worker and leases across many processes (`docs/run-execution.md`): Botbench is one owner and one process on `node:sqlite`; this adds weight for no user.
- Sending the coding work to a hosted agent (`packages/adapters/src/providers/cloud-agent/t3code/t3code-cloud-agent.ts`): it moves the work and the branch off the owner's Mac, against local by default.
- Passing a CLI sign-in token through the environment (`CLAUDE_CODE_OAUTH_TOKEN` in `packages/adapters/src/providers/cli-model/claude-code/cli.ts`): Botbench never handles credentials, even unread.

## Could not verify

- The clone is present at commit 227e713 with about 6,300 files; whether it matches the upstream repository was not checked. A subset was read: the files named here, `README.md`, `AGENTS.md` and docs on approvals, runs, mobile, clients and computers.
- No file implementing the approval Preview in finding 6 was found; that claim rests on `docs/approvals.md` alone.
- Whether Rakazo's bots "check each other" in groups reviews results the way Botbench's reviewer does was not traced in code.
- Neither project was run. Whether a note can reach Claude Code mid-turn over stream-json, rather than at the next turn, needs a live test on the owner's Mac.
- Botbench's phone notifications are not confirmed on a real iPhone (README), so findings 1 and 4 rest on the same unconfirmed path.
- How long unanswered cards actually sit in real Botbench use, which decides the default for finding 2, is not in either repository.
