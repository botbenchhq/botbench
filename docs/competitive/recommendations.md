# Strategic recommendations

What to build, integrate, defer and avoid, from the source read of the eleven products and six pieces of infrastructure in this library. Evidence and references are in [patterns.md](patterns.md), [gaps.md](gaps.md) and the project files. These are recommendations for the owner to decide; nothing here has been started.

## The position in three sentences

None of the products studied lets separately owned installations work together today: they put people on one server or keep that part closed (Tutti's closed tier and Agent Mesh's roadmap point that way). Botbench already leads on control and on proof, and trails on the mechanics of coordination and on getting started. So the plan is to finish the coordination half on the foundation that is already different, and to stop the first ten minutes from hiding it.

## How the ranking works

Each item is scored 1 (low) to 3 (high) on customer value and differentiation, and 1 (best) to 3 (worst) on engineering effort and validation risk. These are judgments from reading source, not measurements. Validation risk means: how likely is it that we build this and it does not matter?

The order is not a sum of the scores. It goes by customer value and differentiation first, then by what has to exist before something else can be built or tested, with effort and risk breaking ties. That is why the cheap experiments come first and why direct messages, the costliest item, still rank second.

## Build

| Rank | What | Value | Differentiation | Effort | Risk | Why, and what to adapt |
|---|---|---|---|---|---|---|
| 1 | **Run experiments 3 and 2 before more platform work.** | 3 | 3 | 1 | 1 | They test the two leads Botbench has (safe by default, no duplicate work) with one person and no new code. A failure in either changes this whole list. |
| 2 | **Direct messages between workbenches (ADR 0004, #154), with four additions from the research.** | 3 | 3 | 3 | 2 | Nobody studied has this without a central server. Add: the system-written note on every incoming line with "information only" authority (OpenMausBot); a retry key plus payload digest, and replay protection for acknowledgements (Open Agent Bridge); A2A's field names; "retrieved" kept apart from "acknowledged". The bridge shows what happens without ADR 0004's rules: a peer's message becomes a full-access turn. |
| 3 | **Claims that lapse by themselves.** Today a claim is released when its run ends, and an owner can take over an old one by hand. Add: a claim renews while its run is alive and enters a named state when its workbench goes silent, so nobody has to notice. | 2 | 2 | 2 | 1 | QM (lease and reaper) and the bridge (needs reconciliation) solved the parts Botbench lacks; the takeover order already came from Paperclip. Experiment 2 will show how often it bites. |
| 4 | **"Mine waits on yours": dependencies gated on acceptance, first inside one workbench, then across two.** | 3 | 2 | 3 | 2 | Most collaboration between two developers is this. Tutti's rule (a later task starts only when the earlier one is completed and accepted) and Paperclip's single `blocks` relation with one wake per ready state are the model. Across workbenches, "accepted" becomes "merged". Needs the deferred parallel-task work. |
| 5 | **Shorten the first ten minutes.** One command to install and start, no separate build step, and the first screen leads to a real task. | 3 | 1 | 2 | 1 | Not a difference, a toll. OpenMausBot's installer and Tutti's desktop app set the expectation. Experiment 4's owner version produces the list. |
| 6 | **A second kind of principal.** The log and approvals record who asked, kept apart from whose agent ran it. | 2 | 2 | 2 | 1 | Required by item 2; `peers-concept.md` already says so. Tutti's session scope (a contract in its open code; the implementation is closed) and Agor's shared-session rule are the shapes. |
| 7 | **The hand-off as an evidence pack.** A hand-off between workbenches carries purpose, revision, next action and acceptance checks, and its outcome is appended only by the receiver. | 2 | 3 | 2 | 2 | Joins Botbench's lead (evidence) to the new half (coordination). The bridge has the record; nobody has the record plus real checks. |
| 8 | **After a restart, do not re-run checks that already finished; give each waiting approval a stable id.** | 1 | 1 | 1 | 1 | Small, from LangGraph's principles. The stable id becomes necessary with item 2. |
| 9 | **The audience floor, on the day memory can leave a workbench.** | 2 | 2 | 1 | 2 | One rule from QM: something enters a shared context only if everyone there could already see it. Do not build shared memory to use it; build it first when shared memory comes. |

## Integrate

Scores in the same order: value, differentiation, effort, risk.

| What | Scores | Recommendation | Why |
|---|---|---|---|
| **A2A** | 2 · 1 · 1 · 1 | Use its message and task field names in ADR 0004's messages now. Do not open an A2A endpoint until ADR 0004's controls are proven. | Free today, and it keeps the door open to other vendors' agents. In A2A a message starts work on the receiver, which ADR 0004 forbids; a Botbench endpoint would only open a card. |
| **Containers for #72** | 3 · 2 · 3 · 1 | Build on plain `docker run` behind a narrow "where commands run" setting, shaped so Docker's `sbx` can be added later. Use any of them only to run commands, never the agent CLI. | `sbx` is the likeliest second backend and needs no Docker Desktop, but two facts need a real run first: whether a non-interactive command returns its exit status, and whether network rules are per sandbox. Its own way of running Claude Code bypasses permissions. |
| **Agent Client Protocol (ACP)** | 2 · 1 · 2 · 2 | Evaluate one ACP driver as the route to more agents, with a short live check like the one done for Codex (`docs/security/codex-app-server-check.md`). | Tutti, OpenHands and Agenta all reach most agents this way. The open question is Botbench's own: can every permission request be routed through the broker? If not, do not adopt it. |
| **GitHub as the shared medium** | 3 · 3 · 1 · 1 | Keep it. Consider making a claim visible as the issue's assignee. | It is the server both developers already trust, and it is why Botbench needs no operator. Assignee sync (Agensh) is a new write to GitHub and so the owner's decision. |

## Defer

Each of these scored low on value for the two-developer case today, or high on effort or risk. The condition says what would change that.

| What | Until |
|---|---|
| Connected apps and work beyond code (Agenta, OpenMausBot) | The two-developer coding case is proven. Agenta shows cross-functional work ends up on the same primitives, so nothing is lost by waiting. |
| Swarm scale (Agensh) | Never, unless a customer has it. Agensh's own released code runs on one host, and its claims only work behind a CI gate inside one operator's swarm. |
| Dollar budgets and spending caps | Metered use exists. Subscription turns have no dollar cost. |
| Native phone apps | The browser version is confirmed on a real phone. |
| Windows and Linux | Experiment 1 shows teams want Peers and are blocked by a non-Mac member. Containers (#72) are the likely route. |
| A cloud sandbox backend (E2B) | A customer asks. It is paid, has no host folder mount, and Botbench would hold an API key. |
| A relay or mesh for workbenches behind different networks (Agent Mesh, `google/agentmesh`) | A private network proves insufficient for real pairs. Needs a new ADR. |
| Long-lived agent identities with accumulated memory (Letta Code) | Scoped memory exists. Take the "one learning per commit with its sources" rule when it does. |

## Avoid

| What | Seen in | Why |
|---|---|---|
| **A central hub that holds everyone's content** | QM (an administrator with access can read a scope) and Open Agent Bridge (the operator can read ordinary messages); OpenAgents is a hub too, though it relays API keys only as ciphertext | It is the easy way to collaboration and it gives up what sets Botbench apart. |
| **Bypassed permissions as the default** | OpenAgents, Paperclip's Claude Code adapter, OpenMausBot, Letta Code's outside CLIs, Agensh | Botbench's lead. A convenience mode that does this would erase it. |
| **Touching subscription credentials** | OpenMausBot's ChatGPT OAuth client, Tutti's usage probe, Paperclip's linked Codex sign-in | A terms risk and a hard rule. Drive the CLI and stop there. |
| **"Done" taken from the agent's own words** | OpenAgents (a model classifier reads the reply), Agensh's board "verified" (a keyword match on the agent's evidence text) | It is the opposite of evidence. |
| **Advisory claims** | Agensh, Tutti's active-peers list | A claim that does not exclude is a notice. Botbench's is enforced by the remote; keep it that way. |
| **A mandatory organization model** | Paperclip | Two developers should pair with one code and never see roles, a hierarchy or a company. |
| **A peer's message that starts work by itself** | Open Agent Bridge, A2A's default | ADR 0004 already forbids it. The bridge is the cautionary example. |
| **Measuring success by agents, providers or connectors supported** | The category | OpenAgents lists 26 CLI adapters and OpenMausBot 31 drivers. It is not where a small team wins. |
| **Copying Agor code, reading OpenMausBot's `enterprise/`, copying Agenta's `ee/`** | Licences | Agor's licence forbids using its code in a commercial product or service for others whose main purpose is orchestrating AI coding agents (until it becomes Apache 2.0 on 15 January 2029). Botbench is close enough to that line to take ideas only. |

## What would change these recommendations

- **Experiment 3 finds a trap carried out:** fix that before anything else.
- **Experiment 1 shows the shared thread beats separate machines on coordination time:** direct messages move to rank 1, and it becomes fair to ask whether an optional shared space is needed.
- **Experiment 4 shows people do not reach the first result:** onboarding moves to rank 1.
- **Tutti opens its multi-user product, or OpenAgents adds federation between servers:** the "nobody else does this" premise ends, and the lead narrows to control and proof.
- **A vendor's terms rule out unattended use of its CLI on a subscription:** every project that drives CLIs is affected, Botbench included; the plan in `docs/product/positioning-concept.md` already names this as the first risk.

## Decisions for the owner

1. Which "Open Agent Bridge" was meant? The research covered both projects of that name; neither is established.
2. May a claim be shown as the issue's assignee? It is one more write to GitHub.
3. Is evaluating ACP in scope now, or after Peers P5?
4. Should the three small corrections to existing documents listed in [README.md](README.md) be made?
