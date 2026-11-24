# ADR 0013: Headless first, with coordination between agents as the next milestone

Date: 2026-11-24. Status: proposed. The plan is [docs/plans/2026-11-24-1600-feat-coordination-engine-plan.md](../plans/2026-11-24-1600-feat-coordination-engine-plan.md).

## Context

- Botbench's engine, drivers, approvals and store already work without the interface. None of them imports the HTTP layer or the web client; `src/server.ts` is the one place that wires them together. Today the only way in is the HTTP API that the web client uses, and there is no command line.
- The owner asked how their agent harness coordinates with a teammate's. Botbench answers that today only after the fact: warnings about overlapping pull requests, issue claims, Check Together, and paired questions that each need their owner's approval.
- Cork (`docs/competitive/projects/cork.md`) shows the other shape: a hook in each agent CLI, a local coordinator, MCP and a CLI, with no interface. Its engine is under the FSL licence, so nothing of it is copied or ported. Ideas from its MIT protocol specification are credited.

## Decision

1. **Coordination is a headless service with one contract.** A CLI with `--json` and NDJSON streams, an MCP server, and agent-CLI hooks all read and change the same state. The web interface is an optional client of that contract. Whether the rest of Botbench (tasks, runs, approvals) gets the same CLI is a separate decision, for a later ADR.
2. **The next milestone is coordination between agents that Botbench did not launch**, as the plan defines it: three records (mutation lease, work intent, change record), admission in one atomic step, permissions left to the agent's CLI, remote state that only advises, and a test with two developers on two machines.
3. **Coordination is not a safety control.** It allows on failure and logs that it did. The broker and safety floor still deny on failure, and they decide first for every session Botbench launches.
4. **It stays in this repository**, behind a stable socket protocol. Which language the hook is written in is decided by the latency measurement in the plan's step P1.3, and recorded here.
5. **Open for the owner: whether the interface redesign pauses** until the milestone test passes. Proposed: yes, with the existing screens left as they are.

## Consequences

- Two hard rules in CLAUDE.md need owner-worded exceptions before the steps that use them: pushing a coordination ref, and `botbench hooks install` writing an agent CLI's config for the owner.
- The README, the website and the demo describe the product through its screens. They change when the milestone test passes, not before (CLAUDE.md: no control or status before the real behaviour exists).
- A native hook, if P1.3 chooses one, is a second language and a build step. It must have no dependencies, so the server's rule of zero runtime dependencies still holds.
- Hooks cover only the write tools each CLI hands them. The engine reports what it did not cover rather than claiming it all.
