# Strategic recommendations

What to build, integrate, defer and avoid, from the source read of the eleven products and six pieces of infrastructure in this library. Evidence and references are in [patterns.md](patterns.md), [gaps.md](gaps.md) and the project files. These are recommendations for the owner to decide; nothing here has been started.

## The position in three sentences

Separately owned installations working together is not demonstrated in the projects and source reviewed: those projects put people on one server or keep that part closed (Tutti's closed tier and Agent Mesh's roadmap point that way). Botbench already leads on control and on proof, and trails on the mechanics of coordination and on getting started. So the plan is to finish the coordination half on the foundation that is already different, and to stop the first ten minutes from hiding it.

## How the ranking works

Each item is scored 1 (low) to 3 (high) on customer value and differentiation, and 1 (best) to 3 (worst) on engineering effort and validation risk. These are judgments from reading source, not measurements. Validation risk means: how likely is it that we build this and it does not matter?

The order is not a sum of the scores. It goes by customer value and differentiation first, then by what has to exist before something else can be built or tested, with effort and risk breaking ties. That is why the cheap experiments come first and why direct messages, the costliest item, still rank second.

## Build

| Rank | What | Value | Differentiation | Effort | Risk | Why, and what to adapt |
|---|---|---|---|---|---|---|
| 1 | **Run experiments 3 and 2 before more platform work.** | 3 | 3 | 1 | 1 | They test the two leads Botbench has (safe by default, no duplicate work) with one person and no new code. A failure in either changes this whole list. |
| 2 | **Direct messages between workbenches (ADR 0004, #154), with four additions from the research.** | 3 | 3 | 3 | 2 | Doing this without a central server is not demonstrated in the projects and source reviewed. Add: the system-written note on every incoming line with "information only" authority (OpenMausBot); a retry key plus payload digest, and replay protection for acknowledgements (Open Agent Bridge); A2A's field names; "retrieved" kept apart from "acknowledged". The bridge shows what happens without ADR 0004's rules: a peer's message becomes a full-access turn. |
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
| **Agent Client Protocol (ACP)** | 2 · 1 · 2 · 2 | Spike done on 23 November 2026 (`docs/security/acp-check.md`): not as one generic driver; worth it for Grok first and Antigravity second, with the hand-written Claude Code and Codex drivers kept. The original recommendation was to evaluate one ACP driver as the route to more agents, with a short live check like the one done for Codex (`docs/security/codex-app-server-check.md`). | Tutti, OpenHands and Agenta all reach most agents this way. The open question is Botbench's own: can every permission request be routed through the broker? If not, do not adopt it. |
| **GitHub as the shared medium** | 3 · 3 · 1 · 1 | Keep it for engineering work, as one medium and not the definition of shared work. No sync of claims to issue assignees (owner, 23 November 2026). | It is the server both developers already trust. Claims stay independent of GitHub's assignment; an opt-in link may be revisited. Work that is not in a git repository will need another medium, so claims, dependencies and hand-offs should not assume one. |

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
| **A central hub that holds everyone's content, as the default or the only way** | QM (an administrator with access can read a scope) and Open Agent Bridge (the operator can read ordinary messages); OpenAgents is a hub too, though it relays API keys only as ciphertext | It is the easy way to collaboration and it gives up independent ownership. This is not a ban on any shared service: independent ownership is the goal, and whether a relay or rendezvous that cannot read content serves it better than direct connections is to be validated. |
| **Bypassed permissions as the default** | OpenAgents, Paperclip's Claude Code adapter, OpenMausBot, Letta Code's outside CLIs, Agensh | Botbench's lead. A convenience mode that does this would erase it. |
| **Touching subscription credentials** | OpenMausBot's ChatGPT OAuth client, Tutti's usage probe, Paperclip's linked Codex sign-in | A terms risk and a hard rule. Drive the CLI and stop there. |
| **"Done" taken from the agent's own words** | OpenAgents (a model classifier reads the reply), Agensh's board "verified" (a keyword match on the agent's evidence text) | It is the opposite of evidence. |
| **Advisory claims** | Agensh, Tutti's active-peers list | A claim that does not exclude is a notice. Botbench's is enforced by the remote; keep it that way. |
| **A mandatory organization model** | Paperclip | Two developers should pair with one code and never see roles, a hierarchy or a company. |
| **A peer's message that starts work by itself** | Open Agent Bridge, A2A's default | ADR 0004 already forbids it. The bridge is the cautionary example. |
| **Measuring success by agents, providers or connectors supported** | The category | OpenAgents lists 26 CLI adapters and OpenMausBot 31 drivers. It is not where a small team wins. |
| **Copying Agor code, reading OpenMausBot's `enterprise/`, copying Agenta's `ee/`** | Licences | Agor's licence forbids using its code in a commercial product or service for others whose main purpose is orchestrating AI coding agents (until it becomes Apache 2.0 on 15 January 2029). Botbench is close enough to that line to take ideas only. |

## What the first experiments changed (23 November 2026)

Records in [`results/`](results/README.md).

- **Rank 1 is done in its first version.** The unattended-safety run held. The overlapping-issues run did not pass: one duplicate through a stale claim, as many conflicting pairs as three uncoordinated sessions, and 23 requests to a person where the plain sessions made none.
- **Rank 3 (claims that lapse) moves up and gains a bug.** A stopped workbench blocked its issue for an hour, and after a takeover its restart opened a second pull request (#188). Fix the bug first.
- **Rank 4 (dependencies and knowing what others are changing) matters more than the claim on an issue.** Conflicts came from different issues touching the same code, which a claim does not see, and the warning arrived at review, after the work.
- **A new item: warnings that carry signal (#189).** Sixteen of seventeen overlap warnings named only a shared test file.
- **A new question for the owner: how much a person approves on a team's own issues.** A run from an issue needs its plan approved and its result accepted, by design for outside text. On ten of a team's own issues that was 23 interventions. It is the same tradeoff as for messages (`docs/product/peers-autonomy-tradeoff.md`) and should be decided with it.
- **The integrate row for ACP is settled for now:** not a generic driver, and the Grok test's answer is no until its long-lived tools can be switched off (`docs/security/acp-check.md`).

## What would change these recommendations

- **Experiment 3 finds a trap carried out:** fix that before anything else.
- **Experiment 1 shows the shared thread beats separate machines on coordination time:** direct messages move to rank 1, and it becomes fair to ask whether an optional shared space is needed.
- **Experiment 4 shows people do not reach the first result:** onboarding moves to rank 1.
- **Tutti opens its multi-user product, or OpenAgents adds federation between servers:** the "not demonstrated in what we reviewed" premise ends, and the lead narrows to control and proof.
- **A vendor's terms rule out unattended use of its CLI on a subscription:** every project that drives CLIs is affected, Botbench included; the plan in `docs/product/positioning-concept.md` already names this as the first risk.

## Decisions (owner, 23 November 2026)

1. **Open Agent Bridge** means `munboon/open-agent-bridge`. Both projects of that name stay as references; neither is treated as an established competitor.
2. **Issue assignees:** no automatic sync. Claims stay independent of GitHub's assignment. An opt-in link may be revisited.
3. **ACP:** a small, bounded spike now. It tests whether an ACP adapter keeps Botbench's permissions, tool controls, confinement and lifecycle. No broad implementation, and P5 does not wait for it.
4. **Corrections to existing documents:** made, after checking the code. The third (the README on Codex) was not an error; see [README.md](README.md).

## Direction (owner, 23 November 2026)

The full statement is in `docs/product/positioning-concept.md`. What it changes here:

- **Two capabilities, one product.** The Workbench (your agents, subscriptions, models, tools, environments, context and memory, under your policies) and the Coordination Plane (independently owned workbenches whose agents communicate, delegate, negotiate, share scoped context, manage dependencies and finish work together). Neither is a feature of the other. Read the Build table as serving both: ranks 5, 8 and the backlog below are Workbench work and are not second-class.
- **Engineering is the wedge, not the limit.** Keep the core concepts reusable beyond code: agents, environments, tools, context, work, policies, dependencies, hand-offs, outcomes. Do not tie claims, dependencies or hand-offs to git.
- **Measure useful work done together.** The next milestone is judged by what two owners' agents accomplished across the boundary and how few times a person had to relay or approve, not by messages delivered or features built.
- **P5 and human approvals.** ADR 0004 asks for a person at four points in one question and answer. Build the accepted design first, measure the friction, and decide on scoped autonomous communication from the tradeoff in `docs/product/peers-autonomy-tradeoff.md`. A message never expands an agent's permissions or authorizes execution under any option.
- **Dependencies and hand-offs across workbenches** include work on different files that must satisfy one shared contract; overlap of files is not the only case.
- **Onboarding is a product issue.** Rank 5 is not polish.
- **Backlog kept open, not built yet:** sandbox portability, tools, personal and shared context, memory scoping.
