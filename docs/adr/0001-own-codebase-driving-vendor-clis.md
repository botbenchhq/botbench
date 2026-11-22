# ADR 0001: Own codebase that drives vendor CLIs

Date: 2026-11-21. Status: accepted.

## Decision
Botbench is its own small codebase. It starts each vendor's unmodified CLI as a child process under the owner's existing login and speaks that CLI's structured headless protocol. It has no agent loop of its own, uses no vendor agent SDK, and never handles subscription credentials.

## Why
- The CLIs are what the subscriptions pay for; reducing one to a model endpoint discards the agent.
- OpenMausBot's driver layer (39k lines, 213 outside imports) could not be lifted, and neither it nor Rakazo has worktrees, a plan gate, or a verify station.
- Handling credentials or signing in on the owner's behalf is the practice vendors have acted against.

## Consequences
- Each CLI's protocol and flags can change under us: one small driver per CLI, a version table, live tests before merge.
- Whether a consumer plan permits unattended CLI use, and how headless turns count against the plan allowance, is the vendor's call. The owner has accepted this for their own use. It must be re-examined before Botbench is promoted to other people on the strength of "use the subscriptions you already pay for".
