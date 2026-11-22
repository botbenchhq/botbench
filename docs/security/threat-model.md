# Smelt threat model (STRIDE)

Scope: Smelt as built through units 1 to 6, plus the boundaries the plan adds next. Update this file in the same pull request as any unit that adds or changes a trust boundary.

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
| A repository's CLI settings allow commands silently, or its CLI hooks run commands at session start | B3 | Task attempts load no settings file at all (`--setting-sources ""`): Claude Code 2.1.322 was seen to run a repository's `SessionStart` hook without asking when project settings were loaded. Live-tested with a repository carrying an allow rule and a hook. The pre-tool hook to the gate is still to come | Done for tasks (U6); gate Planned (U7) |
| The transcript or action log is edited | B4 | Append-only tables enforced by triggers | Done for events (U1); action log Planned (U7) |
| Text from a model or a repository is rendered as markup in the client | B1, B2 | All transcript text is rendered as text, tested with markup in a prompt | Done (U4) |
| Crafted run or task ids reach git or the filesystem | B1 | Ids must be slugs; arguments passed as arrays, file names after `--` | Done (U5) |
| A client names a repository path that is not one (relative, a file, a subfolder, a path with a NUL) | B1 | The path must be absolute and is checked as the top level of a git repository with a commit before any task row, worktree or git write exists; tested over HTTP | Done (U6) |
| A client asks for the diff of a file outside the task (`../`, an absolute path, a git option, a pathspec) | B1 | Task ids are digits only; the file must equal a name git itself listed among the task's changes, and only that listed name is handed to git, after `--` with literal pathspecs; tested | Done (U6) |
| An agent's edits land outside its task's worktree | B2 | The attempt's working directory is the worktree and the one allow rule covers file edits below it (`--allowedTools "Edit(./**)"`); a write elsewhere, and to the CLI's own settings, is denied by the CLI; Smelt commits only in a linked worktree on a `smelt/` branch. Live-tested on Claude Code 2.1.322 with a write aimed at the owner's checkout | Done (U6), as far as the CLI's own rule holds; the gate is Planned (U7) |
| Files a task wrote make Smelt's own git run a command (the worktree's `.git` repointed at a git folder with a filter command in its config) | B2, B3 | Before any commit, diff or removal the worktree's git folder must be the repository's own worktree entry and must not lie inside the worktree; tested with a real filter command that does not run. The owner's own repository config, filters included, still applies to Smelt's commits | Done (U6) |
| A task is left at a station nothing is working at after Smelt stops | B4 | State and its event are written in one transaction; on start, tasks left queued or building are marked interrupted and their work committed | Done (U6). Stopping the CLI process such a task left behind: Planned (U15) |

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
| The repository check tells a client whether a path exists and what it is | B1 | Session required; it answers about the one path given and lists nothing; there is no directory browsing | Accepted (U6): the only client is the owner |
| A task's diff or transcript shows file content to whoever holds a session | B1 | Session required on every task route, tested; diff text and file names are rendered as text | Done (U6) |
| The client shell and its assets are served without a session | B1 | They hold no data; every `/api/*` route except sign-in still needs the session; static paths are confined to the built client directory, tested | Done (U4) |
| The client loads fonts or scripts from a third party | B1 | Fonts are self-hosted; the client makes no request to any other origin | Done (U4) |
| The login token appears in logs or responses | B1 | Printed once on the start that created it; never returned | Done (U2) |
| Traffic between phone and Mac is read | B1 | Private network with HTTPS; `Secure` cookie on the HTTPS name | Partial (U2 sets the cookie; network setup is the owner's) |

### Denial of service

| Threat | Mitigation | Status |
|---|---|---|
| Wrong-token attempts delay the owner's own sign-in | Global delay capped at 10 s, at most 10 waiting | Partial (U2): not per address. Acceptable on a private network, not for public exposure |
| A CLI process outlives its turn or a restart | Own process group, killed on interrupt and close; survivors stopped on start | Kill Done (U3); stop-on-start Planned (U15) |
| An agent or a check fills the disk or runs forever | Per-command time limits | Planned (U13). No disk quota: Accepted |
| A malformed request line crashes the server | A request target that cannot be parsed is answered with an error | Done (U4) |
| A client starts many tasks | Tasks build one at a time, each a single turn whose CLI process is closed when it ends; prompts are capped at 20,000 characters and a diff answer at 400,000 | Partial (U6): the queue has no length limit and a task has no time limit or stop control. Time limits Planned (U13) |
| Idle CLI sessions pile up | Sessions close after 15 minutes idle and resume from their cursor; all close with the server | Done (U4) |
| A vendor rate limit stalls a run | Handoff to another driver, resume at reset time | Planned (U21) |

### Elevation of privilege

| Threat | Boundary | Mitigation | Status |
|---|---|---|---|
| Text in a repository or a web page instructs the agent to run something harmful (prompt injection) | B2, B3 | Approvals for everything but worktree edits; safety floor that no grant overrides; narrow grants | Planned (U7, U9, U10) |
| An agent runs commands outside its worktree | B2 | Until U7, every prompt is denied (`--permission-prompts none`); then the broker. Live-tested for a task: a script in the repository is denied and its marker file exists nowhere | Partial (U3, U6): the CLI decides what needs a prompt. Seen on 2.1.322: it runs, unasked, shell commands it classes as read-only (`ls`, `cat`, `git status`) and ones that only write below the worktree with shell builtins (`printf hi > file`). Closing that is the broker's pre-tool hook, Planned (U7) |
| A signed-in client points Smelt at any repository the owner's account can read | B1 | By design: the owner chooses the repository. The session is required; the repository is only read (its objects, a new branch and a worktree entry are added to its git folder, nothing in its working tree, index or current branch changes); live-tested byte for byte | Accepted (U6). A stolen session can start an agent on any of the owner's repositories and read its diffs |
| A pre-approved command is stretched with chaining or pipes | B2 | Prefix match with no shell operators | Planned (U9) |
| Checks execute code the agent just wrote, on the host | B2 | None. A worktree separates changes; it is not a sandbox | Accepted. Sandboxed checks are deferred |
| The planner or reviewer writes files | B2 | Read-only roles | Planned (U11, U20) |

## Open items, most serious first

1. Checks run agent-written code on the host with the owner's privileges. Until a sandbox exists, the README must say so, and the owner should point Smelt only at repositories they trust.
2. The stop-on-API-key guard is untested on its failing path.
3. Sign-in slow-down is global, sessions never expire, and there is no sign-out.
5. Any signed-in client can start turns in Smelt's scratch directory with every tool prompt denied. That is safe as built; it must be revisited when the approval broker (U7) lets turns run commands.
6. Until the broker's pre-tool hook exists (U7), "denied" means what Claude Code itself would have asked about. Commands it classes as read-only, and shell redirects into the worktree, run in a task without an approval and are in the transcript. A worktree separates changes; it is not a sandbox.
7. A task cannot be stopped from the client and has no time limit; stopping Smelt interrupts it and commits its work.
4. Interception for Codex, Gemini CLI and Grok is unproven; a driver without it is limited to read-only roles.
