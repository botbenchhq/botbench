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
| (no line); "Worked for 2m 14s" when both times are stored, only for a reply with a step of its own, and on its step group's line when it has one | A turn that completed; the time from its first stored event to its last | `turn completed` |
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

On screen since Codex reviews: In review (a task whose run's reviewer is reading its changes, after the checks); Review on New run (Off, or Codex with one of its models); "Codex's review" on the task, under the checks, with "Verdict: looks right", "Verdict: concerns" or "No verdict in the asked form" as its line, and always called a model's opinion, not a check. Settings lists Codex with what it does here: it reviews, and cannot plan or build.

On screen since pull requests: on New run, "When you accept a task" with Keep the branch (the default) and Open a pull request; on the run, "When you accept a task" and what it does; on an accepted task, a Pull request section that says in one sentence what Botbench did ("Botbench pushed the branch and opened pull request #12 into main. Nothing was merged."), the link "Pull request #12 on GitHub" that opens a new tab, what went wrong with Try again, or Open a pull request, whose confirmation names the branch, the remote and its address. "Pull request" in Activity for each step. GitHub's command-line tool is called gh, never by the banned word. The pull request's own Review section reads "No review was run." when there was none; otherwise "Codex reviewed this task: a model's opinion, not a check. Its model:", "How it ended, as the task shows it:" with the task's outcome line, "3 reviews and 2 rounds of fixes.", "Findings of review 3, the last" (or "of the review"; "none listed" when it gave none) and "2 more findings were left out.", "Not addressed, and why" with "Claude Code's words, from the last round of fixes:", and "Accepted by the owner." (", with this note:") or "Accepted without the owner (fully autonomous):" with the reasons.

On screen since issue intake landed: in Add context, From an issue, with "Issue number or address", Look it up, the issue as read (its title, Issue #N of owner/name, Opened by, State Open or Closed, Labels, and What the issue says folded), "People outside this project wrote this issue…", "Allow this repository's network hosts for this run", Attach this issue, Attached to this run. and Remove the issue; the row's value "#123 · the start of its title"; Fully autonomous shown as "Not for a run from an issue"; on a run, a task and an approval card, the Outside text badge and its sentence, and the link "Issue #123 on GitHub".

On screen since notifications landed: Settings → Notifications, with the state of this device as On for this device, Off, Not allowed in the browser's settings, Not available: add Botbench to the Home Screen first (iOS offers notifications only to an app on the Home Screen), Not available: open Botbench at its HTTPS address, or Not available in this browser; the buttons Allow notifications, Stop notifications and Send a test notification; and the notifications themselves, "An approval is waiting", "A task is ready for review", "A task failed", "A task stopped" (a task the screens call Stopped) and "A run ended with nothing to review" (a run the screens call Nothing to review). "Turn on" is not used: `turn` is a banned word.

On screen since connecting landed: Connect (start an agent's own sign-in from Settings), Connect Claude Code (the sheet), Open sign-in page, Code from the sign-in page, Send code, Cancel connecting, Disconnect (the agent's own sign-out, behind "Disconnect Claude Code?" with Keep connected), and Sign in on the Mac (an agent whose sign-in can only be finished in a browser on the Mac, with the command to run there).

On screen since the modes: Mode on New run, the run and the task, and Default mode in Settings, with Manual, Semi-autonomous and Fully autonomous, each with its one line ("Accepts work without you" is Fully autonomous's warning); "Accepted without you" (a fully autonomous run's accept) and its reasons; "It needs your review:" with the reason a fully autonomous run did not accept a task; in Activity "Ran without asking: the run's mode", "Refused without asking: fully autonomous" and "Accepted without you: fully autonomous".
On screen since dictation: Dictate (the message box's microphone button, pressed while it listens), "Listening. Press Dictate again when you have finished.", Transcribing, and errors that say what to allow or install: "The microphone is not allowed for this page. Allow it in the browser's settings, then try again.", "Dictation is not available on this page: the browser allows the microphone only over HTTPS.", and the Mac's own reason when it cannot transcribe. The button is not shown when the Mac or the browser cannot do it.

On screen since the refine loop: "Up to 2 rounds of fixes." beside Review on New run (the cap from the settings); on the task, under "Codex's review", a plain outcome line ("Codex raised 3 concerns. Claude Code addressed 2 and explained 1. Codex is satisfied.", "… Still disagree after 2 rounds: needs your judgment.", "Codex found nothing to fix."), then "Review 1", "Claude Code's fixes 1", "Review 2" and so on, each with its own words one tap away. A round of fixes reads "Addressed 2, explained 1", "Changed nothing, explained 1" or "Changed the work"; while it runs, "Claude Code is working on fixes: round 1 of up to 2."

On screen since devices stay signed in: Settings → Signed-in devices, each device by a label from its browser ("iPhone · Safari", "iPhone · Home Screen app", "Mac · Chrome", or "Browser"), with "Signed in …. Last used …." and This device; Sign out on each row (for this device behind "Sign out this device?" with Stay signed in) and Sign out everywhere else. The sign-in screen's notice after a sign-out is "This device was signed out. Sign in again."

On screen since the composer (New task and New run became one message box on Chat; what those paragraphs say of New run is now in its Add context sheet): the box's name and placeholder, "Message Claude Code", "Describe the task" or "Describe what to plan"; Add context (the + button and its sheet) with the rows Repository ("None (just chat)", a repository by its folder name, "Another folder…" with Folder path), What to do ("One task", "Plan a run": Claude Code plans several tasks for you to approve, then builds them), Spec file, Mode ("A single task always runs in Manual. Plan a run to choose another mode.", and "Runs only" on the modes a task cannot take), Review, When accepted, Allowed commands ("None", "1 command") and Model or Models; Back to Add context, Close Add context; the model chip ("Model: Haiku 5.5 Claude Code" read out); the required chip "Choose a Repository"; and Send's reasons when it waits, such as "Choose a repository" (only after New task or New run, which open the sheet on Repository; with no repository otherwise, Send is a chat), "Checking the repository.", "Give a message or a spec file, not both." and "Add the command you typed to Allowed commands, or clear it: it is not on the list yet."

On screen since the declutter pass: the two destinations Chat and Work (runs and the tasks started on their own; the Tasks list folded into it), Permissions and Usage reached from Settings with a "Settings" back link, "No work yet", a task titled by its own words with "Task 3 · api" under it, Details (the repository's full path and, while the task is worked on, its branch), "What Claude Code can do here" (what the task's agent may do without asking and the limits of its sandbox, under the one line "Nothing has been merged or pushed."), New chat as an icon in the header, and "In review" as a run's state while its reviewer reads a task.

On screen since the self-review run: a task whose builder changed no file reads Failed with "Claude Code finished without changing any file." and its last message, and offers Resume ("Resume starts Claude Code again in the same session, …") and Discard; earlier rounds of checks are named "Checks of the first build", "Checks after round 1 of fixes" or "Checks stopped before they finished"; the review outcome counts every review ("Codex raised 5 concerns, then 3, then 3. Claude Code addressed 8. …"); a request for a tool that is not a shell command reads as the transcript would say it ("Wants to fetch …", or the tool's own name and main argument), with its raw arguments under Technical details; Review lists each reviewer's own default model, the configured one, and "Other model…" with "Codex model name".

Not on screen yet, reserved for when the behaviour exists (no state is shown before it is real): the paused state for a usage limit.

The one allowed use of a banned word is the phrase "a git worktree" in helper text. The guard lets through that phrase, and a file path inside a sentence (a path is a fact about the machine), and nothing else.

## Tool activity

Tool activity stays visible. It builds trust, and it is the evidence.

1. **One line for every action**, in the transcript, in order: a plain verb and the real object, taken from the tool's own name and arguments. "Ran `npm test`", "Read auth.ts", "Edited auth.ts +12 −1", "Searched for startRefreshTimer". The verb says what is so: "Running" while it runs, "Ran" once it returned, "Wants to run" while it waits for an answer, "Did not run" when it was denied.
2. **One tap:** the full command or path, the agent's own reason when it gave one, the output, and the change an edit made.
3. **One level deeper, "Technical details":** the tool's name and its raw arguments.
4. **Open without a tap:** anything that failed. A call waiting for approval is one line in the transcript ("Needs input · Wants to run …"), its details one tap away, because its approval card on the same screen shows the request in full; the card is the one place that says an approval waits there.
5. **Never a guess.** A tool Botbench has no verb for is shown by its own name and its main argument. A line count is counted from the edit's own text or left out. A duration comes from stored times or is left out.
6. **Never raw arguments as the line**, and never a summary in place of the evidence: the evidence is always behind the line.

Token counts are not in the main line of a transcript. They are under the "Worked for" row of the reply they belong to. A reply with no step of its own has no such row at all (Usage keeps its counts). A reply whose calls make a step group has no such row: the group's own line ends with the time ("Read 3 files" and, at its end, "5s", with "Worked for" said to a screen reader), and the tokens follow its calls. A step group is open while its reply arrives and folds to its line once the reply has finished well; one with a call that failed, was not run, did not finish or waits stays open, and what the reader opened or closed stays so.

On screen since chat with any agent: the composer's chip and the Add context row "Model" name the model with the agent as its qualifier ("gpt-6-luna Codex", "Ask several 3 agents"); its view "Agent and model" offers Claude Code, Codex, Grok and Antigravity, each "Not available" with its own reason when it cannot answer, and "Ask several" with a tick for each agent ("Agents to ask"). Once more than one agent has answered in a chat, each reply is labelled "Agent · model" ("Codex · gpt-6-luna"), and a reply that did not finish reads "Codex: Failed" or "Codex: Stopped". Several asked at once: "Send to 3 agents" (the Send button's name), "Asks 3 agents: each reply counts toward that agent's usage.", one "Codex is working." line with "Stop Codex" for each, and under a finished round "Ask one to compare the answers" with "Ask Codex" and so on; the request reads "Codex, compare the answers above: where they agree, where they differ, and which you would act on." In a repository the view says "Only Claude Code can work in a repository."

