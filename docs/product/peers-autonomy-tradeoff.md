# Peers: who has to approve a message?

Status: a tradeoff put to the owner on 23 November 2026. **No policy has changed.** ADR 0004 stands as accepted, and its first slice is built as written (#154). This note exists so the choice is made on purpose, with numbers from that slice.

## The concern

The owner's direction: agents coordinate within policies their owners set, while people observe and step in as needed. A message must never expand an agent's permissions or authorize execution. But routine, permitted communication should not need a person every time.

ADR 0004 needs a person at four points for one question and its answer:

| # | Who | What they do | ADR 0004 |
|---|---|---|---|
| 1 | Asker's owner | Reads the agent's draft and presses Send | Decision 9 |
| 2 | Answerer's owner | Reads the card and gives it to an agent, answers, or dismisses | Decision 8 |
| 3 | Answerer's owner | Reads the agent's drafted answer and presses Send | Decision 9 |
| 4 | Asker's owner | Reads the answer's card and gives it back to the task | Decision 8 |

A thread may run three round trips, so one settled interface can cost twelve interventions across two people. If each waits for someone to look at a phone, the agents are slower than the two people talking. That is the coordination burden the product is meant to remove.

## What the cards protect

Each card is a control against a specific harm. Removing a card means naming what replaces it.

| Card | Harm it stops | Why it is real |
|---|---|---|
| Outgoing (1, 3) | **Something leaves that the owner would not have sent.** | A message is a way off the machine. An agent that read a secret, or was steered by planted text in an issue or in the peer's own message, can put it in a draft. Claude Code runs with the owner's rights, so what it can read is wider than the repository. Today the owner reads the exact bytes. |
| Incoming (2, 4) | **Another workbench gets a voice inside this owner's agent.** | A peer's message, once an agent reads it, can persuade it as any outside text can. The peer may be honest and still be relaying text a third party planted on their side. |
| Both together | **The full chain: private data, untrusted input and a way out, in one unattended run.** | An agent that receives a message and may reply without a person has all three. This is the case with no card at all between a planted instruction and data leaving. |

What does not depend on the cards, and holds under every option below: an incoming message is never a grant or a command; work that read one has no commands allowed in advance, cannot be fully autonomous and reaches no network unless the owner allows it; the safety floor; signatures; one repository per pairing; per-kind switches on both ends; and the caps (three round trips a thread, five agent messages a run, thirty an hour per peer).

## Options

| | A. As accepted | B. Approve the thread | C. Standing policy per peer |
|---|---|---|---|
| **What the owner does** | Approves every outgoing message; handles every incoming card | Approves the thread's first message and its purpose once, and on the other side accepts the thread once ("let Claude Code answer in this thread"). Later messages in that thread go without a card | Sets a policy per peer once: kinds, repository, limits. Agents open and continue threads inside it |
| **Interventions for a three-round thread** | 12 | 2 | 0 |
| **What people see** | Cards | A live thread they can read, pause or end; a card only when a rule trips | The same, plus a digest |
| **Outgoing control** | A person reads the bytes | Rules applied by Botbench to every message: kind, size, a scan for secrets and for paths outside the repository, the caps, and "only text this agent wrote in this task". A message that trips a rule becomes a card, as today | The same rules, with no person at the start |
| **Incoming control** | A person decides who reads it | The answer goes only to the task that asked, as outside text; that task is held to the outside-text rules from then on | Any permitted message may start work in a new task under the outside-text rules |
| **The full chain, unattended** | Never possible | Possible inside one thread the owner opened, between two tasks both held to outside-text rules | Possible whenever the policy allows |
| **What a person still decides** | Everything | Starting a thread, anything a rule flags, and every result (a task that read outside text cannot accept its own work) | Anything a rule flags, and every result |
| **Changes to ADR 0004 and the hard rules** | None | Decisions 8 and 9, and the hard rule "anything else that would leave asks first", gain an exception scoped to an approved thread. New decision record and threat review | The same, wider, plus decision 9's "in a fully autonomous run a draft is refused" |

Under B and C a message still never expands permissions or authorizes execution. What changes is who reads a message before it moves, not what a message can cause.

## The tradeoff, plainly

- **A is safe and may defeat the purpose.** It guarantees a person read everything, and costs the interventions the product exists to remove. It is also the fallback the other two need: a flagged message has to become a card somewhere.
- **B moves the person from each message to each conversation and each result.** The owner still chose to open this thread, with this peer, about this thing, and still decides whether the resulting work is accepted. What is given up: nobody reads the middle of the thread before it moves. The filters catch what can be written as a rule (a key-shaped string, a path, size); they do not catch an agent paraphrasing something private. The exposure is bounded by who receives it: one paired colleague who already has the repository.
- **C removes the person from routine work entirely.** It matches "observe and intervene" most closely and gives up the most: a planted instruction on either side can start a thread, and the first a person hears of it is the feed. It is the option where a mistake in the rules is not caught by anyone.

The cost of being wrong differs by direction. Too many cards costs time and is visible at once. Too few costs a leak that may never be noticed.

## Recommendation

1. **Build A now**, as ADR 0004 says. It is accepted, it is the fallback for B and C, and it is needed to measure anything.
2. **Measure friction from the first slice**, per piece of work finished across two workbenches: cards answered, minutes each message waited on a person, the share of cards approved exactly as drafted, and whether the work finished. A high share approved unchanged means the cards are ceremony. A real share edited or refused means they are working.
3. **Design B next, as its own decision record with a threat review**, before any code. B is the smallest change that removes most of the burden while a person still chose the conversation and judges the result.
4. **Hold C** until B has run on real work and its rules have been seen to catch what they should. C should be a wider setting of B's mechanism, not a second design.

## What the owner is asked to decide

Nothing blocks the first slice. Before B is designed:

1. **Is B the right next target, or should the design aim at C from the start?**
2. **May a task that received a peer's message also send one without a person?** This is the "full chain" row. Saying no keeps one card per round trip (3 a thread instead of 12). Saying yes is what makes B worth having.
3. **What may leave unread?** Proposed: only text the agent wrote in that task, under a size limit, after a scan for secrets and outside paths. Not file contents as such, not diffs, not logs. Is that the right line?
4. **What number moves us?** Proposed: design B once the first slice shows most cards approved unchanged on real work. The owner may prefer to design it regardless.

## Related

- `docs/adr/0004-peers-direct-messages.md`, decisions 8, 9 and 12.
- `docs/security/threat-model.md`, Intake (B14) and Peers (B16).
- `docs/competitive/projects/open-agent-bridge.md`: a project where a peer's message becomes an unattended full-access turn, which is what none of these options allows.
- `docs/competitive/projects/openmausbot.md`: the system-written note with three fixed authorities ("information only" for a peer), useful under any option.
- `docs/competitive/projects/qm.md`: the audience floor, for when shared context can travel with a thread.
