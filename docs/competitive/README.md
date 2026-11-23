# Competitive reference library

Started 23 November 2026 from the owner's competitive intelligence review. It holds one source-backed file per project, and five documents that draw conclusions from them. No Botbench code changed in this audit.

## What the evidence is

Every project file was written from a read of the project's source at a named commit, with two exceptions in the sandbox file: Docker Sandboxes (its documentation only; there is no source to read) and Daytona (its README only; the code is now private). **Nothing was installed or run.** A capability marked Implemented means the code that implements it was read and is cited; it does not mean the capability was seen working. The experiments in [experiments.md](experiments.md) are how tested behaviour gets added.

Evidence levels used throughout:

| Level | Meaning |
|---|---|
| Implemented | The implementing code was read and is cited as `path:line` in the project's repository. |
| Partial | Code exists but is incomplete, behind a flag, or covers part of the claim. |
| Planned | Appears only in a roadmap, a design document or an issue. |
| Unverified | Claimed in a README or marketing; no implementing code found, usually because it lives in a closed service. |
| Absent | No claim and no code. |

## The five documents

| Document | Question it answers |
|---|---|
| [capability-matrix.md](capability-matrix.md) | What does each project have, compared with Botbench today and where Botbench is heading? |
| [patterns.md](patterns.md) | Which solved problems can Botbench adapt, and where exactly is the code? |
| [gaps.md](gaps.md) | Where could Botbench be simpler, safer or more productive, and where is it behind? |
| [experiments.md](experiments.md) | Which five comparisons on real work would prove or disprove that? |
| [recommendations.md](recommendations.md) | What to build, integrate, defer and avoid, in order. |

## The projects

Local clones are kept read-only in a `reference/` folder beside the Botbench checkout, one folder per project. The commit each file was read at is in its header.

| Project | File | Licence | Role for Botbench |
|---|---|---|---|
| OpenAgents | [openagents.md](projects/openagents.md) | Apache 2.0 | Direct competitor: shared workspace hub for people and agents |
| Tutti | [tutti.md](projects/tutti.md) | Apache 2.0; the multi-user product is closed | Closest to the combined concept; best solo task and claim model |
| Paperclip | [paperclip.md](projects/paperclip.md) | MIT | Coordination reference: checkout, dependencies, budgets |
| OpenMausBot | [openmausbot.md](projects/openmausbot.md) | Apache 2.0 outside `enterprise/` (never read) | Personal workbench reference; same base decisions as Botbench |
| QM | [qm.md](projects/qm.md) | MIT | Scope reference: who may see and use what in a shared conversation |
| Open Agent Bridge | [open-agent-bridge.md](projects/open-agent-bridge.md) | Apache 2.0 | Messaging between agents through a hosted bridge. See the note below |
| Microsoft Agensh | [agensh.md](projects/agensh.md) | MIT | Swarm coordination without an orchestrator |
| Agor | [agor.md](projects/agor.md) | Business Source License 1.1: ideas only, no code | Team server for coding agents on worktrees |
| Agenta | [agenta.md](projects/agenta.md) | MIT outside `ee/` folders | Cross-functional agents; sharing and delegation model |
| Letta Code | [letta-code.md](projects/letta-code.md) | Apache 2.0 | Agent memory kept as a git repository |
| OpenHands | [openhands.md](projects/openhands.md) | MIT | Execution behind one API, so a backend is a setting |
| Agent Mesh (`google/agentmesh`; its README says it is not an officially supported Google product) | [agent-mesh.md](projects/agent-mesh.md) | Apache 2.0 | Infrastructure: identity and task tokens |
| Agent2Agent (A2A) | [a2a.md](projects/a2a.md) | Apache 2.0 | Standard: message and task shapes |
| E2B, Daytona, Docker Sandboxes | [sandbox-runtimes.md](projects/sandbox-runtimes.md) | Mixed | Infrastructure: where commands run |
| LangGraph | [langgraph.md](projects/langgraph.md) | MIT | Principles for resuming work after a restart |

### Three things the review did not expect

- **"Open Agent Bridge" is not an established project.** Two unrelated repositories carry the name. The one matching the review's description (`munboon/open-agent-bridge`) showed no stars in GitHub's search on 23 November 2026 and has one author; the other (`kevinArgueta96/open-agent-bridge`) showed seven. Both are covered in one file. Their designs are useful; neither is an established market competitor. The owner confirmed on 23 November 2026 that `munboon/open-agent-bridge` was the one meant; both stay as references.
- **Daytona is no longer open.** Its public repository says development moved to a private codebase in June 2026. It is out of consideration as a backend.
- **Tutti's collaboration half is closed.** The open repository is a single-user desktop workspace. Shared rooms, working with other people's agents and VM-backed environments have no implementing code in it.

## Headline findings

1. **Separately owned installations working together is not demonstrated in the projects and source reviewed.** Where several people collaborate, they share one server that one operator runs (OpenAgents, Paperclip, QM, Agor, Agenta, the bridge), or the capability is in a closed service (Tutti, Letta Code). Botbench's model, where each developer keeps their own machine and the shared medium is the repository, did not appear in them; Tutti's closed product and Agent Mesh's roadmap point that way, and projects outside this review may already do it. A shared server is also the reason their setup is short, so this is a difference to prove with an experiment, not an advantage to assume, and not a claim that Botbench is the only one.
2. **Running the agent with its permissions bypassed is the norm.** OpenAgents, Paperclip's Claude Code adapter (by default), OpenMausBot (full access by default), Letta Code when it launches Claude Code or Codex, Agensh and the bridge's Codex kit all do it in source, and Docker's documentation says `sbx run claude` does too. Botbench's broker, safety floor and confined commands by default are a real difference today.
3. **Almost nobody proves the work.** Most treat "done" as the agent's statement or a model's reading of it. The exceptions gate on something real: Agensh on CI, Paperclip on review policy, Tutti on the user's acceptance. None checks two owners' changes together before either merges, which Botbench does.
4. **Botbench is behind on four things customers feel first:** time from install to first result, task dependencies, the number of agents supported, and platforms (macOS only). The matrix adds two they would meet later: memory scoping and identity for anyone but the owner.
5. **The problems Botbench has ahead of it are solved in code it may adapt:** claims that survive a dead holder (Paperclip, Tutti), labelling where a message came from and what authority it carries (OpenMausBot), safe retries of a message (the bridge), and deciding what a shared conversation may see (QM).

## Keeping it current

- When a project changes in a way that matters, pull its clone, re-read the changed part, and update its file and the commit in its header. Do not edit a file from a README or an announcement alone.
- A new project gets a file on the template in `projects/` (the first eleven share one layout; the infrastructure files share a shorter one) before it is added to the matrix.
- When an experiment is run, add a "Tested" note with the date to the project's file and to the matrix. That is the only way a cell moves from "source shows" to "seen".
- Licence rules: adapt approaches in Botbench's own terms and credit them in the pull request; list any copied file in `NOTICE`; take ideas only from Agor; never read OpenMausBot's `enterprise/` or copy from Agenta's `ee/` folders.

## Corrections this audit found in Botbench's own documents

The first two were corrected on 23 November 2026; the third turned out not to be an error.

- `docs/reviews/design-vs-openmausbot.md` says OpenMausBot has no review of finished work. It now has an optional check of the final answer by another provider's model, off by default.
- `docs/product/peers-concept.md` describes A2A as a standard for hand-offs; the specification does not use the term. The same file says Agor could not be found; it is `preset-io/agor`.
- `README.md` said Codex, Grok and Antigravity "cannot plan or build". That was correct when this library was written: the merged change titled "Make Codex a builder" (#147) only recorded a check of `codex app-server`. It changed later the same day, when #162 made Codex a builder in its own sandbox. The README now says so.
