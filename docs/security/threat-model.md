# Smelt threat model (STRIDE)

Scope: Smelt as built through units 1, 2, 3 and 5, plus the boundaries the plan adds next. Update this file in the same pull request as any unit that adds or changes a trust boundary.

## What is being protected

- The owner's repositories and working trees.
- The owner's vendor logins and subscription allowance.
- The owner's machine: files and commands outside a task's worktree.
- Smelt's own records: transcripts, evidence, approvals, the action log.

## Trust boundaries

| # | Boundary | Trusted side | Untrusted side |
|---|---|---|---|
| B1 | HTTP API | Smelt process | Any client: browser, phone, other local processes |
| B2 | Vendor CLI child process | Smelt process | The CLI, and the model's output that steers it |
| B3 | Repository content | Smelt process | Files, settings and hooks inside a target repository |
| B4 | Data directory `~/.smelt` | The owner's account | Other local accounts |
| B5 | Model provider | The owner's choice of vendor | Network, and what the vendor retains |
| B6 | Push service (unit 23) | Smelt process | Apple and Google push relays |

## Threats and current state

Status: **Done** (built and tested), **Partial**, **Planned** (unit named), **Accepted** (known and not addressed).

### Spoofing

| Threat | Boundary | Mitigation | Status |
|---|---|---|---|
| A client acts as the owner | B1 | Random login token, constant-time compare, session cookie `HttpOnly; SameSite=Strict`, required on every route including from loopback | Done (U2) |
| A web page in the owner's browser calls Smelt | B1 | `Host` allowlist, `Origin` check on writes, JSON-only bodies | Done (U2) |
| A local process reads the token | B4 | Token file mode 0600, directory 0700 | Done (U1, U2). Any process running as the owner can still read it: Accepted |
| Agent-written code calls the API during checks | B1, B2 | Login required from loopback too | Done (U2). Such code runs as the owner and could read the token file: Accepted until checks are sandboxed |

### Tampering

| Threat | Boundary | Mitigation | Status |
|---|---|---|---|
| An agent changes the owner's checkout or branch | B2 | One worktree per task from a commit; no command writes the source tree, index or branch; tested byte for byte | Done (U5) |
| A repository hook runs with Smelt's actions | B3 | Hooks disabled on every git call; commits skip verification and signing | Done (U5) |
| A repository's CLI settings allow commands silently | B3 | Pre-tool hook sends every shell and write call to the gate before the CLI's own rules | Planned (U7) |
| The transcript or action log is edited | B4 | Append-only tables enforced by triggers | Done for events (U1); action log Planned (U7) |
| Crafted run or task ids reach git or the filesystem | B1 | Ids must be slugs; arguments passed as arrays, file names after `--` | Done (U5) |

### Repudiation

| Threat | Mitigation | Status |
|---|---|---|
| No record of what an agent did or who allowed it | Every event stored as it arrives; every approval decision and every action run on standing or pre-approved permission logged | Events Done (U3); approvals and action log Planned (U7, U10) |

### Information disclosure

| Threat | Boundary | Mitigation | Status |
|---|---|---|---|
| Provider API keys reach a CLI and bill the owner as metered use | B2 | Child environment built from an allowlist with key variables removed | Done (U3) |
| A repository supplies an API key helper to the CLI | B3 | Turn stopped when the CLI reports a key source other than the login | Partial (U3): the stop path has no test |
| The owner's personal CLI settings, hooks and MCP servers leak into a run | B2 | `--setting-sources project`, `--strict-mcp-config` | Done (U3) |
| Code and prompts go to the model provider | B5 | Inherent to driving a vendor CLI. Stated plainly in the README; local-model drivers deferred | Accepted |
| Commands or code pass through a push relay | B6 | Notifications carry only "an approval is waiting" and the run name | Planned (U23) |
| The login token appears in logs or responses | B1 | Printed once on the start that created it; never returned | Done (U2) |
| Traffic between phone and Mac is read | B1 | Private network with HTTPS; `Secure` cookie on the HTTPS name | Partial (U2 sets the cookie; network setup is the owner's) |

### Denial of service

| Threat | Mitigation | Status |
|---|---|---|
| Wrong-token attempts delay the owner's own sign-in | Global delay capped at 10 s, at most 10 waiting | Partial (U2): not per address. Acceptable on a private network, not for public exposure |
| A CLI process outlives its turn or a restart | Own process group, killed on interrupt and close; survivors stopped on start | Kill Done (U3); stop-on-start Planned (U15) |
| An agent or a check fills the disk or runs forever | Per-command time limits | Planned (U13). No disk quota: Accepted |
| A vendor rate limit stalls a run | Handoff to another driver, resume at reset time | Planned (U21) |

### Elevation of privilege

| Threat | Boundary | Mitigation | Status |
|---|---|---|---|
| Text in a repository or a web page instructs the agent to run something harmful (prompt injection) | B2, B3 | Approvals for everything but worktree edits; safety floor that no grant overrides; narrow grants | Planned (U7, U9, U10) |
| An agent runs commands outside its worktree | B2 | Until U7, every prompt is denied (`--permission-prompts none`); then the broker | Done as deny-all (U3); broker Planned (U7) |
| A pre-approved command is stretched with chaining or pipes | B2 | Prefix match with no shell operators | Planned (U9) |
| Checks execute code the agent just wrote, on the host | B2 | None. A worktree separates changes; it is not a sandbox | Accepted. Sandboxed checks are deferred |
| The planner or reviewer writes files | B2 | Read-only roles | Planned (U11, U20) |

## Open items, most serious first

1. Checks run agent-written code on the host with the owner's privileges. Until a sandbox exists, the README must say so, and the owner should point Smelt only at repositories they trust.
2. The stop-on-API-key guard is untested on its failing path.
3. Sign-in slow-down is global, sessions never expire, and there is no sign-out.
4. Interception for Codex, Gemini CLI and Grok is unproven; a driver without it is limited to read-only roles.
