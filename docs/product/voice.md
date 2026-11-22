# Voice: the words Botbench shows

Read this before writing any text a person sees: a label, a state, an error, a helper line, an accessible name, the tab title, and any sentence the server sends to a screen. The research behind it is `ui-copy-research.md` in this directory.

## Principles

- **Familiar words.** Say what other products say: chat, task, plan, branch, allow, deny, working. A word from Botbench's code is not a word for the screen.
- **Anyone can approach it.** A first-time reader who is not an engineer knows what each control does before tapping it.
- **Plain first, precise behind.** The plain sentence leads. The exact command, path, id or git term stays one tap away or in helper text. Text never gets vaguer to get plainer.
- **Show what the agent did.** Every action is a line in the transcript. Nothing is hidden; detail is folded, never removed.
- **Only what is real.** A summary, a count, a duration or a name comes from the real event. When it cannot be derived, show the real name and argument, never a guess.
- **Errors help.** What happened, why if known, what to do next. No blame, no exclamation marks.
- **Sentence case.** One name for one thing, everywhere.

## Glossary

The third column is the list the automated guard reads (`e2e/voice.ts`): every term in backticks there fails a test when it appears as a whole word, in any case, with or without a final "s", in text Botbench wrote. Text a person, the agent or a program wrote (a prompt, a reply, a command, a path, output) is not checked.

| On screen | What it means internally | Never shown |
|---|---|---|
| Chat; New chat | The screen that sends one prompt after another to the agent outside any repository; each exchange is a turn of an attempt | `turn`, `attempt` |
| (no line); "Worked for 2m 14s" when both times are stored | A turn that completed; the time from its first stored event to its last | `turn completed` |
| Model, with the name the agent reports (Haiku 5.5); the exact id under the row | The model id of the session-started event | `session started` |
| Agent, by product name: Claude Code, Codex | A driver: the adapter that runs a vendor's command-line program | `driver`, `CLI` |
| Allow once; Always allow…; Deny; Deny and say what to do instead | Answers to an approval: allow, grant, decline, decline with a note | `decline`, `declined`, `declining` |
| Allowed for this task; Allowed for this run | Pre-approved commands listed when the task or run was started | `pre-approved`, `preapproved` |
| Always allow; Always allowed | A standing permission (a grant) for one exact command, step, folder and repository | `standing permission`, `grant` |
| Permissions, with Always allowed and Activity | The trust screen: grants in force and the action log | `trust screen`, `action log` |
| a separate copy; "(a git worktree)" in helper text only | The task's git worktree | `worktree` |
| Queued | Task queued; run waiting for the planner | `station` |
| Working | Task building | |
| Needs input | Waiting on an approval | `waiting on you`, `parked` |
| Ready for review | Awaiting decision: the work is finished and waits for the owner | `awaiting decision` |
| Stopped | Interrupted | `interrupted` |
| Failed | Failed | `blocked` |
| Plan → Build → Review; planner, builder, reviewer only where a person needs the distinction | Roles: planner, implementer, reviewer | `implementer`, `role` |
| usage limit; "Paused · usage limit (resumes 3:14)" only with a real reset time | A rate limit reported by the agent | `rate limit` |
| Botbench, "the permission check", "the safety rules", "live updates" | The broker, the gate, the safety floor and never-list, the hook, the event stream, the store | `broker`, `gate`, `floor`, `never-list`, `hook`, `stream`, `SSE`, `superseded`, `resume cursor`, `pgid`, `admission`, `schema`, `migration` |
| Task, Run, Plan, Branch, Usage, Connect | The same | |
| Botbench | The product, which was called Smelt before it was renamed. The old name stays only in code that reads an old installation, never on screen | `Smelt` |

On screen since the build and verify steps landed: Checking (the project's checks are running) and Cancelled (the owner stopped the run before this task started). Check results read "Checks passed", "Checks failed" or "No checks are set up for this repository", never a bare colour.

On screen since decisions landed: Accept and Reject (the buttons), and Accepted and Rejected (decided). Reject asks "Keep the branch" or "Delete the branch". Files the checks left in a task's copy read "These files were left by the checks and are not on the branch". A decided run reads Done.

On screen since the runs board landed: the board's groups Needs you, Running and Finished; Nothing to review (a run whose every task failed, was stopped or was cancelled, so there is nothing to decide); Discard (the button that removes what such a task left, its separate copy and its branch; never a decision) and "You discarded" in Activity; Settings, with Agents (each agent as Available, Signed out, Unsupported version or Not installed) and Appearance (Mode: Dark, Light, Match device).

Not on screen yet, reserved for when the behaviour exists (no state is shown before it is real): In review (reviewing), and the paused state for a usage limit.

The one allowed use of a banned word is the phrase "a git worktree" in helper text. The guard lets through that phrase, and a file path inside a sentence (a path is a fact about the machine), and nothing else.

## Tool activity

Tool activity stays visible. It builds trust, and it is the evidence.

1. **One line for every action**, in the transcript, in order: a plain verb and the real object, taken from the tool's own name and arguments. "Ran `npm test`", "Read auth.ts", "Edited auth.ts +12 −1", "Searched for startRefreshTimer". The verb says what is so: "Running" while it runs, "Ran" once it returned, "Wants to run" while it waits for an answer, "Did not run" when it was denied.
2. **One tap:** the full command or path, the agent's own reason when it gave one, the output, and the change an edit made.
3. **One level deeper, "Technical details":** the tool's name and its raw arguments.
4. **Open without a tap:** anything that failed and anything waiting for approval.
5. **Never a guess.** A tool Botbench has no verb for is shown by its own name and its main argument. A line count is counted from the edit's own text or left out. A duration comes from stored times or is left out.
6. **Never raw arguments as the line**, and never a summary in place of the evidence: the evidence is always behind the line.

Token counts are not in the main line of a transcript. They are under the "Worked for" row of the reply they belong to.
