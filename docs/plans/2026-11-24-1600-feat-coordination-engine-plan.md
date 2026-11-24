---
title: Coordination engine, first milestone - Plan
type: feat
date: 2026-11-24
status: proposed
supersedes: the "Botbench Swarm Coordination: PRD", draft v1 of 24 Nov 2026 (not in the repository)
---

# Coordination engine, first milestone - Plan

The draft PRD proposed a local engine that tells every coding agent and every person who is touching which files and functions. The owner reviewed it on 24 November 2026 and kept its direction, with these changes: three kinds of record instead of one lease model, remote state that only advises, permissions that stay the agent's own, and a first milestone that shows two developers' agents coordinating. This plan is the PRD with those changes. The decision behind it is [ADR 0013](../adr/0013-headless-first-coordination.md). Nothing here is built.

Every number below marked **Target** is a goal, not a measurement. No result exists yet.

## North Star and the milestone test

**North Star:** you and a coworker start your usual agents and give them related work. Botbench helps them avoid or resolve a specific overlap, and neither of you carries information from one conversation to the other. Independent work goes on with little interruption.

**Milestone test (yes or no):** two developers on two machines each run an ordinary agent session that Botbench did not launch. One agent records an intent on an area. The other agent receives it and changes what it does: it works elsewhere, waits, or asks. The change shows in its transcript and in the event log.

The local engine on one machine is an engineering step towards that test. On its own it is not the milestone.

## What it keeps from the PRD

- Agents keep running in their own CLIs. Botbench takes part without owning their task or launching their session.
- Hooks do the automatic coordination. MCP is for deliberate requests, so an agent never has to remember a ritual before each action.
- The CLI, MCP and the optional interface all read the same state.
- Planning stays with the agent that already has the task. Botbench adds no plan layer.
- Installing is an explicit command that shows its diff first, and it can be fully removed.
- No source code leaves the machine: only keys, hashes and metadata.

## Three records, not one lease

The PRD used one lease, with a time-to-live and a heartbeat, for three different things: a write happening now, work someone has said they will do, and a change that sits on a branch nobody has merged yet. Each needs its own lifetime.

| Record | What it means | Where it lives | When it ends |
|---|---|---|---|
| **Mutation lease** | A hooked tool is making one particular write in one particular checkout. | That checkout only. | The write completes or fails, or a short bounded recovery passes. |
| **Work intent** | A session expects to change an area, or to provide something another session needs. | The machine. Shared with teammates in the milestone. | Explicit update or release. Otherwise it is shown as **stale**, with its age, and never silently dropped. |
| **Change record** | A branch or revision holds work that may interact with other work. | Read from git: local branches and the remote. | Superseded, abandoned, or merged. |

Consequences:

- **A mutation lease never leaves its checkout.** Only one checkout holds the same bytes, so contention over a write can only happen inside one shared checkout. Separate worktrees, and separate machines, never contend for a mutation lease. Between them only intents and change records travel.
- **So the speed of the transport only matters for intents and change records.** These stay current for minutes or hours, so a delay of under a minute (**Target**) is acceptable. The milestone does not promise immediate coordination between developers, and it says so.
- **A session's activity does not renew everything it ever touched.** A mutation lease is renewed by nothing and lasts as long as its write. An intent is renewed only by an update to that intent.
- **A session that ends leaves its change record behind.** Its intents become stale, but its branch still exists. So another agent still sees the work until it is merged or abandoned. That is the case where the PRD's single lease failed: the API change was released when the session ended, yet its branch would still meet the coworker's work.

## Admission is one atomic operation

For a write path the engine supports, the hook makes one request that checks the whole set of resources and takes the mutation lease in one step: `admit`. A separate `status` or `check` only reads, and it never grants. A check followed later by a claim would leave a gap for another session to take the resource in between.

An admission is tied to the actual operation and the state it starts from:
- the tool and its arguments, as the hook received them;
- the file's content hash before the write;
- the kind of change, worked out from the operation itself and not from what the agent said. A whole-file replacement counts as a change to the whole file, even when the stated intent names one function.

## Permissions stay the agent's own

"No coordination conflict" never becomes "this action may run".

- A conflict can add a denial, with a reason the agent reads.
- With no conflict, the adapter gives no permission decision, so the CLI's own permission rules decide. Claude Code's PreToolUse `permissionDecision: "allow"` skips its normal prompt, so the adapter never sends it. It may add context the agent reads (see "How the agent hears about other work"), but never a decision.
- A coordination timeout or failure prints nothing, and is logged as a fail-open event.
- A denial from the CLI's own policy, or from Botbench's broker and safety floor, stays a denial.

Botbench already works this way: `hookOutput` in `src/approvals/permission-proxy.ts` prints nothing on a pass. The coordination adapter reuses that contract.

For sessions Botbench launches, the broker and safety floor decide first and deny on failure. The coordination check runs only after they pass, and it allows on failure. Coordination prevents collisions; it is not a safety control. The PRD's "secrets" escalation point is dropped: secrets belong to `src/approvals/floor.ts`, and the coordinator gets no rule of its own about them. The escalations this plan adds are only those that coordination itself raises.

## What the engine promises, exactly

The promise covers supported write tools, participating sessions, and a healthy coordinator with current state. Under those conditions, a conflicting write is refused before it runs. Everything else gets a named **coverage state** instead of a promise:

| Coverage state | Example |
|---|---|
| `covered` | A Claude Code `Edit` or `Write` that the hook admitted or refused before it ran. |
| `uncovered` | A change found afterwards with no admission behind it: a shell redirect, a formatter, more input sent to a running process. Codex's hook documentation, as cited in the owner's review of 24 Nov 2026, says `write_stdin` into an existing session triggers no new pre-tool hook, and warns against treating hooks as a complete enforcement boundary. The link is added when P1.4 confirms it. |
| `fail-open` | The coordinator was unavailable or ran past its time budget, so the write went through. |
| `stale` | The decision used remote state older than its freshness limit. |

Three counts sit next to every collision count: covered write attempts, uncovered changes, and fail-open events. Without them the engine could look fast because it often stopped coordinating.

## Changes nobody recorded, and what they prove

A change that no agent journal accounts for could come from a person, a formatter, a code generator, an agent without hooks, a missed event, or work from before Botbench started. The observation is certain; who made it is not. The engine records what it actually knows:

| What is seen | What the engine says |
|---|---|
| A dirty file with no matching agent write | An unattributed local change exists. |
| A remote branch that differs from its base | Published work touches these files. |
| A commit by Bob | Bob is the recorded author of that commit. |
| An intent from Bob's connected session | That session reports this intent, last seen at this time. |

Remote git state cannot show Bob's unpushed edits, or what he is doing right now. A colleague without Botbench is still covered by their published work, and the interface says "published work" for that, never "live".

## How the agent hears about other work

A remote intent only advises, and a mutation lease never crosses machines. So if nothing pushes it, the second developer's agent only learns about the first one's intent when it chooses to ask, which is exactly the ritual hooks exist to avoid. The milestone needs a delivery path that runs without the agent asking:

- **At session start and with each prompt:** the session-start and prompt-submit hooks add, as context, the intents and change records that overlap the paths and identifiers in the prompt. Only identifiers, never the prompt's prose, as Cork does.
- **On the first write to an area another session has an intent on:** the PreToolUse hook refuses that one write, and says whose intent it is, how old it is, and that the next attempt will pass. If the agent tries again, the write passes and the event is logged as `acknowledged`. Because the second attempt passes, a remote intent stays advice: the agent is told once and decides.
- **Which hooks each CLI offers for this is confirmed in P1.4**, before the adapter is written: Claude Code's SessionStart and UserPromptSubmit context, and Codex's equivalents and its pre-tool hook on file writes.

## How the agent behaves on a refusal

The engine finds the contention, refuses a supported write and says why. The agent decides what to do next. The first prototype must answer:

- Does the agent understand the reason, or does it retry the same write?
- Can it pick other useful work and keep its original task?
- How does it learn that the resource is free?
- Does coordination save work, or add a conversation loop?

Rules:
- The hook answers at once: a refusal and a short reason (holder, intent, age, a free area nearby). It never waits inside its time budget.
- Waiting is a separate step: a bounded MCP call (`coord_wait`), or the agent's next tool call.
- The reason holds another session's words, so it is outside text: it is labelled as such, capped in length, and never an instruction (CLAUDE.md, agentic AI security).
- Two latencies are measured separately: when an event reached the other client, and when the other agent acted on it. An idle agent may not make its next tool call for minutes.

## Sharing state between developers

**Remote snapshots only advise in this milestone.** Each workbench publishes its intents to its own ref. That cannot make taking a resource atomic:

| Step | Machine A | Machine B |
|---|---|---|
| Read known state | The area looks free. | The area looks free. |
| Decide locally | Records the intent. | Records the intent. |
| Publish and fetch | Learns about B. | Learns about A. |

Both may already have started. A deterministic tie-break can sort it out afterwards but cannot prevent it, and comparing clock times across two machines brings in clock skew. So a remote intent carries its age and its publisher's freshness, and it shapes local decisions, but it is never described as exclusive.

- **Refs:** `refs/botbench/coord/<workbench>/<device>`, where the device is an opaque id generated at install, never a hostname. One writer per ref, so two machines of one developer never compete for the same ref. The ref name is a convention, not an authentication: anyone with push access to the remote can write any ref, so the writer shown is always "unverified".
- **How a ref changes:** each update is a new commit whose parent is the ref's previous commit, pushed as a fast-forward. Never a force push. Releasing every intent is one more commit with an empty list. The ref is deleted only by an owner command (`botbench coord forget`), as an ordinary delete push.
- **When it is pushed:** only when an intent changes, no more often than once a minute (**Target**), and only when the owner has turned on sharing for that repository. Sharing is refused by default on a public repository, because its refs are public. Intent text is redacted by default.
- **How it is read:** with `git ls-remote`, plus a fetch into Botbench's own copy of the repository (as `src/engine/combined.ts` does for Check Together). Never into the owner's clone, and never by adding a refspec to the owner's `.git/config`.
- **When exclusivity is needed later:** use an explicit shared arbiter. The repository already has one, the issue-claim lock: one lock branch per resource, created by a push that never forces, which a ref that already exists refuses (`src/engine/claim-branch.ts`, `src/engine/claims.ts`). One ref per developer does not inherit that property; one lock ref per resource does.
- **Not the paired-workbench channel.** ADR 0004's messages are each approved by their owner. That is right for questions and wrong for state that must flow without a person.

This needs a change to a hard rule. "Botbench pushes only a task's own branch, never by force" gains: "and, when the owner turns it on for a repository, its own coordination ref, as fast-forward commits and an owner-requested delete". The owner decides that wording before P1.7.

## Installing hooks into sessions Botbench did not launch

`botbench hooks install --vendor claude-code|codex` shows the exact diff and writes only when the owner confirms. It writes to the user-level config or to the project's git-ignored local settings (`.claude/settings.local.json` for Claude Code). It never commits, and Botbench never runs it unprompted.

- The hook command is an absolute path to a file the owner owns, outside any work tree, so a branch switch or a repository's own files cannot change the code that runs.
- Install records a hash of exactly what it wrote. `botbench hooks remove` takes back exactly that, and refuses with an explanation if the owner has edited it since.
- A user-level install affects every repository on the machine, and the diff says so.

The hard rule "Never touch owner's working tree" gets an exception for this one command, run by the owner, which the owner words.

Botbench's Claude Code driver loads no project or personal settings in a task's worktree (`--setting-sources ""`). Outside a worktree it loads the project's shared settings only (`"project"`, `src/drivers/claude-code.ts:223`). So a local or user-level install never reaches a session Botbench launched. For those sessions, the coordination check will chain inside Botbench's own PreToolUse proxy, after the broker. That hook-up comes after the milestone.

## Who runs the coordinator

The coordinator lives in the Botbench process, so Botbench must already be running. A hook never starts it. When Botbench is not running, every write passes and is logged as fail-open by the hook itself, in a local file the coordinator reads on its next start. Record schemas, validation and the MCP server are hand-written, with no new runtime dependency.

Callers are not authenticated. Any process the owner runs can reach the socket, including an agent's own shell, and a session id is whatever the CLI reports on its hook's input. So a session can release or update only its own records, a change made through the shell or the CLI around the hooks counts as `uncovered`, and the coordinator is a cooperation protocol between the owner's own agents, not a boundary against a hostile one.

## The first slice

| Step | What | Done when |
|---|---|---|
| P1.1 | Record schemas (mutation lease, intent, change record, event) and the coverage states, written from scratch as JSON Schema. | Schemas and examples checked in, with tests that validate them. |
| P1.2 | The coordinator in the Botbench process: a `0600` unix socket under `~/.botbench/coord/`, the three tables in the existing SQLite store, an append-only event log, `admit` / `release` / `status` / `intent` / `watch`. | Tests over a real socket and real SQLite, including two concurrent `admit`s for one file where exactly one wins. |
| P1.3 | The latency measurement, done before choosing the hook's language. A parent process times, separately: hook start-up, a request to a warm coordinator, the coordinator's recovery after a Botbench restart, and contention under concurrent requests. | A `RESULTS` note with the measured numbers. It decides between a Node hook and a native shim with no dependencies; the decision goes into ADR 0013. |
| P1.4 | First, confirm each CLI's hook surface from its documentation and one live run: pre-tool hooks on file writes, and session-start and prompt context. Then the Claude Code and Codex adapters: PreToolUse `admit` on their file-write tools, PostToolUse report, session start and end, and the delivery path above. No permission decision on a pass, nothing at all on a failure. File level only. | Recorded sessions replayed through the adapters (fast suite), and one live test for each CLI under `test/live/`. |
| P1.5 | `botbench` CLI and `botbench mcp`, one contract: `--json` everywhere, NDJSON `watch`, exit codes 0 ok, 2 conflict, 3 coordinator unavailable (callers treat 3 as no objection). MCP tools: `coord_status`, `coord_intent`, `coord_release`, `coord_wait`. | The same question gives the same answer from the CLI and from MCP, in one test. |
| P1.6 | Change records from git: local branches, plus remote branches after a fetch. Unattributed local changes from `git status --porcelain=v2`. | A session that ended still shows its branch as a change record, and an unrecorded edit shows as unattributed. |
| P1.7 | Sharing intents between two developers: per-workbench, per-device refs, advisory, with freshness. | Two installations with two homes and one bare remote see each other's intents, with their age. Then one check, with the owner's OK, that GitHub accepts a fast-forward push and a delete of `refs/botbench/coord/*` on a throwaway repository. |
| P1.8 | The milestone test, live, on two machines. | Yes or no, with the transcripts and event logs as the evidence. |
| P1.9 | Benchmark v0 (below): three arms, the seven scenarios, Claude Code and Codex. | A report of every run, the failed ones included, whatever it shows. |

**Deferred until a measurement calls for it:** symbol level (tree-sitter), the resolution steps beyond refuse-and-say-why (split, negotiate, deadlock detection), more vendors (Gemini CLI, Grok, Cursor), a relay, the coordination view in the interface, and the hook-up for Botbench-launched sessions. Check Together (`src/engine/combined.ts`) stays as it is: coordination asks "what other work should change what this agent does next?", and Check Together asks "did these exact revisions pass these checks together?". It is the step after this one, not a blocker for it.

## The benchmark

**Primary outcome:** the whole requested task set completed correctly and merged within the time limit, judged by acceptance checks written before the runs. Conflict hunks, overwritten lines, rebases and latency are diagnostics: on their own they would reward serialising everything or leaving the hard task unfinished.

Scored, in order:
1. Tasks completed against their acceptance checks.
2. Elapsed time from start to everything merged and green.
3. Human interventions.
4. Rework caused by coordination.
5. Tokens, and denials that were not real conflicts.
6. Coverage, freshness and failure behaviour (the counts above).

Failed and timed-out runs stay in the results. Each run is kept as one row per task per arm (JSONL) before anything is averaged.

**Arms:**
- No engine.
- Coarse file locks: `admit` only, with no intents, no change records and no delivery path.
- This milestone: admission, intents, change records and the delivery path.

The second arm shows whether intents and change records add anything over plain locks. Symbol level joins as an arm only once file level shows a measured problem it would fix.

**Scenarios:**

| Scenario | What it shows |
|---|---|
| Independent work | Botbench stays quiet and keeps work in parallel. |
| Same file, same checkout | A conflicting supported write gets a useful refusal. |
| Separate worktrees, related changes | Agents coordinate work whose results will meet later. |
| Different files, one interface between them | Help beyond two sessions touching one file. |
| Finished session, branch not merged | The work stays visible after its session ends. |
| Disconnected peer, failed coordinator | Coverage and freshness stay honest. |
| Unattributed local edit | Its source stays unknown, and is labelled so. |

The fixture is a purpose-built repository with a local bare remote, so nothing is pushed anywhere shared. The token budget is set before the first run.

## Threats (STRIDE, for the new trust boundaries)

The new boundaries are the local socket (any process the owner runs can call it), teammates' refs (data from another machine), and the hooks installed into the owner's agent CLIs. `docs/security/threat-model.md` gets these rows in the pull request that adds each boundary.

| Threat | Where | Answer |
|---|---|---|
| Spoofing | A session reports another session's id. | Socket mode `0600`, owner only. The id is self-reported and shown as such. A session can release or update only the records it created. |
| Spoofing | A ref claims to be another workbench's. | Ref names are not authenticated; anyone with push access can write any ref. The writer is shown as "unverified", with the commit's author as the only hint. |
| Tampering | A teammate's ref holds crafted intents. | Parsed against the schema, size-capped, and treated as advice only. A malformed ref is skipped and logged. |
| Tampering | A branch switch or a repository's own files change the hook that runs. | The hook command is an absolute path to an owner-owned file outside any work tree. |
| Tampering | An agent's shell releases leases or writes around the hooks. | Records are released only by their own session. Writes the hooks did not see are counted as `uncovered`. Not a boundary against a hostile local agent, and stated so. |
| Repudiation | Who was refused, and why. | Every `admit`, refusal, acknowledgement, release and fail-open is in the append-only event log. |
| Information disclosure | Paths and intents become visible to everyone who can read the repository. | Sharing is off by default per repository, and refused by default on a public one. Intent text is redacted by default. Device ids are opaque, never hostnames. No file content is ever sent. |
| Denial of service | A session floods `admit`, or holds a lease forever. | A limit on requests per session. Mutation leases end with their write or a short bound. Fail-open is logged, so an outage cannot pass for coordination. |
| Elevation of privilege | Coordination output read as permission, or another agent's text read as an instruction. | The adapter never sends a permission decision of allow, and sends nothing on a failure. Reasons and context carry outside text, labelled and capped, never instructions. |
| Elevation of privilege | A user-level install reaches every repository. | The install diff says so. `hooks remove` takes back exactly what was written, checked by hash. |

## Open decisions for the owner

1. The wording of the two hard-rule exceptions: the coordination ref, and `hooks install`.
2. Whether a human-held change ever blocks an agent, or only advises. Proposed: only advises.
3. P1.3 decides the hook's language. Proposed: keep it in this repository, behind a stable socket protocol, whichever language wins.
4. Linux next to macOS in P1. The coordinator has no macOS-only part, so proposed yes.
5. The benchmark's token budget.
6. Whether the interface redesign pauses until the milestone test passes (the PRD's question 9). Proposed: yes.

## Self-critique (evidence)

A reviewer with a fresh context checked this plan against CLAUDE.md, the owner's review and the code it cites. It found 13 problems, 5 of them high, and all were revised once:
- There was no delivery path for a remote intent, so the milestone could not pass. Added "How the agent hears about other work".
- Updating a ref needed a force push. Now fast-forward commits only, and the hard-rule exception says so.
- Ref and session identity were treated as authenticated. Both are now marked self-reported or unverified, with STRIDE rows.
- Hook installation had no threat rows. Added absolute paths, the hash check on remove, and the user-level scope.
- An agent's shell could drive the socket. A session now releases only its own records, and the coordinator is not a boundary against a hostile agent.
- Fetching into the owner's clone. Reads now go through `ls-remote` and Botbench's own copy.
- A schema validator could have added a dependency. Everything is hand-written.
- Who starts the coordinator was unclear. Botbench must already be running.
- `--setting-sources` was described wrongly outside a worktree. Corrected against the code.
- There was no coarse baseline arm and no benchmark step. Added both.
- GitHub's handling of custom refs was untested. Added a check to P1.7.
- Some numbers were not marked as Targets. Marked.
- The ADR went beyond what the owner had decided. Narrowed.

The reviewer confirmed that the code references for `hookOutput`, the issue-claim lock and Check Together match the code.
