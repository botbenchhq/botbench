# Competitive gaps

Where Botbench could be demonstrably simpler, safer or more productive, and where it is behind. Source read only; every statement about a competitor is "the source shows", and the project files carry the references. Nothing here is proven until the matching experiment in [experiments.md](experiments.md) is run.

## Not differentiation: do not claim these

Competitors already have each of these in code.

| Capability | Who already has it |
|---|---|
| Driving the CLIs you already pay for, on your own sign-in | OpenMausBot, Tutti, OpenAgents, Paperclip, Agor, Letta Code, OpenHands |
| Several vendors' agents in one place | All of the above; OpenAgents lists 26 CLI adapters |
| A separate copy per task | Tutti (parallel tasks), Paperclip (opt-in), Agor, OpenHands |
| Use from a phone | OpenMausBot and Tutti have native apps; QM has an iOS client |
| Several people sharing agents and conversations | OpenAgents, QM, Agor, Agenta, Paperclip, each on one server |
| Agents handing work to agents | OpenMausBot, Tutti, Paperclip, Agenta |
| Task claims, dependencies, budgets | Paperclip, Tutti |
| A second model reviewing the work | Tutti, OpenMausBot (off by default), OpenAgents (behind flags) |
| An audit log | Paperclip, QM, OpenMausBot, Tutti; Agor has attribution and tracing but no append-only log |

## Where Botbench could be demonstrably better

### 1. Collaboration without a shared server

**The gap.** Every project that lets two people work together puts them on one server run by one operator. In QM an administrator with access to a scope can read its transcripts, documents and memory; the read is logged but needs no consent (its own `SECURITY.md`). In Open Agent Bridge the operator can read ordinary messages, which are not end-to-end encrypted (its own README); file transfers can be. In OpenAgents a shared agent inherits everything its owner can see, and a teammate's request runs with the owner's files and credentials. Tutti's and Letta Code's collaboration is in closed services.

**What Botbench has.** Each developer keeps their own machine, agents, sign-ins and approvals. The shared medium is the repository both already use. Today that covers seeing each other's work, claiming an issue so the remote refuses a second claim, and checking two changes together.

**The honest limit.** A shared server is why the others take minutes to join. Two Botbench installations plus a pairing step must not be harder than opening a shared workspace, or this advantage will not matter. Experiment 1 tests exactly that.

### 2. Safe when you walk away, without giving up the subscription

**The gap.** The source shows permissions bypassed for the agent in OpenAgents (its adapters), Paperclip (its Claude Code adapter, by default; Codex when configured), OpenMausBot (full access by default, safety floor off by default), Letta Code (when it launches Claude Code or Codex), Agensh, and the bridge's Codex kit. The projects with real isolation by default (QM, Agensh) do not drive your own CLIs at all: QM runs its own agent loop, and Agensh uses API gateways only.

**What Botbench has.** Claude Code and Codex send every permission request through the broker; commands are confined by default; a floor of dangerous actions always asks or is refused; broker failure means deny. Grok cannot ask before using a tool, so it runs with its own approvals off inside a sandbox around its whole process, and Antigravity reviews with no tools. As far as the source shows, no project studied combines a floor that is on by default with driving the owner's own CLI.

**The honest limit.** Botbench's confinement is the macOS sandbox, not a container, and the agent process itself is outside it. Until #72, the claim is "safe by default", not "isolated".

### 3. Proof that two people's work fits together

**The gap.** No project checks one owner's change against another owner's open change before either merges. Agensh comes nearest with a CI gate and a broken-main state machine, inside one operator's swarm. Four rate Absent on verification (OpenAgents, Agor, Letta Code, OpenHands). Most of the rest end "done" with the agent's message, a person's acceptance, or a model's reading.

**What Botbench has.** Checks run and kept, a review by another vendor's agent, fix rounds, and "check together" on a merge of both changes.

**The honest limit.** A passing check proves only what the check covers. This must stay in the wording.

### 4. Evidence as the product of every task

**The gap.** Tutti gates on the user's acceptance but captures no test output, diff or branch. Paperclip has review policy but, as far as the researcher traced, no evidence pack. Open Agent Bridge has the best hand-off record and no way to check it.

**What Botbench has.** Every task ends as a branch with its diff, transcript, check output and review. That same pack is what a hand-off between workbenches should carry.

### 5. Coordination that takes no administration

**The gap.** Paperclip needs a company, a goal and a CEO agent before any code, and the health of the reporting chain decides whether work can be assigned. QM reads at least 121 settings and needs a cloud account, a database and a sandbox provider. Agensh needs a Linux host with root.

**What Botbench has.** One process, no accounts, a settings file. The risk is that Peers adds its own ceremony. The bar: two developers pair with one code and never see an organization chart.

## Where Botbench is behind

Ordered by how soon a customer would notice.

| Gap | Who is ahead | What it costs Botbench |
|---|---|---|
| **Time to first result.** macOS only, clone, build, token. | OpenMausBot (signed installer or one command), Tutti (desktop installer), OpenAgents (hosted) | The first ten minutes decide whether anyone reaches the part where Botbench is better. |
| **Platforms.** Agents start only on macOS. | Nearly all | A two-developer team with one Linux or Windows user cannot use Peers. |
| **Dependencies and parallel tasks.** One task at a time, no "this waits for that". | Tutti, Paperclip, OpenMausBot | Collaboration between two developers is mostly "mine waits on yours". This is the core of the coordination half and it is deferred. |
| **A claim whose holder went silent.** A claim is released when its run ends without a pull request, also after a restart, and an owner can take over an old claim after a confirm that names its holder. Nothing lapses by itself. | Paperclip, QM, Open Agent Bridge (leases and heartbeats) | A teammate has to notice a stale claim and decide to take it over. |
| **Scoped memory.** Per workbench only. | QM, OpenMausBot, Letta Code | No way yet to share what one workbench learned without sharing everything. |
| **A second kind of principal.** Every decision is the owner's. | Agor, QM; Tutti as a contract in its open code (the implementation is closed) | Peers cannot record "who asked" until this exists. |
| **Number of agents.** Four. | OpenAgents (26 CLI adapters), OpenMausBot (about fifteen CLIs among 31 drivers) | Low cost unless a prospect's main agent is missing. |
| **Connected apps and tools beyond the CLI's own.** | Most | Matters for work beyond code; not for the wedge. |
| **Spending caps.** | Paperclip, QM, OpenMausBot | Subscription turns have no dollar cost, so this is minor until metered use exists. |
| **Recovery detail.** Checks re-run after a restart. | LangGraph's principle | Slow, not wrong. |

## What this means for the North Star

The decisive question is whether independently operated agent teams accomplish more together with less human coordination and without giving up control. Read against the source:

- **"Independently operated"** is the part nobody else does. It is Botbench's to prove or lose.
- **"Without sacrificing control"** is where Botbench leads today.
- **"More together with less coordination"** is where it trails: no dependencies, no direct messages, no hand-offs. Paperclip and Tutti show what the mechanisms look like on one machine. Building them across two machines is the work.
