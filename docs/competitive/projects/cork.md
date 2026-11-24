# Cork

| | |
|---|---|
| Repository | https://github.com/corkcli/cork |
| Commit read | aa1061e (aa1061eda5e293cf87c103edf02f66fbaeb78452), 18 Nov 2026. 19 commits; the history is a release export, not the development history. The product was called Collide until mid-November 2026. |
| Licence | MIT for `core/`, `hooks/`, `protocol/`, `plugin/`, `skills/` and `listing/`. The engine in `free/` is **FSL-1.1-MIT**: any competing use is barred until two years after each version. Nothing from `free/` may be copied or ported into Botbench. |
| Stack | One Rust binary, `cork`. Hook processes plus a local axum and SQLite server on 127.0.0.1 (port 47600 or the next free one). tree-sitter for 11 languages. A specified real-time protocol of typed operations on `code:<path>::<symbol>` keys. |
| Size and activity | About 118k lines of Rust, one author. About 900 Rust tests; CI runs them on Linux only. |
| Evidence basis | **Secondary.** This file summarises a read-only teardown of that commit made outside this repository (24 Nov 2026), plus the owner's review of it. Cork was not cloned, built or run for this file, so the levels below are the teardown's reading of the source, not this repository's. |

## Promise and intended customer

Cork sits under several coding agents (Claude Code, Codex, Cursor, Hermes) working on one repository. It briefs each agent, tells it when another agent changes something it uses, holds a clashing write, and turns `git push` into fetch, rebase, test and push. The free version runs on one machine; a paid cloud links machines and teammates.

## What is implemented, per the teardown

| Capability | Level | Source reference (in Cork) | Note |
|---|---|---|---|
| Hooks that fail open | Implemented | `hooks/src/lib.rs` | Every hook runs inside `catch_unwind`, so even a panic exits 0. Time budgets: 200 ms for the write gate, 500 ms for the report. |
| Write gate at symbol level | Implemented | `hooks/src/gate.rs` | Blocks (exit 2) only when a named teammate holds a conflicting change. |
| Conflict table per operation | Implemented | `protocol/SPEC.md` §16 (MIT) | For each pair of operations: commute, rekey (the edit follows a renamed symbol) or conflict. 13 golden test vectors. |
| Leases | Implemented | `protocol/SPEC.md` §7 | Last as long as the connection, with 5 s of grace and no heartbeat. |
| Coverage of people editing by hand | Implemented, per the owner's review | Cork's hooks README at aa1061e | `cork watch` covers people editing without an agent, and keeps disk-confirmed changes apart from changes agents report. The PRD's claim that Cork covers people only through hooked agents was wrong. |
| Messages between sessions | Implemented | `hooks/src/listen.rs` | A teammate's message goes straight into the open Claude Code session and can start a turn. `cork wake`, off by default, runs `claude -p` or `codex exec` on a message in permission mode auto. |
| Landing | Implemented | `hooks/src/land.rs` | Rewrites the agent's `git push` into fetch, rebase, test and push, up to four times. |
| One outbound door with a local audit log | Implemented | `hooks/src/privacy.rs`, `hooks/src/http.rs` | Removes file text and paths, then logs each request exactly as sent. |
| A badge in pull request descriptions | Implemented, on by default | the push path | Edits the description with the owner's own `gh`. Opt out with `CORK_PR_BADGE=0`. |
| Sync across machines | Unverified | not in the repository | The paid cloud. |

## What Botbench takes, and what it avoids

Take, written from scratch and credited (all from Cork's MIT parts):
- Hooks that fail open, with a fixed time budget.
- The commute, rekey or conflict table, if symbol level is ever measured to be worth it.
- One outbound door with a local audit log.
- Briefings built from the identifiers in a prompt, never its prose.

Avoid:
- Anything from `free/`.
- Messages that can start a turn. In Botbench, a message from outside is a card, or text labelled as outside text.
- Writing to GitHub by default, as the badge does.
- Editing every agent's user-level config at install, or an installer script that is not in the repository.
- Rewriting a command the user typed. Landing stays with Botbench's delivery.

## Relation to Botbench

Both pitch the same coordination layer. Cork is ahead on live coordination at the level of a symbol. Botbench is ahead on isolation (a worktree per task), approvals and evidence. Botbench's coordination plan is [docs/plans/2026-11-24-1600-feat-coordination-engine-plan.md](../../plans/2026-11-24-1600-feat-coordination-engine-plan.md).
