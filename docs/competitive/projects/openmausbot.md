# OpenMausBot

| | |
|---|---|
| Repository | https://github.com/milind-soni/OpenMausBot |
| Commit read | 3aec210, 2026-11-23 (shallow clone) |
| Licence | Apache 2.0 for everything outside `enterprise/` (`LICENSE`, `package.json` `"license": "Apache-2.0"`). `enterprise/` is source-available under a separate "OpenMausBot Enterprise License": reading and evaluation allowed, production use needs a licence key, hosting for third parties needs a partner agreement (`LICENSING.md:6-14`). **Nothing under `enterprise/` was opened, listed or searched for this audit.** `LICENSING.md:16-23` says deleting that folder leaves a working open-source edition (`{"edition":"oss"}`). Names and mascot are trademarks of Supamaus Software Private Limited (`LICENSING.md`). Hosted pieces it relies on: Boat (boat.dev) cloud computers, Composio (connected apps), the project's own Cloudflare Workers (`cloudflare/control-plane`, `cloudflare/composio-broker`, source in repo) and MausBot Relay (`relay/`, source in repo). The Admin product for Team Clouds ("openmaus-cloud") is a separate repository not in this checkout (`docs/team-cloud.md:3-6`). |
| Stack | TypeScript run directly with `node --experimental-strip-types` (Node 24+), React 19 + Vite + Tailwind client (`src/`), Electron shells for macOS, Windows and Ubuntu (`electron/`), harness server on `127.0.0.1:8799` (`server/index.ts`, 15,276 lines). State: JSON registries (`bots.json`, `groups.json`), `node:sqlite` for messages and the hand-off runtime (`server/runtime/store.ts:4`), NDJSON event logs per thread, NDJSON decision and usage ledgers, all under `~/.openmausbot` (`server/config.ts:680`). Ships as signed DMG, Windows installer, deb/rpm/AppImage, `npx openmausbot`, Docker and Fly configs (`deploy/`). |
| Size and activity | Very large: about 9,260 files outside `enterprise/` and `.git`; about 312,000 lines of non-test TypeScript in `server/` alone; 3,151 test files across `server/`, `src/`, `shared/`. Version 0.1.177. 31 built-in drivers (`server/drivers/builtIn.ts:34-66`). A docs tree with verification recipes per feature (`docs/verification/`). Comments cite exact CLI versions (Claude Code 2.1.3xx, codex-cli 0.160.1), which says the drivers are tracked against live CLIs. Shallow clone, so commit cadence is not visible. |
| Evidence basis | Source read only; not run. A previous Botbench review (`docs/reviews/design-vs-openmausbot.md` in the Botbench repo) compared the designs; this file goes into mechanism and does not repeat it. |

## Promise and intended customer

README headline: "The open-source Grok Bot alternative: your own team of AI bots, in a chat app." Every bot in a Telegram-style sidebar is "a real agent — Claude or Codex running locally under the hood — with its own personality, its own model, its own cloud computer, and its own connected apps" (`README.md:13-15`). Bring your own agent CLI and subscription, local first.

The customer is an individual (a founder, an operator, a "chief of staff" user) who wants a standing team of assistants for email, calendar, research, posting and some code, reachable from desktop and phone, running on schedules and webhooks. Coding is one use among many; the product's centre of gravity is personal and business automation through connected apps. A second customer is a small team sharing one hosted "Team Cloud" machine with per-person private chats, sold through the closed Admin service.

Against Botbench: same base (drive the owner's CLIs on their subscriptions, broker their permission prompts, phone access), opposite defaults (Full access by default, no worktree, safety floor off by default), and much broader scope (31 engines, computer use, connected apps, voice, rooms, routines, hosted cloud).

## What is actually implemented

| Capability | Evidence level | Source reference | Note |
|---|---|---|---|
| Claude Code, Codex, Grok and many other CLIs as bots | Implemented | `server/drivers/builtIn.ts:34-66`, `server/drivers/claude.ts:1030-1070`, `server/drivers/codex.ts:437`, `server/drivers/acp/core.ts` | Claude over `claude -p` stream-json; Codex over `codex app-server` JSON-RPC; Gemini, Cursor, Copilot, Kimi, Qwen, Droid, Kiro, Devin, OpenCode, Cline, Hermes and others over ACP. |
| Subscription sign-in from the app | Implemented | `server/drivers/claude-login-auth.ts:1-5`, `server/drivers/codex-device-auth.ts:1-10`, `server/engine-homes/layout.ts:54-65` | Runs the vendor CLI's own `claude auth login` / `codex login --device-auth` and relays the link and code. |
| "Keys once, everything lights up"; secrets write-only | Implemented, with exceptions | `electron/main.mjs:364-400`, `docs/cli-onboarding.md:80-84` | Desktop encrypts service keys with `safeStorage` into `credentials.bin`; CLI setup, server mode, OpenCode keys, per-engine keys and MCP header values stay plaintext in `config.json` (0600). |
| Permission broker turning native prompts into chat cards | Implemented | `server/drivers/claude.ts:1145-1150`, `server/permission-proxy.ts:1-37` | `--permission-prompt-tool mcp__ogb__approve` proxied over a Unix socket; broker unreachable means deny. |
| "Bots ask before they act" | Partial | `docs/approval-levels.md:24-31`, `server/drivers/claude.ts:1006-1010`, `server/drivers/codex-approval-config.ts:58-84` | The mechanism exists, but every bot starts at Full access (`bypassPermissions`, Codex `danger-full-access`). Asking happens only at a lower level the person picks. |
| Safety floor never-list | Implemented, off by default | `server/safety-floor-gate.ts:14-16`, `docs/verification/safety-floor.md:1-12` | Root/home `rm -rf`, disk format, fork bomb. Off unless `safetyFloor.enabled` or `OMB_SAFETY_FLOOR=1`; inert on Windows. |
| Connected apps marketplace (Composio) | Implemented (client) / Unverified (hosted) | `server/composio-session.ts:1-3`, `cloudflare/composio-broker/README.md:1-10` | Either your own Composio project key or the project's broker Worker; OAuth tokens live at Composio. |
| Custom MCP servers, with OAuth | Implemented | `server/mcp-gate.ts`, `server/mcp-oauth.ts`, `server/mcp-oauth-store.ts:1-20` | Every MCP server is wrapped in a gate process; OAuth tokens in `mcp-oauth.json` (plaintext, per docs). |
| "Every bot gets a computer" | Implemented (local), Unverified (Boat service) | `docs/computer-use-integration.md:10-52`, `server/container-computer.ts:1`, `server/local-vm-box.ts:1-12` | Three providers: this computer through bundled `cua-driver`; a Docker "Local VM"; a Boat cloud desktop (paid third-party API). |
| Bot teams: Chief of Staff, rooms, hand-offs | Implemented | `server/runtime/types.ts:1-170`, `server/runtime/runtime.ts:198-262`, `server/drivers/agents-catalog.ts:174` | A real hand-off runtime with an assignment tree, budgets, duplicate folding, restart reconciliation (below). |
| Install a team from one Markdown file | Implemented (import) | `server/bot-package.ts`, `server/headless/team-apply.ts` | Not read in depth; packages carry no credentials, memory or permissions per README. |
| Share a bot or department to GitHub | Implemented (not read in depth) | `server/host/share.ts`, `server/composio-share.ts` | |
| Memory per bot, team memory reviewed by admin | Implemented | `server/workspace.ts:30-33`, `server/team-memory.ts:1`, `docs/memory.md` | Plain markdown files; bot-proposed team facts need admin acceptance. |
| Check before done (another model checks the answer) | Implemented, off by default | `server/host/check-work.ts:1-29`, `server/checker-model.ts:5-15`, `packages/phone-protocol/src/check-work.ts:1-12` | Not mentioned in the README. The earlier Botbench review found no such review; it exists, as a per-bot setting. |
| Phone access, E2E relay, QR pairing | Implemented (client and relay code) | `server/phone-relay.ts:1-3`, `relay/src/server.ts`, `server/cli-pairing.ts`, `server/sessions.ts:1` | Relay splices sealed bytes; hosted instance is the project's. |
| Another computer opens this one's bots | Implemented | `docs/desktop-companion.md:1-20` | Over the owner's Tailscale, same tailnet. |
| Linking the owner's computer and their Cloud ("bot link") | Implemented | `server/bot-link/link.ts:1-14`, `server/bot-link/protocol.ts:1-37`, `server/routes/bot-link.ts:8,135` | Same owner only. |
| Team Cloud (several people, one machine) | Partial in this repo | `server/audience.ts`, `server/engine-homes/*`, `server/bot-box/plan.ts:1-30`, `docs/team-cloud.md` | Machine side is here; invitations, roster and signed pairing come from the closed Admin service. |
| Orchestrate from outside over MCP and a headless CLI | Implemented | `scripts/mcp-server.ts:1-15`, `server/headless/run.ts`, `server/headless/team-apply.ts` | MCP excludes approval grants, deletion, credentials (README). |
| Schedules, webhooks, app events | Implemented | `server/routines.ts`, `server/webhooks.ts`, `cloudflare/composio-broker/src/app-events.ts` | App events need the hosted broker (README). |
| Usage caps and ledger | Implemented | `server/usage-ledger.ts:1`, `server/usage-caps.ts:1-3`, `server/limit-resets.ts:1-3` | Estimated dollars and tokens per day and month, per bot. |
| Voice (TTS, calls) | Implemented (not read in depth) | `server/tts/` | Out of scope for Botbench. |

## Architecture

```
Electron main (electron/main.mjs)
 ├─ credentials.bin via safeStorage, cua-driver host, WebContentsView browser panes
 └─ embedded harness server (server/index.ts, 127.0.0.1:8799)
     ├─ driver registry (server/harness/registry.ts) -> 31 drivers (server/drivers/)
     │    each spawns a CLI per conversation: claude -p | codex app-server | ACP agent | HTTP model API
     ├─ permission broker: per-thread Unix socket <- permission-proxy.ts (MCP stdio, spawned by the CLI)
     ├─ MCP gate processes around every MCP server (server/mcp-gate.ts)
     ├─ hand-off runtime (server/runtime/, SQLite) and coordinator (server/coordinator.ts)
     ├─ stores: bots.json, groups.json, messages db, events/<thread>.ndjson, decisions/YYYY-MM.ndjson, usage/
     ├─ optional bot box (Linux bubblewrap) + egress gate + credential broker (server/bot-box/)
     ├─ webhook receiver 127.0.0.1:8800
     └─ outbound: Boat API, Composio session or broker Worker, relay, bot-link to the owner's Cloud
React client (src/) <- HTTP commands + one SSE stream
```

The server's request authentication (`server/request-auth.ts:1-40`) has two kinds of caller: loopback (Host and Origin both loopback) and paired sessions (bearer, cookie or stream ticket; 256-bit, only the SHA-256 stored, `server/sessions.ts:1`). Loopback is "owner" trust on a desktop, "service" trust on a shared server, because there "every bot's shell is a loopback caller too" (`server/request-auth.ts:12-13`). The packaged desktop adds a `loopbackMutationToken` carried over Electron's private child port, so a mutation from a bare loopback caller (a bot's shell) is refused (`server/request-auth.ts:594-599`).

## How agents are connected and managed

**The driver contract.** `server/contracts.ts` defines `ProviderDriver` (`decodeConfig`, `defaultConfig`, `create`) and the `ProviderAdapter` a created instance exposes: `sendTurn`, `interruptTurn`, `respondToRequest`, optional `steer`, `compactSession`, `contextBreakdown`, `cacheKeepWarm`, `prestart`, and an event listener (`server/contracts.ts:253-363`). `EngineAccess` is `"subscription" | "custom" | "api"` (`server/contracts.ts:638`). New drivers are one file plus a line in `server/drivers/builtIn.ts`; any ACP agent can be added from config with no code (`server/drivers/acp/custom.ts`).

**Claude Code launch, in detail** (`server/drivers/claude.ts:1006-1200`):

- `claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-mode <mode>`; mode is `bypassPermissions` for Full, `auto` for "Approve for me", `acceptEdits` for edits, else `default` (`:1006-1010`).
- `--replay-user-messages` when the CLI is new enough, which is how mid-turn steering is confirmed (`:1051-1052`).
- Isolation from the owner's own Claude setup unless `OMB_CLAUDE_INHERIT_USER_CONFIG=1`: `--setting-sources project`, `--strict-mcp-config`, and `claudeMdExcludes` for `~/.claude/CLAUDE.md` and rules (`:1053-1062`, `:1180`). The inherit switch shows a warning naming the token cost (`:140-153`).
- Below Full access, `--permission-prompt-tool mcp__ogb__approve`, with `ogb` an MCP server (`permission-proxy.ts`) that forwards to the broker socket (`:1145-1150`).
- MCP config and settings go into a 0600 temp file, not argv, because argv is readable through `ps` (`:1156-1161`).
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and `CLAUDE_CODE_DISABLE_CRON=1`, because approvals and credentials expire at the turn boundary (`:1184-1185`). Botbench made the same call for the same reason.
- `--resume <session>` or `--session-id <new>` (`:1333-1334`); flags are feature-detected against a per-flag minimum version table (`:199-210`).

**Codex** runs `codex app-server` (`server/drivers/codex.ts:437`), with approval and sandbox set explicitly on thread start, resume and every turn (`server/drivers/codex-approval-config.ts:56-84`): Full is `approvalPolicy: never` plus `danger-full-access`; every other level is `on-request` plus `workspace-write`, with `approvalsReviewer: "auto_review"` for "Approve for me".

**Lifecycle.** A warm CLI process is kept per conversation and replaced when a hashed "spawn contract" (args, system prompt, MCP servers, cwd, model) changes; the close line lists only the changed field names, never values (`server/drivers/claude-spawn-contract.ts:4-34`). A watchdog ends a turn silent for `stallMs`, not counting waits on a person, with a longer allowance while a tool runs and CPU-active shell commands counted as working (`server/turn-watchdog.ts:7-12`). Usage-limit resets are read from plan usage and refusals and saved across restarts (`server/limit-resets.ts:1-3`); a conversation can fail over to a configured backup engine and return after the reset (`server/limit-failover.ts:1-3`).

## Models, tools, subscriptions and environments

**Subscription versus API key.** Native CLIs keep their own logins. The Claude sign-in runs "the unmodified `claude auth login` with pipes, only its sign-in link is shown, the pasted code goes to its stdin", with the stated reason that Anthropic forbids flows that intermediate claude.ai credentials, "hence no OAuth client code in this repository" (`server/drivers/claude-login-auth.ts:1-5`). The environment for a Claude turn strips inherited OAuth variables and deletes an inherited `ANTHROPIC_API_KEY` because it "would flip a subscription login to pay-as-you-go" (`server/drivers/claude.ts:114-135`). Billing is reported per instance as `subscription` or `metered` (`server/drivers/claude-billing.ts:5-10`). Named Claude accounts are separate `CLAUDE_CONFIG_DIR`s; "Claude owns login and credentials; removing an OpenMausBot entry never removes its directory or signs it out" (`server/claude-accounts.ts:1-2`).

One exception to "the CLI owns the login": a ChatGPT-plan path implements its own OAuth PKCE client against `auth.openai.com` with scope `chatgpt.tokens.use.direct`, stores the tokens itself and refreshes them (`server/drivers/chatgpt-plan-auth.ts:10-14,285-370`). That is the pattern Botbench's hard rules forbid.

**Where credentials live.**

| Credential | Store | Source |
|---|---|---|
| CLI subscription logins | The CLI's own files (`~/.claude/.credentials.json`, `~/.codex/auth.json`, ...) | `server/engine-homes/layout.ts:54-65` |
| Service keys (Composio, Boat, voice) on desktop | `credentials.bin`, encrypted with Electron `safeStorage` (Keychain, DPAPI, libsecret) | `electron/main.mjs:364-400` |
| Keys from CLI setup or server mode, OpenCode, per-engine keys, MCP headers | `config.json`, plaintext, 0600 | `docs/cli-onboarding.md:80-84` |
| MCP OAuth tokens | `mcp-oauth.json`, kept apart from `config.json` so an exported config carries no token | `server/mcp-oauth-store.ts:1` |
| Connected-app OAuth | At Composio; the broker Worker keeps the project key and gives each installation a bearer stored only as a SHA-256 hash in D1 | `cloudflare/composio-broker/README.md:1-10` |
| Website logins for bots | The Vault; linked password managers (Bitwarden) read at use time, per-bot allow list | `server/vault/providers.ts:1-2`, `server/host/bitwarden-*.ts` |
| Cloud home secrets | Passed over an inherited pipe, never in a child's environment | `server/cloud-secrets.ts:1-10` |

**Credential broker inside the box.** When the bot box is on, keys stay in the server process and boxed processes get tokens: a box sends `/b/<token>/<grant>/<path>` to a loopback port bridged to the broker's socket; the broker checks the token (bound to bot, conversation and expiry), strips any credential header the client sent, adds the real one and forwards to a fixed upstream the box cannot choose. Tokens die with their process, their conversation's turn, or a 24-hour TTL (`server/bot-box/broker.ts:1-30`). Model calls, MCP servers with secret headers and plain API keys all use this one shape.

**Tools and MCP.** Every MCP server a bot gets, built-in or the person's own, is launched through `server/mcp-gate.ts`, a stdio proxy that enforces the bot's tool scope, trims and pages large results, and answers schema queries (`server/mcp-gate.ts:1-20`). The app's own tools come through an `agents` MCP bridge (`server/drivers/agents-bridge.ts`, catalog in `server/drivers/agents-catalog.ts`): `coordinate_bots`, `assignment_status`, threads, triggers, memory, pages, widgets, computer asks. Project `.mcp.json` servers in the bot's folder are mounted (`server/drivers/claude.ts:1130-1137`). Composio's Tool Router Session provides one MCP endpoint per installation (`server/composio-session.ts:1-3`). Outbound tools (send email, post, pay) are classed separately (`shared/outbound.ts`) and follow the bot's "Sending on your behalf" setting.

**Computer use.** Three providers (`docs/computer-use-integration.md:10-52`): this computer, through a bundled, hash-checked `cua-driver` that Electron owns, reached over a private socket or named pipe; a Docker-backed Local VM running `cua-driver mcp` in a container (`server/container-computer.ts:1`), refused inside the bot box because mounting `docker.sock` is root-equivalent (`server/local-vm-box.ts:1-3`); and a Boat cloud desktop over Boat's API. A Cloud bot that needs the owner's computer raises a "computer ask" card that the desktop app can answer (`server/computer-asks.ts:1-5`). Device-control tools are never remembered as grants (`server/provider-tool-allow.ts:8-9,37-38`). Local computer control below Full access needs the interactive broker (`server/drivers/claude.ts:1011-1014`).

**Isolation.**

- On the owner's desktop: none by default. The bot works in its own folder under the data directory (`server/workspace.ts:21-28`) or a project folder the person set; teammates handed work default to the sender's folder (`server/bot-cwd.ts:56-58`). No git worktree code was found.
- Undo: a shadow git repository per bot and folder snapshots before each turn, with `GIT_DIR` and `GIT_WORK_TREE` set so the person's own `.git` is never touched; adapted from Cline, Roo-Code and Gemini CLI (`server/checkpoints.ts:1-9`).
- The bot box (`server/bot-box/`): Linux bubblewrap, on by default only on a Cloud home, off elsewhere unless `OMB_BOT_BOX=1`; never silently off when wanted (`server/bot-box/detect.ts:1-4,27-38`). It gives the bot an empty private data folder with only its turn's folder, its own folder and named sockets put back, `SOUL.md` read-only, a private PID namespace, seccomp denials, and a network namespace with loopback only; internet goes through an egress gate that resolves names itself and connects only to public addresses (`server/bot-box/plan.ts:1-30`, `server/bot-box/egress-gate.ts:1-4`). No macOS or Windows sandbox was found.

## Context and memory scoping

**Per bot.** `~/.openmausbot/workspaces/<botId>/MEMORY.md` plus `memory/<topic>.md`, `archive.md` and daily `log/` (`docs/memory.md:17-30`). The first 200 lines or 24 KB of `MEMORY.md` load into every system prompt (`server/workspace.ts:30-31`). Writes are 0600, atomic and run through a secret redactor (`docs/memory.md:36-40`). Recall puts up to four notes and four passages from other conversations into the message, not the system prompt, so the cached prompt prefix survives; turns started by another bot, a webhook or a routine recall notes only (`docs/memory.md:86-108`). The Claude CLI's own auto-memory is switched off for isolated bots (`server/drivers/claude.ts:1179`, `CLAUDE_OWN_MEMORY_OFF`). Each bot's prompt carries a "recent-work brief" of its other conversations from the last two days, at most ten lines (`docs/memory.md:346-365`).

**"Dreams" and fact checks.** A nightly helper-model pass files and dedupes notes and strikes contradictions; before a dream saves a fact it must quote the person's own words from the cited conversation, and every number, path and URL must appear in those quotes (`docs/memory.md:478-486`, `server/memory-dream.ts`, `server/memory-fact-checks.ts`).

**Team memory.** Bot-proposed, admin-reviewed facts (person, place, decision, term) shared by a department; "nothing enters shared prompts unreviewed" (`server/team-memory.ts:1`). Optimistic concurrency: stale edits get 409, writes without a revision 428 (`docs/memory.md:470-476`).

**The audience rule on a Team Cloud.** Every stored thing carries an audience: `team`, `room:<id>`, or `member:<person>` (`docs/team-cloud.md:430-445`, `server/audience.ts`). "A turn reads only inputs whose audience includes everyone who will see its answer, and writes only into its own audience." Each audience gets its own engine HOME, so CLI transcripts and session files are separated (`server/engine-homes/layout.ts:1-3`); inside the box, a non-team turn sees the bot's shared folder read-only. The docs list the gaps plainly: without the box, a bot's shell reads every conversation folder and every engine home; engine sign-ins are the team's, so no member can use their own subscription (`docs/team-cloud.md:1077-1121`).

**Shared sign-ins on a Team Cloud.** The team's CLI sign-in files are copied into each audience's home and the newest settled refresh is copied back; inside a box the team's file is bind-mounted so a refreshed token lands in it (`server/engine-homes/sign-ins.ts:1-3,59-85`). One subscription login serves every member of the team.

## Identity, permissions and autonomous execution

**People.** Desktop owner by loopback, or paired devices with sessions. Pairing codes are 60-bit, single use, 10 minutes by default (`server/sessions.ts:1`). On a Team Cloud: Owner, Admin, Member roles, plus guests and Bot API keys; the email sign-in goes through the project's control plane or the server's own SMTP (`server/account-signin.ts:1-3`).

**Levels.** Ask, Auto-accept edits, Approve for me (the engine's own auto reviewer), Full access, and Codex-only Custom (`docs/approval-levels.md:72-80`). "Every bot and conversation starts at Full access" (`docs/approval-levels.md:24`); a hosted company workspace defaults to Ask. A level can be changed mid-turn; how far it reaches depends on who runs the tools (`docs/approval-levels.md:98-120`). A thread a bot opens inherits the opening conversation's level, never above what the person chose there (`server/host/spawn-level.ts`). OpenMausBot adds no review card of its own for its own settings changes: profile, model, skills and team setup apply at once with an Undo receipt (`docs/approval-levels.md:161-168`).

**What is remembered, and how grants are stored.**

| Grant | Key | Scope | Source |
|---|---|---|---|
| Always allow an MCP tool | `provider-tool:<instance>:<server>:<tool>:<sha256(server config)[:16]>`; editing the server invalidates it | Bot, all its threads | `server/provider-tool-allow.ts:33-43` |
| Never remembered | Outbound tools (sends, posts, payments) and anything driving a computer or phone | | `server/provider-tool-allow.ts:8-10,37-38` |
| Exact command rule | Complete command + working folder + provider instance; no prefixes or wildcards; owners and admins only; never copied by templates or backups | Bot | `server/command-allowlist.ts:9-14`, `docs/verification/command-allowlist.md:1-14` |
| Allow for this session | `session:` keys | Thread | `server/index.ts:4704` |
| A bot reading its own files | Built in; plain read commands of plain words inside its own folders only | Every level | `docs/approval-levels.md:11-20` |

Lists are capped at 200; a grant past the cap is refused and the card stays waiting rather than being allowed as if saved; a removal in Settings is taken off every thread and every running turn (`server/always-allow.ts:1-52`). Deny on broker failure: the proxy tells the bot to skip the step and say why (`server/permission-proxy.ts:30-37`).

**Provenance, the strongest idea here.** Every line a bot reads that is not its own person's typed line opens with a harness-written note `[From <who> · <what> · <authority>]`, where authority is exactly one of "their own request", "on their behalf at your level", or "information only" (`server/provenance-label.ts:1-19`). Text from another bot, a webhook, an API caller or a relay is information only, even if it says "approved"; `escapeNotes` defuses imitations in model or person text (`server/peer-provenance.ts:170`, `docs/approval-levels.md:173-195`). The runtime's envelope for every delegated turn is written from stored data, never model text (`docs/runtime-contract.md:61`).

**Bot API fence.** A turn arriving through a public Bot API key runs confined: no shell, no reads outside an empty folder, Ask only, no saved allowance, only hooks mounted (`server/bot-api-fence.ts:1-12`).

**Audit.** Append-only monthly NDJSON decision log, 0600, redacted, fire-and-forget, with kinds `auto-approved`, `auto-denied`, `card-shown`, `user-approved`, `user-denied`, `user-undone`, `review-would-*` and a source per row (`server/decision-log.ts:1-40`). Unattended turns are marked as such (`docs/approval-levels.md:169-171`).

## Coordination of tasks and dependencies

This is the most developed agent-to-agent coordination of any personal tool in the library, and all of it is inside one installation.

**Data structure.** `Assignment` in `server/runtime/types.ts:79-160`: `id`, `rootId`, `parentId`, `depth`, immutable `origin` (person, routine or outside, with the person's own request quoted by the harness), `requester`, `assignee` (bot plus destination: work thread, standing thread or room thread), `mode` (`work`, `consult` = answer only, act on nothing, `notify` = one way), `reply` (`resume`, `poll`, `none`), `brief`, optional `doneWhen`, `status` (`queued`, `running`, `needs_input`, `waiting`, `resume`, `completed`, `failed`, `cancelled`), a typed `outcome` (`done`, `stalled`, `interrupted`, `budget`, `denied`, `duplicate`, ...), `level` and its source, `executions`, `restarts`, `lastActivityAt`, `evidence` (commands, files changed, tool counts, outward actions, observed by the harness, never model text), budgets, a loop `guard`. Stored whole as validated JSON in SQLite (`server/runtime/store.ts:1-30`); an event row per transition.

**Mechanism** (`server/runtime/runtime.ts:198-262`):

- A bot calls `coordinate_bots` with 1 to 4 teammate ids and a message; `tick()` is the only place work is admitted or dispatched (`runtime.ts:1`).
- Refused: assigning back to an ancestor ("results return automatically"), past depth 4, past 24 requests without progress or 300 turns in all for an unattended root (`runtime.ts:221-241`, limits `types.ts:374-386`).
- Duplicate-work avoidance: the same brief, mode and assignee under one parent is the same request and returns the existing assignment with `duplicate: true` unless `rework` is set on a finished one (`runtime.ts:226-231`). It is exact string equality, not semantic.
- Rework between a worker and a checker is capped at 4 rounds per request whatever the models say (`server/host/rework-cap.ts:1-5`); a loop guard counts continuations with no successful tool call (`server/host/loop-guard.ts`).
- Questions: a child parked on `needs_input` surfaces to the person, or under Full access to the requester bot to decide with an optional default (`types.ts:121-128`).
- Results return through one wake lane, an inbox per requester (`types.ts:201`, `InboxItem`).
- Per-thread dispatch claims make a thread read busy while a turn is set up (`server/host/dispatch-claims.ts:1-46`); in memory only.
- Recovery: after a restart, cut turns rerun in place in bursts of four then 500 ms apart; a turn cut twice fails; a cut turn superseded by newer work in its conversation is not rerun (`runtime.ts:28-37`). Stall detection at 20 minutes per turn, 4 hours per tree (`types.ts:382-383`).

**What is missing.** No file or folder locking: teammates work in the sender's folder by default (`server/bot-cwd.ts:56-58`) with no worktree, so two bots editing one repository at once can collide; only the shadow-git checkpoints help undo. No shared task board or claim that outlives the process other than the assignment rows. Dependencies are parent/child only (a parent waits on its children), not arbitrary DAGs between siblings.

**Rooms and the Chief of Staff.** A room is a group chat with a roster and a lead; un-mentioned messages can be routed by a fast decision model (Cloudflare Workers AI, Jev or OpenRouter) with fallback to the lead (`server/decider/room-routing.ts`, README "Fast decisions with Jev"). A Chief of Staff bot manages a department; its level can flow down to the assignments it hands out (`server/host/chief-level.ts`, `server/chief-of-staff.ts`).

## Collaboration between different human owners

**Same owner, several machines: implemented.** The bot link joins a person's computer to their own Cloud "so the bots of each work together as bots of one place do" (`server/bot-link/link.ts:1-14`). Transport: the computer long-polls the Cloud (25 s holds, `protocol.ts:30-32`), both directions ride that exchange, frames may arrive twice and each side acts on an assignment id once (`protocol.ts:1-2`). Remote bots are addressed as `link-<sha256(placeId)[:8]>-<botId>` (`protocol.ts:6-12`). Files up to 20 per assignment, 1.5 MB per exchange, at most 10 computers per Cloud, a link unused for 30 days ends (`protocol.ts:22-37`). Trust: pairing needs the owner's session on a place that is one person's own, "never a team's or a shared server" (`server/routes/bot-link.ts:8,135`). The source names its own open risk: "whoever controls one side can have the other side's bots act at their own approval levels" (`link.ts:12-14`).

**Different people: only by sharing one machine.** A Team Cloud is one hosted server several people sign in to, with the audience rule keeping private chats private, per-person inboxes, presence and away status (`docs/team-cloud.md`, `server/host/team-*.ts`). People collaborate because their bots live in one place, not because two installations talk. The roster, invitations and pairing signatures come from the closed Admin.

**Separately owned installations talking to each other: absent.** No code was found for one person's installation sending work to another person's installation. Bot link refuses team and shared servers by design. Sharing a bot or department is a package export (to GitHub or a folder) with no memory, chats or keys, not a live connection.

## Verification and acceptance of outcomes

- **Check before done** (`server/host/check-work.ts:1-29`): when a bot's setting is on, its final answer to the person is checked by another bot or by a thread of its own on another provider's model (`server/checker-model.ts:5-15`, "since a model rarely catches its own mistakes"), then fixed; at most 3 rounds and 30 minutes (`packages/phone-protocol/src/check-work.ts:9-12`). The verdict is read from the checker's first line only, and anything other than "pass" is never a pass (`check-work.ts:19-29`). On any failure the answer is delivered marked "not checked". Off by default (absent setting means off).
- It checks the answer against the request, not the code against tests. No harness-run test, build or check command, no branch delivery, no accept/reject decision. The runtime's `doneWhen` is a requester's text criterion, and `evidence` is the harness's own count of commands, files and outward actions (`types.ts:146-160`); both are useful inputs to a reviewer but not an acceptance gate.
- Repository practice is strong: verification recipes per feature with exact commands (`docs/verification/`), real-server end-to-end tests with fake CLIs (`server/safety-floor.e2e.test.ts` per `docs/verification/safety-floor.md:64-75`), and an eval suite (`evals/`).

## Install to first useful result

As documented, not run:

1. Desktop: download the signed DMG (or Windows installer, deb/AppImage) and open it; the harness is embedded (`README.md:340-352`). Windows is unsigned.
2. Have at least one agent CLI installed and logged in (`claude`, `codex` or `grok`); they appear in the model picker automatically (`README.md:365-367`). The terminal path offers to install a missing Codex or Claude CLI and runs its sign-in (`docs/cli-onboarding.md:21-25`).
3. Or terminal: `npx openmausbot` runs a Clack wizard: choose ChatGPT/Codex, Claude Code or an API service; sign in or paste a key; choose a model; optionally pair a phone; then it opens the local address (`docs/cli-onboarding.md:19-30`).
4. Optional keys for Composio, Boat, ElevenLabs or Fish Audio; local chat works without them (`README.md:405-416`).

No Docker needed for first run. On a new personal Cloud a "first hour" script run by the Chief greets by name, asks one question, offers Gmail and Calendar, offers the phone and recaps on day two (`server/host/first-hour.ts:1-4`). The first reply on a logged-in CLI is one message away.

## For Botbench

### Learn

- The same base decisions, made independently: drive the unmodified CLI, relay its own sign-in, strip inherited API keys so a subscription never flips to metered, isolate from the owner's personal Claude config, switch off background tasks and cron because approvals end with the turn. Botbench's hard rules are confirmed by a project that arrived at them separately.
- A personal workbench with real agent-to-agent hand-offs needs typed outcomes, budgets and loop caps in code, not prompt text. OpenMausBot's runtime is the reference for what that takes inside one installation.
- Its cross-machine story stops at "same owner". The step Botbench's Peers half wants (two owners, two installations) is the step this project has not taken; its own source names why: control of one side lets you drive the other side's bots at their levels.
- Defaults decide the product. Full access by default and safety floor off make everything else optional; Botbench should keep the opposite defaults and say so.

### Reuse conceptually (with source references)

All of the following are outside `enterprise/` and Apache 2.0: adapting ideas needs nothing; copying code needs the licence and notice kept and an entry in Botbench's `NOTICE`.

1. **Provenance note with three authorities** (`server/provenance-label.ts:1-19,29-37`, `server/peer-provenance.ts:170`). For Peers: every message from another workbench, a GitHub issue or a webhook enters an agent's context wrapped as "information only", and only the harness can write the wrapper. Botbench already treats outside text as data; this gives it one fixed, escape-proof grammar.
2. **Assignment record and admission rules** (`server/runtime/types.ts:79-160`, `server/runtime/runtime.ts:208-262`). Immutable origin with the person's quoted request, typed outcomes, depth and request budgets, duplicate folding by (parent, assignee, brief), refusal to assign back to an ancestor, harness-observed evidence. A direct template for ADR 0004's workbench-to-workbench request: idempotent on id, typed result, budget per root.
3. **Credential broker for boxed processes** (`server/bot-box/broker.ts:1-30`). Tokens bound to bot, conversation and expiry; broker strips client credential headers and forwards to a fixed upstream. Matches Botbench ADR 0002's "secrets stay outside the place an agent's commands run".
4. **Grant keys bound to server config** (`server/provider-tool-allow.ts:33-43`). Fingerprint the MCP server config into the grant so editing the server voids it; never remember outbound or device-control tools. Fits Botbench's grant model directly.
5. **Long-poll link with ack-and-resend** (`server/bot-link/dial.ts:1-12`, `server/bot-link/protocol.ts:1-37`). A home machine with no address dials out; each side resends what is unacknowledged; act once per id. A workable transport shape for Peers through a rendezvous, without opening a port.
6. **Grant list caps that refuse rather than drop** (`server/always-allow.ts:1-52`): a grant that cannot be saved leaves the card waiting; a removal applies to running turns.
7. **Cross-provider checker selection** (`server/checker-model.ts:5-15`) and first-line verdict parsing (`server/host/check-work.ts:19-29`): matches Botbench's review station; the "anything but pass is not a pass" rule is worth stating in Botbench's review contract.
8. **Spawn-contract hash with changed-field names only** (`server/drivers/claude-spawn-contract.ts:4-34`): a safe log line for "why was the warm process replaced".

### Improve on

- **Isolation on the owner's machine.** No worktree, no macOS sandbox; teammates default into the sender's folder (`server/bot-cwd.ts:56-58`); the box is Linux-only and off outside Cloud homes (`server/bot-box/detect.ts:27-38`). Botbench's worktree per task plus macOS sandbox is stronger where both products run.
- **Defaults.** Full access by default (`docs/approval-levels.md:24`), Codex `danger-full-access` at Full (`codex-approval-config.ts:58-71`), safety floor off and inert on Windows (`safety-floor-gate.ts:14-16`).
- **Acceptance.** Check before done is off by default and checks prose against the request; nothing runs tests or hands back a branch for an owner decision (`check-work.ts:1-5`).
- **Credential handling.** Plaintext `config.json` keys in CLI and server mode (`docs/cli-onboarding.md:80-84`), and an own OAuth client for ChatGPT plan tokens (`chatgpt-plan-auth.ts:10-14`). Botbench stores none.
- **Cross-owner collaboration.** Only "one shared machine" (Team Cloud) or "same owner" (bot link). Two people's installations collaborating with each keeping its own subscriptions, policy and audit is open ground.
- **Team Cloud shares one subscription login across members** (`engine-homes/sign-ins.ts:1-3`, `docs/team-cloud.md` "Per-member engine sign-ins"). Botbench's Peers model, where each developer's agents run on their own subscription, avoids the account-sharing question entirely.
- **Duplicate detection is exact string match** (`runtime.ts:226-231`): two slightly different briefs for the same work run twice. Botbench's GitHub-issue claims key on the issue, which is sturdier across machines.

### Deliberately avoid

- Full access as the default, and "Approve for me" delegating decisions to the engine's own reviewer.
- An own OAuth client for a vendor's subscription tokens (`chatgpt-plan-auth.ts`).
- One engine sign-in shared by several people.
- Breadth for its own sake: 31 drivers, voice, mascots, a marketplace. The 312,000-line server is the cost of that breadth; a driver added from config without tests cannot back the claims modes depend on (as the earlier review noted).
- A bot answering another bot's question for the person at Full access (`types.ts:121-128`).
- Anything under `enterprise/`.

## Capability ratings

1. byo-agent-clis: Implemented; Claude, Codex, Grok and a dozen ACP CLIs on their own logins, sign-in relayed from the unmodified CLI.
2. model-providers: Implemented; 31 drivers including OpenAI-compatible, Bedrock, OpenRouter and custom ACP from config.
3. tools-connectors: Implemented; gated MCP for every server, MCP OAuth, Composio apps (hosted), computer and browser tools.
4. isolation: Partial; bubblewrap box with egress gate and credential broker on Linux Cloud homes only; nothing on a desktop beyond shadow-git checkpoints; no worktrees.
5. approvals: Implemented, permissive by default; per-thread broker socket, config-bound grants, exact command rules, deny on broker failure, Full access default, safety floor off.
6. memory-scoping: Implemented; per-bot markdown memory, admin-reviewed team memory, audience rule with per-audience engine homes on a Team Cloud (enforced fully only with the box).
7. identity-authz: Partial; loopback owner plus hashed paired sessions locally; roles and invitations on a Team Cloud depend on the closed Admin.
8. task-coordination: Implemented within one installation; assignment tree with budgets, depth cap, duplicate folding, rework cap, restart reruns; no folder locking.
9. cross-owner: Partial; several people only by sharing one hosted Team Cloud; no collaboration between separately owned installations.
10. peer-transport: Partial; same-owner bot link (long-poll, idempotent ids) between a computer and its Cloud, Tailscale desktop-to-desktop; nothing across owners.
11. verification: Partial; optional cross-provider "check before done" on the answer text, harness-observed evidence; no tests run, no branch, no owner accept.
12. durability: Implemented; SQLite assignments with restart reconciliation, saved limit resets, resume cursors, stall watchdog.
13. budgets-usage: Implemented; append-only usage ledger, daily and monthly caps per server and bot, subscription versus metered billing per instance.
14. audit-observability: Implemented; append-only redacted decision log, per-thread NDJSON events, usage traces.
15. remote-mobile: Implemented; QR pairing, E2E-encrypted relay (hosted by the project), native phone apps, Tailscale.
16. time-to-first-result: Low effort; signed desktop installer or `npx openmausbot` with a wizard that relays the CLI's own sign-in; no Docker.

## Open questions

- Whether mid-turn level changes, steering and stall detection behave as documented with the current Claude Code and Codex releases.
- How often two bots handed work in the same folder actually collide, and whether checkpoints restore cleanly when they do.
- Whether `loopbackMutationToken` really keeps a bot's shell on the owner's desktop from changing its own level through the local API (for example to Full access).
- How the closed Admin signs Team Cloud pairings and rosters, and what trust a member's device places in it.
- Whether the bot link's open risk (one side driving the other's bots at their levels) is reachable in practice from a compromised Cloud.
- Whether "Approve for me" on Claude (`--permission-mode auto`) and Codex (`auto_review`) ever approves an outbound or destructive action without a card.
- What the hosted relay, control plane and Composio broker log about an installation in production.
