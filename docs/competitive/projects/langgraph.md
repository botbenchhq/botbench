# LangGraph (durable execution)

| | |
|---|---|
| Repository | https://github.com/langchain-ai/langgraph |
| Commit read | c6335a4, 2026-11-20 (shallow clone) |
| Licence | MIT (`libs/langgraph/pyproject.toml:12`, `libs/checkpoint/pyproject.toml:12`). The hosted LangGraph Platform / server (`langgraph-api`) is not in this clone. |
| Stack | Python. Graph engine in `libs/langgraph`, checkpointer interface in `libs/checkpoint`, SQLite and Postgres savers in `libs/checkpoint-sqlite` and `libs/checkpoint-postgres`. Depends on `langchain-core`, `pydantic`, `xxhash`, `ormsgpack` (`libs/langgraph/pyproject.toml:26-33`, `libs/checkpoint/pyproject.toml:14-17`). The JS/TS engine lives in a separate repository; `libs/sdk-js` here is only an API client. |
| Size and activity | About 45,000 lines of Python across the four libraries read. `pregel/_loop.py` is 2,222 lines and `pregel/main.py` 4,585. Dense comments about edge cases (delta channels, subgraph time travel, error handlers on resume) show a mature, heavily used runtime still being refined. |
| Evidence basis | Source read only; not run |

Scope of this file: only the durable-execution principles, and how they compare with Botbench's own restart behaviour. Agent building, prebuilt agents, the server and the SDKs are out of scope.

## What it is and who it is for

LangGraph is a low-level runtime for stateful agent and workflow graphs. Its durability layer is a checkpointer: after each step of the graph it saves the full state of every channel, plus the writes of each task finished within the step, keyed by a `thread_id`. With that store a graph can stop (crash, interrupt for a human, deliberate exit) and later continue from the last saved step, replay from an older one, or fork. It is for Python developers who write the agent's control flow as graph nodes or `@task` functions inside one process and want that process to be restartable.

Botbench is not that. Botbench does not own its agents' control flow: each "turn" is an external CLI (Claude Code, Codex, Gemini, Grok) whose internal steps Botbench cannot checkpoint or replay. So LangGraph matters here as a body of tested-in-production ideas about where to put the persist point, what to save, and what a resumed unit may assume, not as code to run.

## What is actually implemented

| Capability | Evidence level | `path:line` | Note |
|---|---|---|---|
| Checkpointer interface | Implemented | `libs/checkpoint/langgraph/checkpoint/base/__init__.py:199-343` | `BaseCheckpointSaver` with `get_tuple`, `list`, `put`, `put_writes`, plus `delete_thread`, `delete_for_runs`, `copy_thread`, `prune` (`:344-398`) and async twins (`:441-585`). The base raises `NotImplementedError`; savers fill it in. |
| Checkpoint contents | Implemented | `libs/checkpoint/langgraph/checkpoint/base/__init__.py:93-124` | `v`, `id` (unique and monotonically increasing, usable for ordering), `ts`, `channel_values`, `channel_versions`, `versions_seen` (per node, which channel versions it has consumed; decides what runs next), `updated_channels`. `pending_sends` is copied in `copy_checkpoint` (`:135`) but is no longer in the TypedDict, a legacy field. |
| Metadata and parent link | Implemented | `libs/checkpoint/langgraph/checkpoint/base/__init__.py:39-63`, `:140-147` | Metadata `source` is `input`, `loop`, `update` or `fork`; `step` is -1 for input, 0 for the first loop step. `CheckpointTuple` carries `parent_config` and `pending_writes`. |
| SQLite saver schema | Implemented | `libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py:147-168` | Two tables: `checkpoints` keyed `(thread_id, checkpoint_ns, checkpoint_id)` with `parent_checkpoint_id`; `writes` keyed `(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)`. |
| Idempotent write storage | Implemented | `libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py:475-479` | Ordinary writes are `INSERT OR IGNORE` (first write of a task wins); special channels (error, interrupt, resume) are `INSERT OR REPLACE`. |
| Super-steps (Pregel / BSP) | Implemented | `libs/langgraph/langgraph/pregel/_loop.py:670-718`, `:720-782` | `tick()` prepares the step's tasks from channel versions; `after_tick()` applies all task writes together, then a checkpoint is saved. Tasks in one step see the same state. |
| Deterministic task ids | Implemented | `libs/langgraph/langgraph/pregel/_algo.py:615-623`, `:836-844` | A node task's id hashes checkpoint id, namespace, step, node name and triggers; a `@task` call's id adds its call path and a call counter. The same step on resume yields the same ids, which is what lets stored writes be matched back. |
| Pending writes per finished task | Implemented | `libs/langgraph/langgraph/pregel/_runner.py:613-623`, `pregel/_loop.py:483-562` | When a task finishes, its writes are sent to `put_writes` at once, before the rest of the step ends (a `NO_WRITES` marker records a task that wrote nothing). Errors and interrupts are stored the same way (`_runner.py:588-612`). |
| Finished tasks not re-run on resume | Implemented | `libs/langgraph/langgraph/pregel/_loop.py:692-694`, `:853-866`; `pregel/main.py:3085` | On resume, stored writes are put back on the tasks that made them; the runner only executes tasks with empty `writes`. Failed or interrupted tasks keep empty writes and run again. |
| Failed tasks routed to handler, not re-run | Implemented | `libs/langgraph/langgraph/pregel/_loop.py:868-933` | A persisted `ERROR_SOURCE_NODE` marker makes resume schedule the node's error handler instead of re-running the node. |
| Resume vs fresh run detection | Implemented | `libs/langgraph/langgraph/pregel/_loop.py:953-1002` | Resuming needs an existing checkpoint plus a continuation signal: `None` input, a `Command`, or the same `run_id`. Addressing an older checkpoint sets `is_replaying`, under which finished tasks do re-run (`:847-851`). |
| `interrupt()` | Implemented | `libs/langgraph/langgraph/types.py:913-1057` | First call raises `GraphInterrupt` with an `Interrupt` whose id is derived from the namespace and the interrupt's index (`:1046-1056`). Several interrupts in one node are matched to resume values by order (`:930`, `:1032-1045`). |
| Re-execute-from-start rule | Implemented | `libs/langgraph/langgraph/types.py:926-928`, `:1032-1038` | "The graph resumes from the start of the node, re-executing all logic." On resume the node runs again and earlier `interrupt()` calls return their stored values instead of raising. |
| `Command(resume=...)` | Implemented | `libs/langgraph/langgraph/types.py:843-867` | Resume value, or a map from interrupt id to value. |
| Resume validation without loss | Implemented | `libs/langgraph/langgraph/types.py:998-1012`, `:895-901` | With a `response_schema`, a bad resume value raises and "Nothing is saved, so the interrupt can be answered again." |
| Durability modes | Implemented | `libs/langgraph/langgraph/types.py:99-105`; `pregel/main.py:2714-2715`, `:3103-3105`; `pregel/_loop.py:535`, `:1336-1339`, `:1555-1565` | `sync`: wait for the checkpoint future before the next step. `async` (the default): save while the next step runs. `exit`: no `put_writes` and no per-step checkpoint; one save on exit, including on error or interrupt. |
| `@task` (functional API) | Implemented | `libs/langgraph/langgraph/func/__init__.py:132-175`; `pregel/_call.py:258-273` | Task results are stored as pending writes like node writes, so on resume an already-finished task call returns its stored result instead of running again. Retry, cache and timeout policies attach per task. |
| "Side effects must be idempotent or wrapped in tasks" guidance | Unverified (in this clone) | `docs/redirects.json` points `/concepts/durable_execution` to https://docs.langchain.com/oss/python/langgraph/durable-execution | The clone's `docs/` holds only redirects and `llms.txt`; the prose guidance is on the docs site, not read here. The code mechanism that makes it necessary (re-execution from node start, `types.py:928`) is in source. |
| Time travel: get state history | Implemented | `libs/langgraph/langgraph/pregel/main.py:1529-1535`; saver `list(..., before=...)` at `checkpoint/base/__init__.py:277-299` | Walk checkpoints newest first; invoking with a past `checkpoint_id` replays from there (`_loop.py:1002`). |
| Time travel: `update_state` and fork | Implemented | `libs/langgraph/langgraph/pregel/main.py:2636-2647`, `:1634`, `:1772`, `:1885-1910` | `update_state` writes a new checkpoint with `source="update"` as if from `as_node`; `as_node="__copy__"` writes a copy with `source="fork"` under the same parent. Old checkpoints are never edited. |
| Node retry policy | Partial (read only the interface) | `libs/langgraph/langgraph/func/__init__.py:156-166`; implementation in `libs/langgraph/langgraph/pregel/_retry.py`, not read | Per-task retry policy, timeouts and heartbeats as the docstring states them. |
| JS engine durability | Absent (in this clone) | — | The JS port is a separate repository; not read. |

## Architecture and trust model

```
graph.invoke(input | Command(resume=..) | None, config{thread_id, checkpoint_id?})
  -> PregelLoop._first()        decide: fresh run, resume, or replay (_loop.py:943-1002)
  -> loop: tick()               tasks from channel_versions vs versions_seen
           run tasks            each finished task -> put_writes(task_id, writes)
           after_tick()         apply writes, bump versions
           _put_checkpoint()    new Checkpoint, parent = previous (sync/async/exit)
  -> exit: _suppress_interrupt  final save on exit, error or interrupt (_loop.py:1548-1565)
```

The unit of durability is the super-step: a checkpoint is the state between steps, and pending writes are the partial progress inside a step. Recovery is "load the latest checkpoint, put back the writes of tasks that finished, run the rest". Everything rests on two assumptions: the node function can be run again from its start, and task ids come out the same on the re-run.

Trust model: none to speak of. The checkpointer trusts its store; state is serialized with a msgpack/JSON serializer with an optional allowlist (`checkpoint/base/__init__.py:742-771`). It runs in the caller's process with the caller's credentials. There is no isolation between nodes and no notion of an external tool whose effects cannot be repeated beyond the documented advice to make them idempotent.

## What Botbench would use it for

Nothing at runtime. A LangGraph checkpointer could not reach inside a vendor CLI turn, and Botbench's engine is a small station machine whose state already lives in SQLite. The useful thing is the vocabulary and the rules: where state is saved, what a resumed unit may assume, how a human's answer is attached to the exact point that asked, and how history is kept immutable and forkable. The comparison below shows where those rules would land.

### How Botbench recovers today

Source shows Botbench's stated behaviour holds:

- **Persist point.** Every state change goes through one synchronous SQLite write transaction (`src/store/db.ts:11-15`) on a WAL database (`src/store/db.ts:78`). That is LangGraph's `sync` mode in effect, applied to every transition, not a per-step option.
- **Append-only logs.** `events` (the normalized transcript, per attempt and turn) refuses updates and deletes by trigger (`src/store/schema.ts:36-48`); so do `task_events` (`:82-85`) and `action_log` (`:130-133`, re-created at `:190-192`). Approvals may be answered once and their request fields never change (`:111-116`, `:155-168`).
- **The resumable unit is a turn, and the checkpoint is git.** After a builder's turn Botbench commits the worktree (`src/engine/task.ts:526-544`); the task's `headCommit` is the durable result. Within a turn nothing is checkpointed: the CLI's own session is the only memory, reachable through `attempts.resume_cursor` (`src/store/schema.ts:19-28`).
- **Restart recovery.** On start, `recover()` (`src/engine/task.ts:1380-1473`) stops surviving CLI process groups only once they are known to be Botbench's own (`src/engine/recover.ts:82-92`), closes the cut-off turn with an `interrupted` event and marks the attempt interrupted in one write (`src/engine/recover.ts:107-125`), records unfinished setup and check commands as stopped (`src/engine/recover.ts:147-174`), and finishes interrupted reviews as unfinished (`src/engine/task.ts:1390-1407`).
- **Retry once, else interrupted.** A task at work is taken up again once, counted in `tasks.restarts` (`src/store/schema.ts:685`); the count is bumped in the same write as the note (`src/engine/task.ts:1449-1458`). A second restart stops it for the owner with a reason (`src/engine/task.ts:1366-1371`).
- **Where it resumes.** `stageOf` picks `setup`, `turn` or `checks` (`src/engine/task.ts:313-322`). Setup and checks run again from the start; a turn resumes the CLI session if the driver can (`src/engine/task.ts:1334-1335`) with `CONTINUE_PROMPT`, which tells the agent the files are as it left them and anything it was running was stopped (`src/engine/recover.ts:35-36`), else starts fresh with the task's prompt (`src/engine/task.ts:1358`).
- **Human-in-the-loop across a restart.** A pending approval is parked; the owner's later answer is stored on the row and given once to the first request of the resuming attempt that asks the same thing (same task, role, tool, command, directory), else discarded and asked afresh (`src/approvals/broker.ts:69-75`). The agent is told to repeat exactly the unanswered tool call (`src/engine/recover.ts:28-29`), and `resumeProblem` refuses a resume that could lead nowhere (`src/engine/recover.ts:180-190`).
- **Write before act elsewhere.** Issue claims are stored before the push (`src/engine/claims.ts:310`) and settled on restart (`src/engine/claims.ts:437-446`); ADR 0004 specifies durable, idempotent peer messages with `UNIQUE(peer_id, message_id)` (`docs/adr/0004-peers-direct-messages.md:15`). No ADR covers durability as a whole; no Botbench file mentions LangGraph.

The structural difference: LangGraph can skip finished tasks because it owns their code and their ids. Botbench cannot skip anything inside a CLI turn, cannot make the CLI re-execute deterministically, and cannot see the CLI's side effects except through the worktree, the broker's approvals and the action log. So "checkpoint" in Botbench can only mean the boundaries it owns: station transitions, git commits, individual setup and check commands, approvals and outgoing messages.

## Cost of adopting it

- **Dependencies.** Python, `langchain-core`, `pydantic`, `xxhash`, `ormsgpack`, plus `aiosqlite` and `sqlite-vec` for the SQLite saver (`libs/checkpoint-sqlite/pyproject.toml:14-18`). Botbench is Node with zero runtime dependencies unless an ADR says why.
- **Services.** None for SQLite; Postgres for the Postgres saver. The JS port would avoid Python but is a separate package set, not read here, and would still be npm dependencies.
- **Accounts.** None for the open-source library. The hosted platform is a separate product.
- **Licence.** MIT; borrowing ideas or small rewritten snippets is unproblematic (list copied files in `NOTICE` if any are copied).
- **Lock-in.** High if adopted: control flow must be written as LangGraph nodes, state as channels with reducers, and the store format is LangGraph's.
- **Fit with Botbench's constraints.** Poor. One local Node process: a Python engine means a second runtime and process. No Docker for first run: fine. Local by default: fine. Credentials never read by Botbench: neutral. The deciding misfit is that Botbench's real work happens in external CLIs that are not graph nodes and cannot be replayed.

## Recommendation

**Borrow principles only.** The evidence confirms the expected call. LangGraph's durability is well engineered, but its key trick, skipping finished work on resume by matching stored writes to deterministic task ids, needs control of the code being resumed, which Botbench does not have for agent turns. Botbench already implements the parts that fit (synchronous persist before moving on, append-only history, parked human answers matched to the repeated request, retry once). Four principles are worth borrowing:

1. **Record each finished sub-unit, and on resume run only the unfinished ones.**
   - LangGraph: `libs/langgraph/langgraph/pregel/_runner.py:613-623` saves a task's writes as soon as it finishes, with a no-writes marker; `libs/langgraph/langgraph/pregel/_loop.py:853-866` puts them back so only tasks with empty writes run; `libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py:475-479` stores them with `INSERT OR IGNORE`.
   - Botbench: after a restart the checks station runs every check again from the start (`src/engine/task.ts:1305-1307`, `:1325`), although each command already has its own row and evidence keyed by round and position (`src/engine/recover.ts:147-174`).
   - Change: a check or setup command that finished before the restart, on the same `headCommit`, is not run again. Agent turns stay excluded; they cannot be split this way.
2. **State the re-execution contract.**
   - LangGraph: `libs/langgraph/langgraph/types.py:926-928`, the node re-executes from its start on resume, so work before the interrupt must be safe to repeat.
   - Botbench: a resumed turn is a re-execution by an agent that may repeat side effects. `CONTINUE_PROMPT` (`src/engine/recover.ts:35-36`) tells the agent what was stopped, but no rule says which effects outside the worktree may be repeated.
   - Change: a short ADR: "a resumed turn is a re-execution; an effect outside the worktree is either broker-gated with a stored answer, or idempotent by id". ADR 0004 already applies this to peer messages (`docs/adr/0004-peers-direct-messages.md:15`).
3. **Give every point that waits on a human a stable id, and never consume a bad answer.**
   - LangGraph: interrupt id from namespace and index (`libs/langgraph/langgraph/types.py:1046-1056`), resume by id (`types.py:852-856`), and "Nothing is saved, so the interrupt can be answered again" (`types.py:1011-1012`).
   - Botbench: parked approvals are matched to the resumed request by its fields, and a stored answer is discarded when the first request differs (`src/approvals/broker.ts:69-75`).
   - Change: an explicit key per waiting point. It matters more for Peers, where an answer may come from another workbench and must name exactly what it answers.
4. **Immutable, parent-linked history, with fork as a first-class source.**
   - LangGraph: `libs/checkpoint/langgraph/checkpoint/base/__init__.py:39-48` (`source` is `input`, `loop`, `update` or `fork`), `:140-147` (`parent_config`), `libs/langgraph/langgraph/pregel/main.py:1885-1910` (a fork writes a copy and never edits the original).
   - Botbench: attempts carry no parent link (`src/store/schema.ts:19-28`); which sessions came before is recovered by text-matching `task_events.detail LIKE '%attempt %'` (`src/api/tasks.ts:205-211`).
   - Change: record on each attempt the attempt and commit it continues from. Git commits are already the checkpoints; the link makes "continue from an earlier commit" and Peers hand-offs (one workbench continuing another's branch) traceable.

Durability modes (`libs/langgraph/langgraph/types.py:99-105`) are worth knowing but not borrowing: Botbench should stay at the equivalent of `sync` everywhere, since its writes are few and a lost transition costs more than the latency.

## Open questions

- Whether the docs site's durable-execution page adds rules beyond the code (for example, determinism requirements for control flow between tasks). Not read; only the redirect target is known from `docs/redirects.json`.
- How the `async` mode behaves when the process dies between a task's `put_writes` and the step's checkpoint: the code suggests the writes survive and are re-applied, but only a crash test would settle it.
- Whether the separate JS port matches the Python semantics closely enough to be a reference for a Node implementation.
- In Botbench, whether a check command that passed before a restart may be trusted on the same `headCommit`, given that setup or the environment could have changed; this decides whether principle 1 is safe for checks or only for setup.
- How the Claude Code, Codex and Gemini CLIs themselves treat a resumed session whose last tool call was cut off mid-execution; that limits how far principle 2 can be made precise.
