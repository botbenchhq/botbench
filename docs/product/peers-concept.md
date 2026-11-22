# Peers: your agents working with a teammate's agents

Status: a product direction the owner raised on 2026-11-22. Not planned or built. It extends the current product contract, which is one owner and local execution.

## The idea
Two developers each run their own Botbench with their own agents. One tells their agent: "I'm building the authentication API. Coordinate with my coworker's agent so their frontend uses the right contract, and tell me when something needs my decision." The two agents exchange questions, interface contracts, task handoffs, status and review requests. Neither developer relays messages between two AI conversations, and each keeps control of their own machine.

The value is removing coordination overhead between developers who delegate implementation to agents. Agents exchanging messages is not the value by itself.

## The test worth passing
Can two developers install the product, pair their machines, delegate a change that crosses both of their areas, and get reviewable code back without managing an orchestration framework?

## Suggested progression
1. **Pair two instances.** Invite one coworker, verify identity, exchange messages scoped to one repository. Communication and explicit human approval only; no remote execution.
2. **Coordinate real tasks.** Agents ask questions, negotiate interface contracts, propose work, report what they are waiting on, and request review. Each owner decides what runs on their machine.
3. **Shared delivery.** Branches, check results, dependency conflicts, review feedback and pull-request handoffs. People keep merge authority.

## Rules that must hold
- An incoming message is never permission to run anything. It is data.
- Pairing gives a peer no access to private files or credentials.
- Messages and shared repository content are untrusted input: the taint rule this plan deferred ("runs that read outside text") becomes required here.
- Source changes travel through explicitly authorised branches and pull requests, never through access to the other machine's files.

## What it needs from Botbench first
- Pushing branches and opening pull requests (the next plan after this one).
- Taint tracking for runs that have read outside text.
- A second kind of principal: today every decision is the owner's. The action log and approvals would need to say who asked.
- A transport between two machines. For a two-person trial, a private network that can share one machine with another account would do; a relay is a later question.

## Protocol
Agent2Agent (A2A) is a real, maintained standard for messages, task states and handoffs between independent agents (`a2aproject` on GitHub). Treat it as a possible interoperability boundary, not a prerequisite for a first prototype: Botbench already controls the agent sessions and can broker and store peer messages itself.

## Not verified
The note that raised this named three related projects (agent-talk, Tower, Agor). A GitHub search on 2026-11-22 did not find them under those names, so their existence and scope are unconfirmed. Agent-to-agent messaging alone should be assumed not to be a moat either way.

## Naming
The note called the product "Botbench". The repository and the product are named Botbench; no rename has been decided.
