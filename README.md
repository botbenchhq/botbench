# Botbench

**Put your coding agents to work. Together.**

One workbench for your agents. One coordination layer for your team.

Your coding agents are powerful. But as you add more agents, tools and teammates, keeping their work organized, and making sure it all fits together, becomes a job of its own.

Botbench is a local-first workbench for the coding agents you already use. Hand them tasks, let them work within your policies, and come back to git branches, diffs, check results and review evidence, instead of piecing together what happened across terminals.

**Work on your own.** Give agents tasks in separate working copies, choose how much supervision they need, and inspect the work before you accept it.

**Work with a teammate.** Separately run Botbench installations already see each other's work, can claim a GitHub issue so only one of them takes it (a setting you turn on for a repository), and can check two changes together before either is merged.

**Where it is going.** Connect your workbench with a colleague's, so your agents and theirs coordinate who does what, exchange the context each of you chose to share, manage what depends on what, and deliver work that fits together, while each person keeps control of their own agents, environments and permissions. This part is not built yet; [Where it is going](#where-it-is-going) says what is planned.

Your agents. Their agents. One coordinated workflow.

Walk away. Come back to the branch.

[Quickstart](#quickstart) · [What works today](#what-works-today) · [Where it is going](#where-it-is-going)

> **Current availability.** Early, and macOS only. Claude Code, signed in with your own subscription, plans and builds. Codex can build too, in its own sandbox, and Codex, Grok and Antigravity review and chat. Messages sent directly between workbenches and a container for each task are in development. Each task works in a separate copy of your repository, which separates changes and is not a security boundary; commands are confined by the macOS sandbox, which is not a virtual machine or a container ([Is it a sandbox?](#is-it-a-sandbox)). It is not a hosted service, and it never merges a pull request.

<!-- CAPTURE: a 20 to 30 second screen recording at phone size, from a real task in a practice repository: type the task in the message box, Send, the approval card appears, Allow once, the task reads Ready for review with its changed file and branch, Accept. Upload it to GitHub and put its <video> tag here, above the screenshots. -->

## Why Botbench exists

One coding agent in one terminal is easy to follow. Several are not. You answer permission prompts as they come, keep track of which branch holds what, and take an agent's word that it is done.

Add a teammate who hands work to their own agents, and the two of you become the messengers. One agent builds an API; the other developer's agent needs that contract for the frontend; you and your teammate carry it from one conversation to the other. You find out you both took the same issue when the second pull request opens, and that two changes do not fit when both are merged.

Botbench is built for both problems. For the first, it does a good deal today. For the second, it does the first steps, and the larger part is still to come. This page keeps the two apart.

## Two ways to use it

### Your workbench

Start a task, or a run of several, from a browser on the Mac or on your phone. Each task works in its own copy of your repository, on its own branch; your files and your branch are not touched. You choose how much each run needs you: manual, semi-autonomous or fully autonomous. An action that reaches outside the task's copy waits for your answer, and a short list of dangerous ones always asks, or is refused when nobody is there. Botbench then runs your repository's checks and keeps their output, and another vendor's agent can review the change. You come back to a branch, its diff, the checks and the transcript, and you accept it or reject it.

<p>
  <img src="docs/images/approval-card.png" alt="A task titled by its own words, showing one approval card: Claude Code asks to run a command, sh make-marker.sh, with its folder and reason, Allow once, Deny, and Deny and say what to do instead; below it the transcript line Needs input, Wants to run sh make-marker.sh" width="200">
  &nbsp;
  <img src="docs/images/ready-for-review.png" alt="The same task, ready for review: the command ran once you allowed it, no checks set up, marker.txt added, the task's branch, and Nothing has been merged or pushed" width="200">
</p>

*On a phone. Left: Claude Code waits for your answer before running a command. Right: the finished task with its checks, changed files and branch, waiting for your decision.*

<!-- CAPTURE: a new docs/images/ready-for-review.png of the same screen. The current one predates named workbenches and shows the branch botbench/run-1/task-1; a new task's branch is botbench/<workbench>/run-1/task-1. -->

### Your team's coordination

Two developers, each with their own Mac, their own Botbench and their own agents, on one GitHub repository. Neither gives the other access to their machine. What Botbench does about that today:

- **Branches never clash.** Each workbench puts its name in its branches (`botbench/<workbench>/run-N/task-M`). Change the name in Settings → Workbench.
- **You see each other's work.** The Work screen shows, read only, the other workbenches' open pull requests and pushed branches on the same remote, read with your own `gh` and `git`.
- **You are warned before you overlap.** Under the message box, when another workbench already has a pull request open for the issue you attached, or has started on it. Under Your decision, when another workbench's open pull request changes the same files as your task, so the two may conflict when both are merged.
- **Only one of you takes an issue, if you choose.** With `"claimIssues": true` for the repository in each settings file, a run from an issue that opens pull requests claims the issue as it starts, with two empty branches on the remote. The remote takes only the first claim; the other workbench's run stops and says who started first. Nothing is pushed for a run that keeps its work on your Mac.

Apart from a claim, nothing is written to GitHub for this, and nothing another workbench wrote is put in a prompt to your agents. It works when both workbenches push their branches or open pull requests on the same remote, with `gh` signed in on each Mac. Checking your task together with another workbench's open pull request is built: on a task that is ready for review, you ask for it, and Botbench merges the two in a temporary copy and runs the repository's own checks on the merge (`src/engine/combined.ts`). What it can and cannot tell you is under [What works today](#what-works-today).

<img src="docs/images/desktop-peers.png" alt="The Work screen on a desktop, Other workbenches: two branches pushed by teammates, botbench/dev2/run-19/issue-70 and botbench/dev3/run-15/issue-72, each with its workbench name, the issue it started on, how long ago, and the repository" width="100%">

*Two other workbenches, each started on an issue, seen from a third.*

<!-- CAPTURE: a screenshot from two real installations of the task screen's "Your decision" with the line "<workbench>'s open pull request #<n> also changes <files>, so the two may conflict when both are merged." -->

## Proof, not promises

Every task ends in things you can inspect: a branch, its diff, the output of your own checks, and the transcript of what the agent did and what you answered. A review by another vendor's agent is shown as a model's opinion, never as a check.

<img src="docs/images/desktop-work.png" alt="A task on a desktop screen, dark theme. Checks: 2 of 2 checks passed, npm run typecheck and npm test, each Passed. Then Codex's review of Claude Code's work: Codex raised 3 concerns, then 4; Claude Code addressed 1 and explained 6; needs your judgment. Review 1 lists what Codex checked" width="720">

*On a desktop screen: a real task's checks and its reviewer's verdict, from a run on this repository.*

<img src="docs/images/desktop-review.png" alt="A task's review section on a desktop screen: Codex, a different vendor from the builder, raised 5 concerns, then 3, then 3; Claude Code addressed 6 and explained 2; the page lists what the reviewer checked in each round, and the line that the reviewers still disagree after 2 rounds: needs your judgment" width="100%">

*The reviewer is another vendor's agent. Here Codex reviewed Claude Code's work in three rounds, and the task waited for a person to decide.*

Botbench is built with Botbench where it can be. [Pull request #113](https://github.com/jon-lange/botbench/pull/113) is one it pushed and opened: its description is the task's evidence, from what was asked to the review.

When two workbenches change the same repository, Botbench can merge your ready task with a teammate's open pull request in a temporary copy and run the repository's own checks on the result, so you learn that two changes do not fit before either is merged. A passing check proves only what the check covers.

### What changes

| Without Botbench | With Botbench |
|---|---|
| You keep a terminal open and answer each permission prompt as it comes. | The agent uses its tools inside the task's own copy of your repository without asking; the shell commands it runs there are confined by the macOS sandbox. An action that reaches outside the copy waits as a card you can answer from your phone. |
| The agent edits your checkout, and you sort out what changed. | Each task works in its own copy on its own branch. Your files and your branch are not touched. |
| "Done" is the agent's word. | Botbench runs your repository's checks and keeps their output. Another vendor's agent can review the change; its review is shown as a model's opinion, never as a check. |
| Two developers find out they took the same issue when the second pull request opens. | Each workbench's branches carry its own name, and you see the other workbenches' open pull requests and pushed branches. When you start, Botbench says if another workbench already has a pull request for your issue; when you review, it says if another workbench's open pull request changes the same files. |

## Is it for you?

**Use it if** you work on a Mac, use Claude Code with your own sign-in, and want to hand it work and come back to a reviewable branch instead of watching a terminal; you want a record of every command an agent ran and every answer you gave, kept on your machine; or you and a teammate both hand work to agents in one repository and want to see each other's work before you start.

**Don't use it if:**

- **You are on Windows or Linux.** Agents are started only on macOS, because the confinement relies on macOS's sandbox.
- **You want a hosted service or a shared team server.** Each developer runs their own Botbench on their own Mac, behind its own login token. There are no accounts, and two workbenches share nothing but what they push to GitHub.
- **You need a hard security boundary for code you do not trust.** See [Is it a sandbox?](#is-it-a-sandbox) below.
- **You need it stable.** It changes often, and nothing here is promised to stay the same.

## Quickstart

About ten minutes. It ends with a branch made by Claude Code in a practice repository, and costs one short Claude Code turn on your subscription.

**You need:** macOS; Node 24 or later; git, set up so you can commit; [Claude Code](https://www.anthropic.com/claude-code) 2.1.322 or later, installed and signed in (`claude --version`, `claude auth status`). Codex 0.171.0 or later only if you want it to review or build.

**1. Get it and build the screens.** The server has nothing to install to run; the first `npm ci` brings what the build of the screens needs.

```sh
git clone https://github.com/jon-lange/botbench.git
cd botbench
npm ci
npm ci --prefix web
npm run build --prefix web
```

**2. Start it.** Leave this terminal open; Ctrl+C stops Botbench.

```sh
npm start
```

It prints:

```
Botbench is listening on http://127.0.0.1:4780
Login token (shown this once, kept in /Users/you/.botbench/login-token): …
```

The token is printed only on the first start. Later, read it with `cat ~/.botbench/login-token`. To use another port or data folder for one start, set `BOTBENCH_PORT` and `BOTBENCH_HOME`, for example `BOTBENCH_PORT=4781 BOTBENCH_HOME=/tmp/botbench-trial npm start`.

**3. Sign in.** Open http://127.0.0.1:4780 in a browser on the Mac, paste the token and choose Sign in. You arrive on Chat. On a fresh installation it reads "Tap + to choose a repository, or just ask a question." and "Claude Code is signed in." If it says "Connect an agent in Settings → Agents." instead, run `claude auth login` in a terminal. Settings (the gear, top right) → Agents shows each agent's state.

<img src="docs/images/desktop-settings.png" alt="Settings on a desktop screen, Agents section: Claude Code, Codex, Grok and Antigravity, each with its version, signed in with a subscription, what it does here, and the state Available" width="100%">

<img src="docs/images/agents-available.png" alt="Settings: links to Permissions and Usage, then Agents: Claude Code, version 2.1.322, signed in with a subscription, plans and builds tasks, Available; Codex, version 0.171.0, reviews a run's tasks, Available" width="260">

**4. Make a practice repository**, in a second terminal:

```sh
mkdir ~/botbench-try && cd ~/botbench-try
git init
echo "# Try" > README.md
git add README.md && git commit -m "Start"
pwd
```

**5. Start a task.** In Botbench, on Chat, press + (Add context) under the message box and choose Repository, then Another folder…. Paste the path `pwd` printed into Folder path; when it reads "Usable git repository.", close the sheet with the X. What to do is already One task. The box now reads "Describe the task"; write:

```
Add a file hello.txt that says hello, then run ls to show that it is there.
```

Any model will do; the chip under the box shows the one in use, and a small one such as Haiku is enough (tap the chip to change it). Choose Send.

**6. Watch it work.** Within a minute the transcript shows Claude Code writing the file and running `ls`. Neither asks you: both stay inside the task's copy. A card appears only for an action that reaches outside the copy; if you see one, read it and choose Allow once or Deny.

**7. Review and accept.** The task reads Ready for review, with "No checks are set up for this repository", `hello.txt` under Changed files, and its branch, such as `botbench/your-mac/run-1/task-1`. The middle part is your workbench's name, made from the Mac's name at first start; Settings → Workbench shows it. Choose Accept. Botbench keeps the branch and removes the task's copy.

**8. See the branch** in the practice repository, using the name `git branch` lists:

```sh
git branch
git log --stat -1 botbench/your-mac/run-1/task-1
```

The branch holds one commit by Botbench that adds `hello.txt`. Your own branch is unchanged, and `git status` shows nothing to commit.

**Clean up:** Ctrl+C in the first terminal, then `rm -rf ~/botbench-try`. Botbench keeps its database and login token in `~/.botbench`; delete that folder only if you want to start again from nothing.

From here, try Work → New run on a real repository (or, in Add context, What to do → Plan a run): Claude Code proposes a plan first, and you can add checks and a reviewer.

## What works today

| State | What | Where |
|---|---|---|
| **Works today** | Claude Code plans and builds; one task at a time, each in its own copy and branch | `src/drivers/claude-code.ts`, `src/engine/` |
| | Approval cards, commands allowed in advance, Always allow, and a list of dangerous commands that always ask | `src/approvals/` |
| | Confined commands, per-repository checks and setup commands | `src/confinement.ts`, `src/engine/stations.ts` |
| | Codex as a builder, chosen per task or run once Botbench's check finds that this Codex can build: it works in its own sandbox, in the task's copy, with no network, and asks you each time it wants to run something outside that sandbox (a fully autonomous run refuses those). Claude Code still plans a run | `src/drivers/codex.ts`, `src/drivers/codex-app-server.ts`, [`docs/security/codex-app-server-check.md`](docs/security/codex-app-server-check.md) |
| | Codex, Grok or Antigravity as reviewer (Grok and Antigravity review only; none of the three plans), and rounds of fixes in which the builder answers the review | `src/drivers/`, `src/engine/review.ts`, `src/engine/refine.ts` |
| | Three modes per run: manual, semi-autonomous, fully autonomous | `src/engine/modes.ts`, `src/approvals/gate.ts` |
| | Opening a pull request for an accepted task, with your own `git` and `gh`; never merged | `src/engine/delivery.ts`, `src/github.ts` |
| | A run started from one GitHub issue you name, read with your own `gh` and treated as outside text (no command allowed in advance or always allowed, no network unless you allow it, never fully autonomous); its pull request closes the issue. Nothing is posted to GitHub | `src/engine/intake.ts` |
| | Named workbenches, and a read-only view of other workbenches' open pull requests and pushed branches on the same remote, with a warning when one already covers your issue or your files. With `"claimIssues": true` for a repository in the settings file (off by default), a run from an issue that you set to open pull requests claims the issue as it starts: two empty branches other workbenches see, created by the remote only if no other workbench holds the issue, so the later one stops and opens no pull request; they are deleted if the run ends without a pull request | `src/workbench.ts`, `src/engine/peers.ts`, `src/engine/claims.ts`, `web/src/app/peers.ts` |
| | Checking a ready task together with another workbench's open pull request: Botbench merges the two in a temporary copy and runs the repository's own setup and checks on the merge, confined like any check, then shows the result, labelled as including another workbench's code. It pushes nothing and removes the copy. The result counts only while both branches are still at the commits it ran on. With "require checking together" set for a repository by its owner through the API, a fully autonomous run does not accept a task by itself while an open pull request from another workbench that changes the same files has no passing, current check together | `src/engine/combined.ts`, `src/api/check-together.ts`, `web/src/components/check-together.tsx` |
| | Watching a repository for open issues that carry a label you chose (`"watch": { "label": …, "intervalMinutes": … }` in the settings file): Work lists each as a proposal, with Start and Dismiss. It starts nothing by itself, and an issue is proposed once | `src/engine/watch.ts`, `docs/adr/0008-watch-issues.md` |
| | When a builder's usage limit is reached, its task waits and Botbench starts the builder again once, in the same session, at the reset time the agent gave (or after 30 minutes, or `autonomy.usageLimitWaitSeconds`); a second limit stops the task for you. A run can choose instead, in Add context, "When the builder reaches its usage limit: Switch to the next agent": the task then moves at once to the next agent on the ordered list in Settings (Runs → "When a builder reaches its usage limit, switch to"), in the same copy and on the same branch, and waits as above only when no agent on the list can take it | `src/engine/usage-limit.ts`, `src/engine/handoff.ts` |
| | Move a task that is being built to another agent (Claude Code ⇄ Codex) from its screen: the work so far is committed, and the other agent takes it over in a new session with a note of the task, its plan, what was done and the diff, under the same mode and safety rules; never to the run's reviewer | `src/engine/handoff.ts` |
| | An agent that asks you a question: the builder or planner raises a card with lettered choices, the task reads Needs input, and the question survives a restart | `src/approvals/question.ts` |
| | Chat with Claude Code, Codex, Grok or Antigravity outside a repository, or ask several at once and compare | `web/src/screens/turn.tsx` |
| | One message box to start chats, tasks and runs; dictation transcribed on the Mac; Accept or Reject; runs board, usage, settings, signed-in devices; recovery after a restart | `web/src/screens/`, `src/dictation/`, `src/api/auth.ts` |
| **In the code, not confirmed on a real iPhone** | Adding Botbench to the phone's Home Screen, and notifications when an approval is waiting or a task is ready | `src/push.ts`, `web/public/` |

Planned work is under [Where it is going](#where-it-is-going).

## Where it is going

Planned, not in this code.

Botbench is two things meant to work as one product. Much of the first exists today ([What works today](#what-works-today)); most of the second is ahead. **The workbench** is one place to bring your agents, subscriptions, models, tools, context and memory together, and to run them within your own policies. **The coordination layer** connects separately owned workbenches, so that your agents and a colleague's can coordinate who does what, exchange context each owner chose to share, manage what depends on what, and finish work together, with the people watching and steering instead of relaying every message. Each person keeps their own agents, environments and permissions. A message from another workbench will never be permission to run anything.

Coding is where this starts. It is not meant to be where it ends.

What is being built next, each with its issue:

- **Workbenches that talk directly** (Peers P5, [#154](https://github.com/jon-lange/botbench/issues/154)): paired workbenches send each other typed messages. The decision record and threat review are written, in [ADR 0004](docs/adr/0004-peers-direct-messages.md); the first part is being built on a branch and none of it is in this code yet. How much of that a person must approve is an open question, set out in [`docs/product/peers-autonomy-tradeoff.md`](docs/product/peers-autonomy-tradeoff.md).
- **Work that depends on a teammate's work**, including two changes to different files that must meet one shared contract ([#172](https://github.com/jon-lange/botbench/issues/172)).
- **One container per task** ([#72](https://github.com/jon-lange/botbench/issues/72)).
- **A shorter first run** ([#174](https://github.com/jon-lange/botbench/issues/174)).

The order and the reasons are in [the plan](docs/plans/2026-11-21-2234-feat-botbench-software-factory-plan.md). The direction is in [`docs/product/positioning-concept.md`](docs/product/positioning-concept.md), and how Botbench compares with other projects, from a read of their source, is in [`docs/competitive/`](docs/competitive/README.md).

## How a piece of work goes

1. You start a **task** (a prompt and a repository) or a **run** (a prompt or a spec file, which Claude Code turns into a plan of tasks; in a manual run, and in any run started from a GitHub issue, nothing is built before you approve the plan).
2. Each task is built in a separate copy of your repository (a git worktree) on its own branch, `botbench/<workbench>/run-<n>/task-<n>`.
3. Using a tool never asks, in any mode: the agent reads, searches and edits inside its copy, and a shell command that runs inside the sandbox goes without asking. An action or change that reaches outside the copy waits for your answer: a short list of dangerous commands (a push, sudo, deleting or writing outside the copy), a file outside the copy, or a command that could not be kept inside the sandbox. A fully autonomous run refuses these instead. Web search and fetch follow your Web access setting (Allow by default). If you would rather be asked before every command, turn on Ask before every command in Settings; commands you allowed in advance or chose Always allow for still go without asking then.
4. Botbench commits the work and runs the checks you set for the repository. If you chose a reviewer (Codex, Grok or Antigravity), it reads the change; with concerns, the builder gets the review and makes a round of fixes, up to the run's limit, and the checks and the review run again.
5. You read the diff, the checks and the transcript, then Accept (the branch is kept, and opened as a pull request if the run says so) or Reject (you choose whether to keep the branch). A fully autonomous run accepts a task without you only when at least one check ran and every check passed, the reviewer (if there is one) said it looks right and named what it checked, nothing was refused that is on the always-ask list or would have reached outside the task's copy, and every changed file was expected from the plan and none is under a protected path. Otherwise it waits for you and says why.

## Questions you may have

### Is it a sandbox?

Partly, and not a hard one. Commands an agent runs are confined by the macOS sandbox: they cannot read your sign-ins, keys or Keychain, reach no network except hosts you allow for that repository, and can write only in the task's copy and a temporary folder. It is not a virtual machine or a container. Claude Code itself runs outside it with your rights. Your repository's setup and check commands, which run the code the agent wrote, can still read your home folder outside the protected places. A test server those commands start on all network addresses, rather than only on 127.0.0.1, can be reached from other machines on your network while it runs, as macOS's sandbox cannot tell the two apart; the macOS firewall blocks that. Point Botbench only at repositories you trust. The exact limits are in the [threat model](docs/security/threat-model.md#confined-commands-u27).

### Does my code leave my Mac?

Yes, as it does when you use the agents directly: Claude Code, Codex, Grok and Antigravity send your prompts and the code they read to their providers (Anthropic, OpenAI, xAI and Google). Botbench does not change that, and sends nothing else unless you chose it. The full list is in [What leaves your Mac](#what-leaves-your-mac).

### May I use my subscription this way?

That is the vendor's decision, not Botbench's. Botbench runs each vendor's own, unmodified program under your own sign-in; it never reads or stores your credentials and does not use API keys. Check your subscription's terms on running it while you are away before relying on it.

### Why not use Claude Code directly?

You can, and Botbench never takes a tool away from it. What Botbench adds around it: a separate copy and branch for each task, approvals you can answer from your phone, your checks run and kept, a review by another vendor's agent, a record of everything that ran, and a view of what your teammates' workbenches are doing.

### Is anyone using it?

Its author, on this repository. Where it can, Botbench is built with Botbench, under the same rules and tests as any other change; see [Proof, not promises](#proof-not-promises).

## Configure a repository

Your settings go in `botbench.local.json` in the `botbench` folder (git ignores it), keyed by the repository's full path. Restart Botbench after changing it. A wrong setting stops the start with a message that names the file and the setting.

```json
{
  "repositories": {
    "/Users/you/code/my-app": {
      "setup": ["npm ci"],
      "checks": ["npm run typecheck", { "command": "npm test", "timeoutSeconds": 900 }],
      "preapproved": ["npm test", "npm run typecheck"],
      "allowedHosts": ["registry.npmjs.org"]
    }
  }
}
```

- `setup` runs in each new copy before the agent starts; a command that fails ends the task.
- `checks` run after the work is committed; the task shows "Checks passed" or "Checks failed". Each has a 10-minute limit unless you give `timeoutSeconds`.
- `preapproved` are commands a task may run without asking. They are offered when you start a task or run, and you confirm or edit them there.
- `allowedHosts` are the only host names the repository's commands may reach. Without it, no network.
- `execution` says where the repository's commands run: `{ "kind": "host" }` (the default) on your Mac, kept away from your sign-ins and the network, or `{ "kind": "container", "image": "node:24" }` in one Docker container per task, from an image already on your Mac (Botbench never pulls one), holding only the task's copy and no network. Claude Code stays on your Mac; each command it runs, and the setup and check commands, go into the container. When Docker or the image is not there the task does not start; nothing runs on your Mac instead. A container cannot be combined with `allowedHosts`. See [ADR 0009](docs/adr/0009-container-execution.md).

The defaults are in [`botbench.config.json`](botbench.config.json). Every setting, including models per agent and your own additions to the always-ask list, is described in [`src/config.ts`](src/config.ts).

## Use it from your phone

Botbench listens on `127.0.0.1` only. To reach it from your phone, use a private network that gives the Mac an HTTPS name; Tailscale is one. This was not part of the tested quickstart.

1. Put the Mac and the phone on the same private network and turn on HTTPS names.
2. Add the Mac's name to `botbench.local.json` and restart: `{ "publicHosts": ["my-mac.example.ts.net"] }`
3. On the Mac: `tailscale serve --bg 4780`
4. On the phone, open `https://my-mac.example.ts.net` and sign in with the login token.

Do not put Botbench on the public internet. Its sign-in is one token, made for a private network.

## What leaves your Mac

- What each agent sends its provider: your prompts and the code it reads, as when you use it directly.
- If you turn on notifications for a device: a short encrypted notice, through Apple's or Google's push service, that an approval is waiting or a task is ready. Never a command, code or a file name.
- What a repository's commands send to the hosts you allowed for it in `allowedHosts` (none unless you set some). A run started from a GitHub issue reaches none of them unless you allow them for that run.
- If you start a run from a GitHub issue: your own `gh` asks GitHub for that one issue. It only reads; Botbench posts nothing back (no comment, label or close). A pull request it opens for such a run says "Closes #N".
- If you chose pull requests for a run: your own `git` pushes the accepted task's branch (never the default branch, never by force) and your own `gh` opens the pull request.
- If you chose pull requests for a run started from an issue, and turned on `claimIssues` for its repository: when the run starts, your own `git` pushes one empty commit to two branches, `botbench/claims/issue-<number>` and `botbench/<workbench>/run-<N>/issue-<number>-at-<time>`, and deletes them if the run ends without a pull request. Nothing is pushed for a run that keeps its work on your Mac.
- If the repository has a GitHub remote: your own `gh` and `git` read the other workbenches' open pull requests and pushed branches. Nothing is written.
- Every 6 hours, one request to `api.github.com` asking for Botbench's latest release, with nothing about you in it (`BOTBENCH_UPDATES=off` turns it off). When you update, from Settings or automatically if you chose that, your Mac fetches that release's commit from github.com.
- If you use it from your phone: the traffic between phone and Mac, over the private network you chose.
- Nothing else from Botbench itself. Plans, transcripts, diffs, check results, approvals and the append-only action log stay in a database in `~/.botbench`.

## Where to go next

| I want to | Go to |
|---|---|
| Know exactly what is protected and what is not | [`docs/security/threat-model.md`](docs/security/threat-model.md) |
| Know why it drives the vendors' programs, and how secrets are kept from agents | [`docs/adr/`](docs/adr/) |
| Add another agent | [`CONTRIBUTING.md`, Adding an agent](CONTRIBUTING.md#adding-an-agent) |
| Contribute a fix, run the tests | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Report a bug | [GitHub issues](https://github.com/jon-lange/botbench/issues), with what you did, what you expected and what Botbench printed |
| Report a security problem | Not in an issue. See [`CONTRIBUTING.md`, Reporting a security problem](CONTRIBUTING.md#reporting-a-security-problem) |
| See what is planned, and why | [The plan](docs/plans/2026-11-21-2234-feat-botbench-software-factory-plan.md) |

## Licence

Apache License 2.0: [`LICENSE`](LICENSE). Files copied from other projects, and what the built screens bundle, are listed in [`NOTICE`](NOTICE).
