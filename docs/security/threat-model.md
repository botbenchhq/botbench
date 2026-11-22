# Smelt threat model (STRIDE)

Scope: Smelt as built through units 1 to 8, plus the boundaries the plan adds next. Update this file in the same pull request as any unit that adds or changes a trust boundary.

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
| B7 | Permission broker socket `broker.sock` in the data directory (U7) | Smelt process | The pre-tool hook the CLI runs, every command an agent runs, any other process of the owner's account |

### How a tool call is decided (U7)

A task's Claude Code is started with Smelt's own settings object on the command line (`--settings`), no settings files (`--setting-sources ""`), the edit rule `Edit(./**)`, and `--permission-prompt-tool stdio`. Three things then stand between a tool call and its running:

1. **The pre-tool hook** (`src/approvals/permission-proxy.ts`, matcher `*`). The CLI runs it before every tool call. It asks the broker over B7 and prints `ask`, `deny`, or nothing. It never prints `allow`. Edits and reads inside the worktree pass (nothing printed); every shell command and every other tool gets `ask`.
2. **The CLI's own rules.** The only allow rule is file edits below the worktree. An ask rule for `Bash` makes every shell command ask even when the hook did not run; a hook's answer cannot get past it.
3. **The permission prompt**, which the CLI sends to the driver on its stdout and the driver answers on its stdin. It becomes an approval row and waits for the owner. Only `POST /api/approvals/:id` with a session resolves it.

The socket answers one question (pass, ask or deny) and has no message that allows a call or answers an approval. The owner's decision travels only inside the Smelt process and down the CLI's own stdin.

### An approval across a restart (U8)

An approval that is pending when Smelt stops, by a shutdown or a kill, stays pending. The next start marks it parked (`parked_at`), stops what is left of its attempt's CLI process, and leaves its task at `building` without re-driving it. Nothing waits in the new process, so the owner's answer cannot be handed to anyone: it is stored on the approval (`stored_decision`, with the log entry, in one transaction) and the approval stays `pending`. Smelt then starts a new attempt that resumes the same CLI session in the same worktree and tells the agent, in words marked as Smelt's, to make its unanswered call again. The stored answer is given to that attempt's request only if all of these hold:

- the request comes from the attempt the engine admitted as resuming the attempt that asked, for the same task and role;
- tool, command (the text the card showed) and worktree-relative directory are equal to the stored ones, and the directory was reported by the hook;
- the approval is still `pending` with that stored decision, and the log holds the owner's decision for it.

The approval is moved to `allowed` or `declined` and the use logged (`stored_answer_applied`) in one transaction before the answer goes to the CLI, so one answer is given at most once, whatever fails afterwards. If the resuming attempt's first request is anything else, including one Smelt itself refuses, or the turn ends without a request, the stored answer is discarded: the approval ends `superseded` with a `stored_answer_discarded` entry, and the new request is an ordinary new card. A stored answer survives no further restart: the next start discards it and marks the task interrupted with the reason.

## Threats and current state

Status: **Done** (built and tested), **Partial**, **Planned** (unit named), **Accepted** (known and not addressed).

### Spoofing

| Threat | Boundary | Mitigation | Status |
|---|---|---|---|
| A client acts as the owner | B1 | Random login token, constant-time compare, session cookie `HttpOnly; SameSite=Strict`, required on every route including from loopback | Done (U2) |
| A web page in the owner's browser calls Smelt | B1 | `Host` allowlist, `Origin` check on writes, JSON-only bodies | Done (U2) |
| A local process reads the token | B4 | Token file mode 0600, directory 0700 | Done (U1, U2). Any process running as the owner can still read it: Accepted |
| Another local process, or another attempt, answers an approval or forges an allow | B7, B1 | The socket has no message that answers or allows; an approval is answered only through the API with the owner's session, and only while its request is still waiting in this process or the approval was parked by a start. Tested: an answer without a session is 401 and stores nothing, a second answer 409 | Done (U7, U8) |
| A process speaks to the gate as an attempt it is not | B7 | Each attempt gets its own 256-bit secret, held in memory (looked up by hash), handed to its CLI process in the environment and never on a command line. Smelt writes it nowhere, and blanks it out of every transcript event before the event is stored or sent to a client (a command the owner allowed can print its environment); tested. Such output still reaches the model provider. A wrong, unbound or released secret is denied and the refusal logged; tested. The socket is mode 0600 inside the 0700 data directory | Done (U7). The secret is readable by every command the attempt's agent runs, and by other processes of the owner's account that can read a process's environment: Accepted, because with it a process can only ask the gate for a verdict, put an "edit passed" entry for a path inside that attempt's worktree in the log, and set the directory a later card shows for a tool call id it would have to guess |
| A process takes the socket's place and answers the hook itself | B7 | Only the owner's account can create files in the data directory. A squatter could answer "pass" for a shell command; the CLI's ask rule still sends that command to the owner | Accepted for the owner's own account; shell commands Done (U7) |
| Agent-written code calls the API during checks | B1, B2 | Login required from loopback too | Done (U2). Such code runs as the owner and could read the token file: Accepted until checks are sandboxed |

### Tampering

| Threat | Boundary | Mitigation | Status |
|---|---|---|---|
| An agent changes the owner's checkout or branch | B2 | One worktree per task from a commit; no command writes the source tree, index or branch; tested byte for byte | Done (U5) |
| A repository hook runs with Smelt's actions | B3 | Hooks disabled on every git call; commits skip verification and signing | Done (U5) |
| A repository's CLI settings allow commands silently, or its CLI hooks run commands at session start | B3 | Task attempts load no settings file at all (`--setting-sources ""`): Claude Code 2.1.322 was seen to run a repository's `SessionStart` hook without asking when project settings were loaded. The only settings are Smelt's own object. Live-tested with a repository carrying allow rules for `Bash` and `Write` and a hook: the command still waits for the owner and the hook does not run | Done (U6, U7) |
| A repository's instructions file pulls a file from elsewhere on the machine into the prompt | B3 | With settings files off the CLI does not read `CLAUDE.md`; Smelt reads it and hands it over as appended system prompt text. Only an ordinary file at the top of the worktree, opened without following a link, at most 64 KB; files it refers to are not pulled in. Tested with a link, a directory and an oversized file. The text instructs the agent, never Smelt | Done (U7) |
| The transcript or action log is edited | B4 | Append-only tables enforced by triggers; the store module has no function that changes or removes a log entry; an approval leaves `pending` once and is never deleted. Tested | Done for events (U1) and the action log and approvals (U7). A process of the owner's account can still replace the database file: Accepted |
| The owner approves a command other than the one that runs | B2 | The card shows all of the input an allow lets run: a plain shell command as itself, and an edit, a shell call with further options or any other tool as the CLI's whole input. A request longer than 20,000 characters is denied by Smelt, not shown in part, and the transcript says Smelt denied it, not the owner. Characters that hide or reorder text are written out by code point. An allow re-sends the CLI the input that was shown, unchanged, and what a pending approval asks for cannot be changed in the store. A command can still do more than it appears to (a script's content is not shown) | Done (U7) for what is shown; reading it is the owner's |
| Text from a model or a repository is rendered as markup in the client | B1, B2 | All transcript text is rendered as text, tested with markup in a prompt | Done (U4) |
| Crafted run or task ids reach git or the filesystem | B1 | Ids must be slugs; arguments passed as arrays, file names after `--` | Done (U5) |
| A client names a repository path that is not one (relative, a file, a subfolder, a path with a NUL) | B1 | The path must be absolute and is checked as the top level of a git repository with a commit before any task row, worktree or git write exists; tested over HTTP | Done (U6) |
| A client asks for the diff of a file outside the task (`../`, an absolute path, a git option, a pathspec) | B1 | Task ids are digits only; the file must equal a name git itself listed among the task's changes, and only that listed name is handed to git, after `--` with literal pathspecs; tested | Done (U6) |
| An agent's edits land outside its task's worktree | B2 | The attempt's working directory is the worktree and the one allow rule covers file edits below it (`--allowedTools "Edit(./**)"`); a write elsewhere, and to the CLI's own settings, is denied by the CLI; Smelt commits only in a linked worktree on a `smelt/` branch. Live-tested on Claude Code 2.1.322 with a write aimed at the owner's checkout | Done (U6, U7): the CLI's rule, and Smelt's gate in front of it, which sends an edit outside the worktree to the owner with its whole content on the card |
| Files a task wrote make Smelt's own git run a command (the worktree's `.git` repointed at a git folder with a filter command in its config) | B2, B3 | Before any commit, diff or removal the worktree's git folder must be the repository's own worktree entry and must not lie inside the worktree; tested with a real filter command that does not run. The owner's own repository config, filters included, still applies to Smelt's commits | Done (U6) |
| A task is left at a station nothing is working at after Smelt stops | B4 | State and its event are written in one transaction; on start, tasks left queued or building are marked interrupted and their work committed, except a task that was waiting on the owner, which is parked (U8). Every CLI process group the last run recorded is stopped first | Done (U6, U8). Re-driving a task that was mid-turn: Planned (U15) |
| A stored answer is replayed: used twice, or for another task, attempt, tool, command or directory | B2, B4 | See "An approval across a restart". The answer is used up in the store before it is delivered; matching is exact and bound to the resuming attempt of the same task; a second identical request in the same turn asks the owner again. Tested without a CLI for each of these, and live for allow and decline | Done (U8). The match is on what the card showed: for a shell call that is the command, so the agent's own description of it may differ. Two inputs the card shows alike (a U7 limit) match alike |
| A row is written into the store to look like an answered approval | B4 | Triggers: an approval is first written `pending`, neither parked nor answered; an answer is stored once and only on a parked approval, and its note is fixed with it; a parked approval ends only as its stored answer or `superseded`; a stored answer is applied only if the log, which is append-only, holds the owner's decision for it. Tested | Done (U8) against a mistake in Smelt and a row-level edit. A process of the owner's account that rewrites the database file can still forge all of it: Accepted, as for the log |
| Two agents write to one worktree after a restart | B2 | On start, before any task is parked or re-driven, the process group each attempt of the last run recorded is stopped, and again before a re-drive; if it cannot be stopped the task is not resumed. A re-drive runs in the engine's one queue, after recovery. Tested with a real surviving process, and live with a frozen Claude Code that outlived a killed Smelt | Done (U8) |
| Smelt kills a process group that is not its own, because the number passed to another process | B2 | A group is stopped only if the machine has been up since the attempt was made and its leader began no later than the attempt (times read in UTC), or its leader is gone while members remain. A leader that began later is left alone and the attempt forgets the number. Tested in two time zones | Done (U8). A leaderless group under a number that was reused within one uptime would be taken for the attempt's: Accepted |

### Repudiation

| Threat | Mitigation | Status |
|---|---|---|
| No record of what an agent did or who allowed it | Every event stored as it arrives. The action log records each request put to the owner (`asked_owner`), each decision with its log entry in one transaction (`owner_allowed`, `owner_declined`), each request that ended with no answer (`ended_unanswered`), each edit the gate let pass to the CLI's edit rule (`auto_worktree_edit`, written before the edit; an edit that cannot be logged is denied), and each refusal by the broker (`broker_failure_denied`). No shell command runs without an `owner_allowed` entry | Events Done (U3); approvals and action log Done (U7); standing and pre-approved permissions Planned (U9, U10). The log has one owner and so records no "who" |

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
| A CLI process outlives its turn or a restart | Own process group, killed on interrupt and close; survivors stopped on start | Kill Done (U3); stop-on-start Done (U8) |
| An agent or a check fills the disk or runs forever | Per-command time limits | Planned (U13). No disk quota: Accepted |
| A malformed request line crashes the server | A request target that cannot be parsed is answered with an error | Done (U4) |
| A client starts many tasks | Tasks build one at a time, each a single turn whose CLI process is closed when it ends; prompts are capped at 20,000 characters and a diff answer at 400,000 | Partial (U6): the queue has no length limit and a task has no time limit or stop control. Time limits Planned (U13) |
| A git process never returns, for example on an external drive macOS will not let a background service read, so a request hangs and git processes pile up | Every git process runs in its own process group with a time limit (5 s for checks of a repository, 120 s for worktree, commit, diff and removal work) and the group is killed at the limit; the answer says the folder could not be read in time; the client ends its own check request after 10 s | Done (U6) |
| Idle CLI sessions pile up | Sessions close after 15 minutes idle and resume from their cursor; all close with the server | Done (U4) |
| A vendor rate limit stalls a run | Handoff to another driver, resume at reset time | Planned (U21) |
| A pending approval holds a task, and with it the queue, for as long as it is unanswered | By design: the task waits for the owner. Claude Code 2.1.322 was seen to keep a permission request open for seven minutes and carry on when answered; no limit was found. Stopping Smelt does not end the wait: the request stays pending and its task is parked, off the queue, until the owner answers after the next start | Accepted (U7); survives a restart: Done (U8) |
| A second Smelt is started on the same data directory | It finds the first one's broker answering on the socket and refuses to start, before it touches the socket or any pending approval; tested | Done (U7) |
| A process of the owner's account floods the socket | Messages are capped at 256 KB and 10 seconds; every refusal adds a row to the action log, with no limit | Accepted (U7): only the owner's own account can reach the socket |

### Elevation of privilege

| Threat | Boundary | Mitigation | Status |
|---|---|---|---|
| Text in a repository or a web page instructs the agent to run something harmful (prompt injection) | B2, B3 | Model output and repository text can cause a request, never an allow: nothing they produce reaches `answer`. Everything but edits and reads inside the worktree waits for the owner. The agent's stated reason is shown on the card as its own words | Approvals Done (U7). The owner can still be talked into allowing something; safety floor and narrow grants Planned (U9, U10) |
| An agent runs a command without the owner being asked | B2 | In a task, every shell command waits for the owner, including the ones Claude Code runs unasked by itself (`ls`, `cat`, `git status`, `printf hi > file`). Live-tested: `ls` and a redirect each wait and have no result before their answer; a declined script's marker file exists nowhere. Turns outside a task still have every prompt denied (`--permission-prompts none`) | Done (U7) for shell commands, as far as the CLI honours an ask rule and its own prompt. See "What can still run without the owner" below |
| The hook or the broker fails, and a call runs because nothing objected | B7, B2 | The hook answers deny when the socket is missing, slow, wrong or says anything but pass, ask or deny; the broker denies a malformed message, a wrong secret, and a request it cannot record; a prompt the driver cannot read is denied. A hook that never runs or is killed counts for the CLI as silence: shell commands still ask (the ask rule), edits and reads follow the CLI's own rules, and what those would ask a person still comes to the owner. Tested without a driver for every broker and proxy case | Done (U7), except for tools other than the shell on a hook failure: see below |
| A newer CLI silently ignores Smelt's settings object, so neither hook nor ask rule exists | B2 | The driver watches each gated attempt: a shell result with no allow from the owner stops the attempt at once and says why. One command has run by then. The live `ls` test is the check to run after every CLI update | Partial (U7): detection after the first command, not prevention |
| A signed-in client points Smelt at any repository the owner's account can read | B1 | By design: the owner chooses the repository. The session is required; the repository is only read (its objects, a new branch and a worktree entry are added to its git folder, nothing in its working tree, index or current branch changes); live-tested byte for byte | Accepted (U6). A stolen session can start an agent on any of the owner's repositories and read its diffs |
| A model name sent by a client, or set in a config file, is read by the CLI as a flag, or carries a shell or control character (argument injection through `--model`) | B1, B2 | The name is checked before anything else happens with the request: it starts with a letter or digit, holds only letters, digits and `. _ : / @ [ ] -`, and is at most 100 characters, so it cannot start with `-` or hold a blank or control character. A value that fails is answered 400 before any attempt, task row or worktree exists; the driver checks again when it builds the arguments, and the config loader applies the same rule. The name is one argv entry after `--model`; no shell is involved. Names in the list the CLI reports are held to the same rule, and nothing else of that answer (it also describes the account) is passed on. Tested without a driver for the routes, the arguments and the list | Done (U25). A signed-in client can choose any model the owner's login may use, the most expensive included; a stolen session can therefore spend the owner's subscription quota faster. Whether a name is a real model is left to the CLI, whose error is shown in words |
| A pre-approved command is stretched with chaining or pipes | B2 | Prefix match with no shell operators | Planned (U9) |
| Checks execute code the agent just wrote, on the host | B2 | None. A worktree separates changes; it is not a sandbox | Accepted. Sandboxed checks are deferred |
| The planner or reviewer writes files | B2 | Read-only roles | Planned (U11, U20) |

## What can still run without the owner (U7)

Stated exactly, for a task's attempt on Claude Code 2.1.322:

- **Edits and reads inside the worktree** run without asking, by design. Edits are logged before they run; reads are not logged. Writes to anything named `.git` or `.claude` at any depth, also through a link, are sent to the owner, and so is a search whose pattern is absolute or contains `..`.
- **Shell commands** never run unasked.
- **Other tools** (web search and fetch, sub-agents, scheduling and messaging tools the CLI ships) are sent to the owner by the hook. If the hook fails for such a call (it crashes, or takes more than 20 seconds because Smelt is stalled), the CLI's own default applies to that one call, and for a tool the CLI runs without a prompt that means it runs. The ask rule covers only `Bash`. Narrowing the CLI's tool list is the fix and belongs with the safety floor (U9).
- A command the owner allows runs with the owner's rights, anywhere. A worktree separates changes; it is not a sandbox.

## Open items, most serious first

1. Checks run agent-written code on the host with the owner's privileges. Until a sandbox exists, the README must say so, and the owner should point Smelt only at repositories they trust.
2. The stop-on-API-key guard is untested on its failing path.
3. Sign-in slow-down is global, sessions never expire, and there is no sign-out.
4. Any signed-in client can start turns in Smelt's scratch directory with every tool prompt denied. Those turns are not behind the gate (U7 gates tasks only): there, "denied" still means what Claude Code itself would have asked about, so commands it classes as read-only run in the scratch directory unasked.
5. On a failure of the pre-tool hook, tools other than the shell fall back to the CLI's own defaults for that call (see "What can still run without the owner"). A CLI update that dropped Smelt's settings object would be noticed only after one shell command had run.
6. Across a restart (U8): an answer the owner stored is lost if Smelt stops again before it is applied (the task is then interrupted and says so), and so is the unanswered half of a task with two parked requests of which one was answered. After a resume the task screen shows only the resuming attempt's transcript, which opens with Smelt's own prompt under the label "You"; the earlier attempt's events stay in the store. If the resumed agent does not repeat its call, the stored answer is discarded, never applied to something else. `stored_answer_applied` is logged before delivery: if the CLI dies in that instant the answer is spent and nothing ran.
7. The repository's instructions are handed to the CLI in a file in an owner-only temporary directory, removed when the CLI process exits. A Smelt that is killed outright leaves that copy behind. The text goes in as appended system prompt, which is more weight than the CLI gives the file when it reads it itself.
8. Two plan scenarios have no test: a command the owner's personal CLI settings allow (not testable without changing the owner's own settings; covered by the argument check that no settings file loads), and the driver's handling of a cancelled or duplicate permission request (reached only with a live CLI).
9. A task cannot be stopped from the client and has no time limit; stopping Smelt interrupts it and commits its work.
10. Interception for Codex, Gemini CLI and Grok is unproven; a driver without it is limited to read-only roles.
