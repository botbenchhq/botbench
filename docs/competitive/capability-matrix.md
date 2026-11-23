# Capability matrix

Source read only; nothing was run. See [README.md](README.md) for what each level means. The reason behind every cell is in the project's file under "Capability ratings".

Key: **●** Implemented · **◐** Partial · **○** Planned · **?** Unverified (claimed, code not found) · **–** Absent

Read the table with three cautions:

- ● means the code exists, not that it is good or safe. OpenAgents has ● for bringing your own agents and runs every one of them with permissions bypassed.
- Each project was rated by a different researcher against the same definitions. Treat a one-step difference between two projects as noise.
- "Between owners" is rated generously. No project connects separately owned installations; a ● or ◐ there means several people on one shared server.

## The workbench half

| Project | Own agent CLIs and subscriptions | Models and providers | Tools and connectors | Isolation | Approvals | Remote and phone | Effort to first result |
|---|---|---|---|---|---|---|---|
| **Botbench today** | ● four vendors' CLIs on the owner's sign-ins; Claude Code and Codex send every permission request through the broker | ◐ what those CLIs offer; no API keys or local models by design | ◐ the CLI's own tools; no connector layer | ◐ own copy per task, commands confined by the macOS sandbox; the Claude Code and Codex processes are not, Grok's whole process is | ● broker, safety floor, deny on failure | ◐ browser on a private network; phone notifications not confirmed | Medium: macOS only, clone and build, about ten minutes |
| **Botbench direction** | ● | ◐ | ◐ | ● container per task (#72) | ● | ● | Low |
| OpenAgents | ● 26 adapters | ● | ● | – permissions bypassed, owner's folder | ◐ only if the agent chooses to ask | ◐ | Low |
| Tutti (open repository) | ● | ● | ● | ◐ own copy only for parallel tasks | ● provider's approvals, no floor of its own | ● | Low |
| Paperclip | ● 12 adapters | ● | ● | ◐ opt-in | ◐ organizational approvals; its Claude Code adapter skips prompts by default | ◐ | Medium: company, goal and CEO agent first |
| OpenMausBot | ● the CLIs' own sign-ins | ● | ● | ◐ sandbox on Linux cloud machines only | ● full access by default | ● | Low |
| QM | – own agent loop only | ● | ● | ● cloud sandbox per scope | ● | ● | High: cloud, database, sandbox provider |
| Open Agent Bridge | ◐ Codex only | ◐ | – | – | – | ◐ | High |
| Agensh | ◐ API gateway only | ◐ | ● | ● containers | – | ◐ | High: Linux host with root |
| Agor | ● | ● | ● | ◐ none by default on a Mac | ● | ● | Low solo; high for an isolated team |
| Agenta | ◐ | ● | ● | ◐ only on Daytona | ● | ● | High self-hosted; low on its cloud |
| Letta Code | ● approvals off for outside CLIs | ● | ● | ◐ | ◐ | ● client; ? service | Low |
| OpenHands | ◐ | ● | ◐ | ◐ | ◐ | ◐ | Low |

## The coordination half

| Project | Memory scoping | Identity and authorization | Task coordination | Between owners | Transport between installations | Verification | Durability | Budgets and usage | Audit |
|---|---|---|---|---|---|---|---|---|---|
| **Botbench today** | ◐ per workbench; nothing shared | ◐ one owner, one token, paired devices | ◐ issue claims the remote enforces, overlap warnings; no dependencies, one task at a time | ◐ through the repository: see each other's work, claim an issue, check two changes together | ○ ADR 0004, issue #154 | ● checks kept as evidence, another vendor's review, fix rounds, owner decides | ◐ one retry, then interrupted; checks re-run | ◐ usage ledger and limit waits; no caps | ● append-only log |
| **Botbench direction** | ● scoped by audience | ● a second kind of principal: the peer | ● dependencies and hand-offs across workbenches | ● paired workbenches, each on its owner's machine | ● | ● | ● | ◐ | ● |
| OpenAgents | ◐ agents inherit all their owner can see | ◐ agent identity is a header | ◐ person assigns; a model moves the card | ● one server | ◐ central hub only | – | ◐ | ◐ stored, not enforced | ◐ |
| Tutti (open repository) | ◐ | ◐ | ● durable run claims, dependencies gated on acceptance | ? closed product | ◐ own phone to own desktop | ◐ acceptance gate and a model reviewer; no test or diff evidence | ● | ● | ● |
| Paperclip | ● | ● | ● atomic checkout, blockers, wakes | ◐ one server | – | ● review policy and completion contracts | ● | ● hard stops | ● |
| OpenMausBot | ● | ◐ | ● assignment tree inside one installation | ◐ one hosted team cloud | ◐ same owner only | ◐ optional check of the answer text | ● | ● | ● |
| QM | ● audience floor | ● | ◐ leased runs; no claims or dependencies | ◐ one server | – | ◐ model governor | ● | ● | ● |
| Open Agent Bridge | ● | ● signed requests | ● leased claims with reconciliation | ◐ one operator | ● central bridge | ◐ | ● | – | ◐ |
| Agensh | ◐ | ◐ self-asserted | ◐ advisory claims, no conflict detection | – | – | ● CI gate | ● | ● | ◐ |
| Agor | ● | ● | ◐ queue and parent callbacks; no claims | ◐ one server | – | – | ● | ◐ | ● |
| Agenta | ◐ | ● | ◐ parent to child only | ◐ one server | – | ◐ | ● | ◐ | ● |
| Letta Code | ● per agent | ◐ | ◐ | ◐ | ? closed service | – | ◐ | ◐ | ◐ |
| OpenHands | ◐ | ◐ one shared key | ◐ | – | – | – | ◐ | ◐ | ◐ |

## Infrastructure and standards

Not rated on the same scale; each has a recommendation instead.

| Item | Recommendation | Reason in one line |
|---|---|---|
| Agent2Agent (A2A) 1.0.1 | Follow its shapes without the dependency | Message and task field names cost nothing to mirror; it has no sender identity, claims or trust between owners |
| Docker Sandboxes (`sbx`) | Watch; keep the seam open | A small virtual machine per sandbox without Docker Desktop; use it only to run commands, never the agent |
| E2B | Follow its shapes without the dependency | Cloud only in practice, paid, no host folder mount, and Botbench would hold an API key |
| Daytona | Ignore | Development moved to a private codebase in June 2026 |
| Agent Mesh (`google/agentmesh`) | Borrow principles only | Needs a control plane both owners trust; breaks zero dependencies and local by default |
| LangGraph | Borrow principles only | Its checkpointing cannot reach inside a vendor CLI's turn |

## What the matrix says

- **Botbench stands out in two columns today.** Approvals: five others also rate ●, but as far as the source shows Botbench is the only one that drives the owner's CLIs with a safety floor on by default. Verification: checks kept as evidence. Paperclip and Agensh are the only others rated ● there; Tutti gates on the user's acceptance and rates ◐.
- **No product studied connects separately owned installations today.** Botbench is ◐ through the repository; every other is one server, closed (Tutti), or absent. Agent Mesh plans federation between separately run control planes, and A2A exists for independent agents.
- **Botbench trails in four columns:** task coordination (no dependencies, one task at a time), memory scoping, identity for anyone but the owner, and effort to first result.
- **Breadth is not a contest worth entering.** OpenAgents lists 26 CLI adapters; OpenMausBot has 31 built-in drivers, some of them model APIs rather than CLIs.
