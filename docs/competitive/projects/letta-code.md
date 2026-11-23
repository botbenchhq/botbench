# Letta Code

| | |
|---|---|
| Repository | https://github.com/letta-ai/letta-code |
| Commit read | dc5bcdd, 2026-11-23 (shallow clone) |
| Licence | Apache 2.0 for the whole repository (`LICENSE`). No enterprise folder. The hosted parts it leans on (Letta Cloud agent state, MemFS git hosting, shared-memory repositories, secrets, remote computers, chat.letta.com, cloud reflection runs) are a closed service and are not in this repository |
| Stack | TypeScript; Bun for development, a Node-targeted bundle for release; Ink TUI; a websocket "app-server" listener (`src/websocket/`); `@letta-ai/letta-client` for the Letta API; `@earendil-works/pi-ai` for direct provider calls in the local backend. Agent memory is a git repository of markdown files per agent. Ships on npm, PyPI (Node bundled), Nix |
| Size and activity | About 2,000 files under `src/`, 98 MB clone. Strict architectural lint (layer boundaries, no cycles, 1,000-line ratchet, see `CLAUDE.md`). Tests beside sources. A mature, fast-moving product codebase |
| Evidence basis | Source read only; not run |

## Promise and intended customer

"A stateful agent harness for creating agents that are more like people than tools" (`README.md:5`). The customer is a developer, or a small team, who wants one long-lived agent with a persona and memory that follows them across the terminal, the browser, phone, Slack, Telegram and Discord, and across machines. Letta Cloud is the default home of the agent's state (`README.md:62`, `README.md:68`). The pitch is learning over time: the agent rewrites its own memory, skills and prompts, and background "dreaming" (sleep-time reflection) does the same between conversations.

## What is actually implemented

| Capability | Evidence level | Source reference | Note |
|---|---|---|---|
| Git-backed memory filesystem (MemFS) per agent | Implemented | `src/agent/memory-filesystem.ts:40-50`, `:219-245` | `~/.letta/agents/<agent-id>/memory`, cloned from and pushed to Letta's git proxy (`src/backend/api/memfs-git-proxy.ts`) or a local repo in local mode |
| Memory files as editable system-prompt segments | Implemented | `src/agent/prompts/letta_root_memfs.md:26-35`; `src/agent/memory-filesystem.ts:252-393` (tree render) | Root markdown files are "core memory" compiled into the system prompt; child directories with their own `MEMORY.md` are external memory |
| Memory commit validation | Implemented | `src/agent/memory-git-hooks.ts:37`, `:135`, `:162` | Installed pre-commit hook rejects memory files with bad frontmatter |
| Self-improvement / dreaming (reflection subagent) | Implemented | `src/agent/subagents/builtin/reflection-v2.md`; `src/agent/memory-worktree.ts:124-200`, `:359-655`; `src/cli/helpers/memory-reminder.ts:48-50` | Background subagent reads transcripts and commits to memory in a git worktree; default trigger is a compaction event, or every N steps |
| Skill learning | Implemented | `reflection-v2.md:29-41` ("at most one skill change per run"); `src/agent/skills.ts:139-230` | Skills are folders with `SKILL.md`; four sources: bundled, global, agent (in MemFS), project (`.agents/skills`) |
| Shared memory between agents | Implemented (client) / Unverified (server) | `src/agent/shared-memory-skills.ts:111-177`; `src/agent/attached-repository-git-sync.ts:196-237`; `src/skills/builtin/managing-shared-memory/SKILL.md` | Org-owned git repositories on Letta Cloud attached to several agents; client mounts, pushes after each turn, rebases once on collision. Cloud-only (`shared-memory-skills.ts:132-136`) |
| Cross-agent memory isolation on one machine | Implemented | `src/permissions/cross-agent-guard.ts:40-56`, `:233-282`; `src/sandbox/AGENTS.md`; `src/agent/subagents/sandbox.ts:48-119` | File-tool guard plus Seatbelt/bwrap/Windows kernel sandbox for shell commands and memory subagents |
| Subagents (general-purpose, fork, recall, memory, init, reflection) | Implemented | `src/agent/subagents/builtin/*.md`; `src/agent/subagents/subagent-launcher.ts:180-240`; `subagent-depth.ts:6` | Separate processes; max depth 2 |
| Drive other vendors' coding CLIs as subagents | Implemented | `src/tools/impl/external-coding-agent.ts:47-52`; `claude-stream-session.ts:56-87`; `codex-app-server.ts:159-161`, `:640-652`, `:712-713`; `cursor-session.ts`; `opencode-session.ts` | Claude Code, Codex, OpenCode, Cursor. Launched with all approvals off (see below) |
| Agent-to-agent messages | Implemented | `src/tools/impl/send-agent-message.ts` (631 lines) | Any agent, including on another computer through the cloud |
| Message search across agents | Partial | `src/backend/message-search.ts`, `src/backend/conversation-search.ts` | Client exists; cross-agent search depends on the server |
| Remote computers | Implemented (client) / Unverified (relay) | `src/websocket/listener/`, `src/tools/impl/remote-external-coding-agent.ts`, `README.md:81-101` | `letta server` registers a machine with the cloud relay; routing is server-side |
| Secrets hidden from context | Implemented (client) | `src/tools/secret-substitution.ts:224-281`; `src/utils/secrets-store.ts` | `$NAME` substitution at exec time, output scrubbed. Values come from the server |
| Messaging channels (Slack, Telegram, Discord, Signal, WhatsApp) | Implemented | `src/channels/*`; `src/channels/access-control.ts:124-171` | Allowlist, pairing and admin gates per channel |
| Crons and heartbeats | Implemented | `src/cron/scheduler.ts`, `src/cron/runner.ts` | Local scheduler; cloud-managed variant too |
| Permission modes and hooks | Implemented | `src/permissions/mode.ts:1-25`; `src/hooks/` | Default mode is `unrestricted` (`mode.ts:7`) |
| Local backend without Letta server | Partial | `src/backend/local/local-backend.ts:136-141`; `src/backend/local/paths.ts:10-20` | Exists, named "experimental"; no shared memory, secrets server, remote computers or cloud reflection |
| Task list with owners and dependencies | Partial | `src/tools/impl/tasks/store.ts:3-17`, `:117-122` | In-memory `Map` per process, has `owner` and `blockedBy`; not durable, not shared |

## Architecture

```
 letta (TUI, src/cli)  | headless (-p)  | letta server (websocket listener, src/websocket)
            \                 |                   /
           agent domain (src/agent): conversation loop, approvals, memory, subagents
                              |
           Backend interface (src/backend/backend.ts:175-192)
            /                                         \
   APIBackend -> Letta Cloud / Letta server      LocalBackend -> pi-ai -> provider APIs
   (agent state, conversations, MemFS git,       (records under ~/.letta/lc-local-backend,
    shared repos, secrets, relay, reflection)     local git MemFS)
```

- `BackendCapabilities` (`src/backend/backend.ts:175-183`) is the switch: `remoteMemfs`, `serverSecrets`, `environmentRouting`, `localMemfs`. `APIBackend` sets the cloud ones (`:371-382`), `LocalBackend` sets `localMemfs` only (`src/backend/local/local-backend.ts:136-141`).
- Agent identity is a server-side agent record (id, tags, model, system prompt); the MemFS is a git repository that the server hosts and the client checks out. A tag on the agent marks MemFS as on (`memory-filesystem.ts:177-186`).
- The v2 app-server protocol (`src/types/protocol_v2.ts`) runs many agent/conversation runtimes in one process for the desktop app and the cloud relay.

## How agents are connected and managed

- **Letta agents.** One agent type, the Letta loop, on any model in the runtime catalog (`src/agent/model-catalog.ts`). Personality presets seed memory files (`src/agent/personality-default-files.ts`).
- **Built-in subagents** are markdown files with frontmatter (`tools`, `model`, `skills`, `launchProfile`), parsed in `src/agent/subagents/index.ts:129-258`. A new subagent type is a new markdown file. Each runs as a child process with `LETTA_CODE_AGENT_ROLE=subagent` and `LETTA_PARENT_AGENT_ID` (`subagent-launcher.ts:194-201`). Depth limit 2, and only full-capability children get the `Agent` tool (`subagent-depth.ts:6-31`).
- **External coding agents.** `EXTERNAL_CODING_AGENT_TYPES = claude-code, codex, opencode, cursor` (`external-coding-agent.ts:47-52`). Claude Code is spawned with `--print --input-format stream-json --output-format stream-json ... --permission-mode bypassPermissions` (`claude-stream-session.ts:56-68`), Codex through `codex app-server --stdio` with `approvalPolicy: "never"` and `sandbox: "danger-full-access"` (`codex-app-server.ts:647-648`, `:712-713`). The native session id is captured so the parent can resume or send follow-ups (`native-session-capture.ts`, `send-agent-message.ts:33-50`). They use the CLIs' own sign-ins (`CODEX_NOT_SIGNED_IN_ERROR`, `external-coding-agent.ts:35`). The parent's memory location is pointed to in a note, read-only by request (`src/agent/parent-memory-note.ts:4-14`).

## Models, tools, subscriptions and environments

- **Models.** Cloud mode takes hosted models from the server catalog plus org BYOK rows; local mode uses pi-ai's catalog (`CLAUDE.md` "Runtime Model Catalog"). `/connect` adds API keys or a ChatGPT plan; ChatGPT quota exhaustion rotates handles (`src/agent/chatgpt-plan-rotation.ts:16-30`).
- **Credentials.** Local provider keys sit in an owner-only file written atomically (`src/backend/local/local-provider-auth-store.ts:135-138`, 0700/0600) or the OS keychain (`LETTA_SECRETS_SERVICE_NAME`). Agent secrets come from the server and are injected as environment variables at exec time, with output scrubbed (`src/tools/secret-substitution.ts`). External coding agents receive the full process environment plus the agent's secrets (`external-coding-agent.ts:506-513`), so secrets are inside the place the agent's commands run.
- **Tools.** Bash/exec, file tools, LSP, MCP (unified MCP through the server, `src/backend/api/unified-mcp.ts`), monitors, PR watching, worktree enter/exit, workflows.
- **Isolation.** Kernel filesystem sandbox (Seatbelt, bwrap, Windows restricted tokens) aimed at memory: it denies the agents tree and carves out the current agent's own memory; repo, home and tmp stay writable and the network stays open (`src/sandbox/AGENTS.md`, `src/sandbox/policy.ts:23-90`). An optional workspace sandbox confines to a root inside an isolation root (`src/permissions/workspace-sandbox.ts:20-50`). Git worktrees are a tool the agent can enter (`src/tools/impl/enter-worktree.ts`), not a per-task rule.

## Context and memory scoping

This is the core of the project. The layers, as source shows them:

| Layer | Where | Scope | Who writes |
|---|---|---|---|
| Core memory (root `.md` files + `MEMORY.md` index) | `~/.letta/agents/<id>/memory/` | Per agent, all projects, all machines (synced) | The agent itself, its reflection subagent |
| External memory (indexed child dirs, files) | same repo | Per agent | Same |
| Agent skills | `.../memory/skills` (`src/agent/skills.ts:18-19`) | Per agent, all workspaces | Agent, reflection (one skill change per run) |
| Project skills | `<cwd>/.agents/skills` (`skills.ts:139`) | Per repository | Whoever commits them |
| Global skills | `~/.letta/skills` | Per machine user | User |
| Shared memory repositories | cloud repo mounted next to the agent's memory dir | Per org, attached to N agents | Any attached agent with write permission |
| Recall | server conversation history | Per agent (search can span agents) | Harness |

- **Per agent, not per project.** The prompt states agent skills are "available to the agent across all environments and all workspaces" (`letta_root_memfs.md:41`). Nothing keys memory by repository. An agent used on two clients' code carries one memory across both; the only project-scoped layer is `.agents/skills`.
- **Between agents on one machine.** `evaluateCrossAgentGuard` (`cross-agent-guard.ts:233-282`) refuses file-tool paths under another agent's memory tree, checking both lexical and real paths. Allowed ids are self plus parent (`:40-56`). Shell commands skip this guard (`:248-250`) and are instead wrapped in the kernel sandbox. Subagents cannot disable the guard (`:30-38`, `:225-230`).
- **Shared memory.** One mount per agent per repository, so another agent's mount of the same repository is still walled off (`SKILL.md:79`). Conflict handling: push, on rejection `pull --rebase` and retry once, otherwise a reminder on the next turn (`attached-repository-git-sync.ts:196-237`).
- **Between people.** One agent can serve several people (Slack channels). Each user message carries `acting_user_id` (`src/agent/message-attribution.ts:7-20`, header `X-Letta-Acting-User-Id` in `src/agent/acting-user.ts:1`), so the server can attribute, but the memory is one per agent: what one person tells a shared agent can surface for another. No per-person memory partition is in the client.
- **Poisoning.** The reflection subagent reads whole transcripts, tool results included, and may write instructions into core memory (`reflection-v2.md:9-41`). There is no rule limiting capture to the user's own words. Mitigations are provenance and reviewability, not capture limits: commits must cite sources (`managing-shared-memory/SKILL.md:84-101`), and the prompt tells the agent recall is its own past, never injected (`letta_root_memfs.md:97`).

## Identity, permissions and autonomous execution

- Human identity is the Letta account (`/login`); org id resolves server-side (`src/agent/organization-id.ts`). Agent identity is the server agent id; subagents inherit parent id via env.
- Permission modes `standard`, `acceptEdits`, `unrestricted`, `strict`, default `unrestricted` (`src/permissions/mode.ts:1-14`). Rules and an analyzer in `src/permissions/checker.ts`, `analyzer.ts`, `shell-analysis.ts`.
- Channels gate who may talk to an agent: allowlist, pairing, admin-only commands (`src/channels/access-control.ts:124-171`, `:205-226`). Slack has an approval controller for tool approvals in-thread (`src/channels/slack/approval-controller.ts:33`).
- External coding agents run with no approvals at all (see above). Crons and heartbeats let agents act unattended.
- Audit is git history of memory (with author `Reflection Subagent <id>@letta.com`, `reflection-v2.md:57-67`) plus server conversation history and telemetry. There is no append-only local action log.

## Coordination of tasks and dependencies

- Parent-child only. The parent launches subagents (foreground or background, `src/agent/subagents/manager.ts`), can send them follow-ups and stop them (`tools/impl/task-stop.ts`, `send-agent-message.ts`).
- The `TaskCreate/TaskUpdate/TaskList` tools keep a per-process `Map` with `owner` and `blockedBy` (`tools/impl/tasks/store.ts:3-17`, `:117-122`). It is the agent's to-do list, not a claimable queue.
- Reflection runs coordinate with the primary agent through git: the worktree finalizer returns `no_changes`, `dirty_uncommitted`, `parent_dirty`, `failed` or `merged` (`memory-worktree.ts:359-470` and following), the transcript counts as consumed only when memory lands on main, and with `merge: "explicit"` the primary agent's integration conversation performs the merge (`src/reflection-settings.ts:1-17`).
- No claims, leases or duplicate-work avoidance between independent agents. Shared memory is last-writer-with-rebase.

## Collaboration between different human owners

Only inside one Letta organization. Shared memory repositories are org-owned (`SKILL.md:8`), agents can be attached to them, and any agent can message any other agent the account can see, across computers, through the cloud relay. Two people in separate organizations, or one on a local backend, have no transport: shared memory returns nothing unless `isLettaCloud()` (`shared-memory-skills.ts:132-136`). Trust is the cloud account and org membership; there is no peer-to-peer channel or per-peer grant.

## Verification and acceptance of outcomes

No outcome gate. The agent reports; the human reads. Memory has structural checks (frontmatter pre-commit hook, `memory-constraints.ts`, `/doctor` for prompt size). The reflection harness never resolves merge conflicts semantically and preserves the branch on failure (`CLAUDE.md` "Reflection Worktree"). PR watching tools (`tools/impl/watch-pr.ts`, `github-pull-request-tracker.ts`) let an agent follow CI, but nothing accepts or rejects a result.

## Install to first useful result

As documented: `npm install -g @letta-ai/letta-code` or `uv tool install letta`, run `letta` in a project, choose Letta sign-in or local, then `/connect` a provider key or ChatGPT plan if local (`README.md:39-64`). Node 22.23+/24/26. Cloud sign-in is the default path and needed for shared memory, remote computers, secrets and chat.letta.com. No Docker.

## For Botbench

### Learn

- Memory that is a git repository of markdown gives history, blame, review and sync for free; Letta built its whole learning story on that, which supports ADR 0005's choice of git for project knowledge.
- Self-writing memory is the product here, and the source shows its cost: the reflection subagent reads tool results and outside text and can turn them into standing instructions. Botbench's ADR 0005/0006 stance (capture only the owner's words) is the safer end of that trade; Letta's provenance rules are what make the other end auditable.
- Driving Claude Code and Codex as subagents is real here, but with all approvals switched off. A memory-first harness that wraps vendor CLIs does not by itself give control around them.

### Reuse conceptually (with source references)

Apache 2.0: patterns may be adapted with attribution in `NOTICE` if any code is copied; ideas need none.

1. **Provenance in the commit, rule in the file.** `src/skills/builtin/managing-shared-memory/SKILL.md:84-101`: one learning per commit, subject states the learning, body tells what happened, `Sources:` lists conversation and message ids, "Sources: unknown" rather than invented. Botbench's lesson-branch commits (ADR 0005 item 4) could carry the task id, decision id and date in this form, which keeps the learning file short.
2. **Reflection on a branch, merged by a harness with explicit states.** `src/agent/memory-worktree.ts:124-200` creates `letta/<label>/<id>` from the base HEAD, and `:359-655` finalizes as `no_changes`/`dirty_uncommitted`/`parent_dirty`/`failed`/`merged`; the transcript counts as consumed only when it lands. When Botbench adds model-driven capture (ADR 0006 Deferred), the same shape fits its lesson branches and gives a retry rule.
3. **Scope a memory writer by filesystem, not by prompt.** `src/agent/memory-worktree.ts:190-198` (writable: worktree and git common dir; read-only: parent) and `src/agent/subagents/sandbox.ts:48-119` wrap the memory subagent in Seatbelt/bwrap with exactly those roots. Botbench already confines commands; a capture or upkeep agent could get only `~/.botbench/memory` writable.
4. **Deny other agents' memory by path, lexical and real.** `src/permissions/cross-agent-guard.ts:158-212` classifies every path argument against the agents tree, including symlink-resolved roots and recursive tools pointed at an ancestor. Useful if Botbench ever splits the store per agent or per peer.
5. **Four skill sources with explicit selection.** `src/agent/skill-sources.ts:1-89` (`bundled, global, agent, project`, `--skill-sources`, `--no-skills`) is a clear model for which knowledge layers a run gets, and a precedent for Botbench's deferred per-repository scope.
6. **Memory layout for prompt budget.** Root index `MEMORY.md` plus core files with `name`/`description` frontmatter, deeper detail behind indexed child directories (`letta_root_memfs.md:26-35`), and a bounded tree render that says what it left out (`memory-filesystem.ts:298-390`). Botbench's single `MEMORY.md` index with capped, newest-first notes is the same idea at smaller size.

### Improve on

- **Approvals around vendor CLIs.** Letta launches Claude Code with `bypassPermissions` (`claude-stream-session.ts:66-67`) and Codex with `approvalPolicy: "never"`, `danger-full-access` (`codex-app-server.ts:647-648`). Botbench's broker and safety floor around the same CLIs are a clear difference.
- **Secrets outside the command environment.** External agents get the full parent environment plus agent secrets (`external-coding-agent.ts:506-513`). Botbench's launch allowlist and ADR 0002 are stricter.
- **Per-project memory.** Letta has none beyond project skills; one agent's memory follows it into every repository (`letta_root_memfs.md:41`). Botbench's repository learnings plus a workbench store, with a future per-repository scope, can keep client A's facts out of client B's work.
- **Per-person memory on shared agents.** Attribution exists (`message-attribution.ts`), partition does not. Botbench's Peers, where each person keeps their own store and shares only reviewed repository text, avoids that leak by construction.
- **Collaboration without a vendor cloud.** Shared memory, cross-machine messaging and remote computers all require Letta Cloud (`shared-memory-skills.ts:132-136`, `memory-filesystem.ts:559-568`). Botbench sharing through the project's own git remote and GitHub needs no third party.
- **Durable tasks.** The task store is an in-memory `Map` (`tools/impl/tasks/store.ts:17`); Botbench's SQLite-backed tasks and runs already survive restarts.

### Deliberately avoid

- Letting a background model write standing instructions from transcripts that include tool output, without a capture rule (`reflection-v2.md:29-41`).
- Default permission mode `unrestricted` (`permissions/mode.ts:7`).
- Making the vendor's cloud the default home of agent state and the only path to sharing.
- Prompt text that tells the model to "ALWAYS" obey a self-written persona (`letta_root_memfs.md:82-88`): self-written memory gains instruction authority.

## Capability ratings

1. byo-agent-clis: Implemented, drives Claude Code, Codex, OpenCode and Cursor on their own sign-ins, but with approvals off.
2. model-providers: Implemented, hosted catalog plus BYOK and pi-ai providers, ChatGPT plan rotation.
3. tools-connectors: Implemented, MCP via server, channels, monitors, PR watching, skills from GitHub and hubs.
4. isolation: Partial, kernel filesystem sandbox aimed at memory trees; network open, worktrees optional, no container.
5. approvals: Partial, permission modes and rules plus Slack approvals; default unrestricted, external CLIs bypass.
6. memory-scoping: Implemented, per-agent git MemFS, org shared repos, cross-agent guard; no per-project or per-person scope.
7. identity-authz: Partial, Letta account and org server-side; channel allowlists and pairing in client.
8. task-coordination: Partial, parent-child subagents and an in-memory task list; no claims or leases.
9. cross-owner: Partial, only inside one Letta organization through cloud-hosted shared memory and messaging.
10. peer-transport: Unverified, cloud relay for computers and agent messages is server-side; no peer-to-peer.
11. verification: Absent, no outcome gate; only memory structure checks.
12. durability: Partial, agent state and conversations durable on the server; local task list and reflection counters per process.
13. budgets-usage: Partial, usage cost pricing (`src/usage/cost.ts:43-89`) and stats; no budgets found.
14. audit-observability: Partial, git history of memory with authored commits, telemetry; no append-only action log.
15. remote-mobile: Implemented (client) / Unverified (service), chat.letta.com, channels and remote computers through Letta Cloud.
16. time-to-first-result: Low effort, one package install and a sign-in or API key, no Docker.

## Open questions

- How well reflection-written memory holds up over months: drift, bloat, and whether the "explicit" merge mode catches bad learnings.
- Whether a self-hosted Letta server can serve MemFS and shared memory at all; the client checks for `api.letta.com` (`memory-filesystem.ts:559-568`).
- How the server partitions recall and memory between people talking to one shared agent, beyond the `acting_user_id` attribution.
- How the Claude Code and Codex subagents behave on the owner's subscriptions under long background runs, and whether their transcripts feed reflection.
- Whether the local backend is complete enough for daily use without the cloud.
