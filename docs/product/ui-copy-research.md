# UI copy research for Botbench: how leading AI products label and show agent work

Research date: 2026-11-22. Scope: wording only. No repository was read or changed, so the Botbench concepts below are taken from the brief, not from Botbench's code.

## How to read this dossier

Three evidence grades are used throughout.

- **[V]** Verified: read on an official page (or official open-source source file) today. Most pages were read through a fetch tool that extracts quotes with a small model, so a quote may be trimmed. Pages I read as raw Markdown myself are marked **[V-raw]**.
- **[R]** Recalled, not verified today. Do not treat as evidence.
- **[N]** Looked for and not found in the official pages read.

Product names have moved in 2026. Three changes matter for wording:

- OpenAI's Codex docs now redirect from `developers.openai.com/codex/*` to `learn.chatgpt.com/docs/*`. The Codex app is the "ChatGPT desktop app" with a Chat/Work toggle, and the help page for ChatGPT agent says it "is no longer available" (https://help.openai.com/en/articles/11752874-chatgpt-agent).
- GitHub's "Copilot coding agent" docs are now "Copilot cloud agent".
- Cursor: "Cloud Agents were formerly called Background Agents." (https://cursor.com/docs/cloud-agent). Gemini CLI's docs say it was replaced by Antigravity CLI on 18 June 2026 (https://geminicli.com/docs/cli/plan-mode/).

Below, `L/` stands for `https://learn.chatgpt.com/docs/` and `TUI/` for `https://github.com/openai/codex/blob/main/codex-rs/tui/src/` (Codex CLI source strings).

---

## 1. What the conversation screen and one exchange are called

| Product | Words on screen | Source |
|---|---|---|
| claude.ai | "Start chatting with Claude or open an existing chat."; "new chat"; "conversation" for the running exchange | [V] https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings |
| Claude Cowork | "Start a Cowork session"; "Describe the task you want Claude to complete."; the message box has "Cowork" and "Chat" choices | [V] https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork |
| Claude Code desktop | "In the Code tab, each conversation is a **session**"; "+ New"; shortcut "New session"; "prompt box"; "stop button" | [V] https://code.claude.com/docs/en/desktop |
| Claude Code web | "cloud session"; "Sessions appear in the sidebar"; the input is the "message box"; a queued message can be taken back with ✕ | [V-raw] https://code.claude.com/docs/en/claude-code-on-the-web |
| Claude Code terminal | "Resume previous conversations"; "session picker"; Esc or Ctrl+C to interrupt | [V-raw] https://code.claude.com/docs/en/common-workflows, https://code.claude.com/docs/en/interactive-mode |
| ChatGPT / Codex | Glossary: Chat is "A saved space for exchanging messages with ChatGPT or Codex"; Task is "A defined outcome ChatGPT or Codex works toward"; Turn is "One exchange in a chat"; Thread is "A technical object in Codex app-server APIs". "In Codex, start with New chat." | [V] L/glossary.md, L/app.md |
| Codex CLI | Placeholder "Ask Codex to do anything"; "Working (0s • esc to interrupt)" | [V] TUI/bottom_pane/chat_composer.rs, TUI/status_indicator_widget.rs |
| VS Code Copilot | "New Chat"; "chat session"; "Send", which becomes "Add to Queue", "Steer with Message", "Stop and Send" while running | [V] https://code.visualstudio.com/docs/agents/run/chat-view, https://code.visualstudio.com/docs/copilot/chat/copilot-chat |
| GitHub.com | "Agents" tab; "Task" button; "A session is the conversation and activity associated with agentic work" | [V] https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent |
| Cursor | "conversation", "chat"; "Press Enter to queue your message"; "Stop" | [V] https://cursor.com/docs/agent/overview, https://cursor.com/docs/agent/review |
| Gemini app | "To start a new chat, at the top left, click New chat"; send control "Submit" | [V] https://support.google.com/gemini/answer/13275745 |
| Jules | "task"; "new task"; "chat box" | [V] https://jules.google/docs/ |
| Antigravity | "conversation"; "message box" (app), "prompt box" (CLI) | [V] https://antigravity.google/docs/features/ |
| Grok | Heading "What's on the agenda today?" | [V] https://grok.com/ |
| OpenHands | "New Conversation", "Recent Conversations" | [V] https://docs.openhands.dev/openhands/usage/cloud/cloud-ui.md |
| Conductor | "New workspace"; "Each task gets its own workspace, branch, files, terminal, diff, and review path." | [V] https://www.conductor.build/docs/ |

Finding: consumer products say **chat** and **New chat**. Coding tools say **session** (Claude Code, GitHub) or **task** (Jules, Codex, GitHub.com). No product shows "Turn" to end users; OpenAI lists it only as a glossary term for one exchange.

Not verified: composer placeholders for claude.ai, ChatGPT ("Ask anything" [R]), Gemini ("Ask Gemini" [R]), Grok ("What do you want to know?" [R]), Cursor ("Plan, search, build anything" [R]).

## 2. Showing work in progress, and what "finished" looks like

- claude.ai: a "Thinking" indicator with a timer, then an "expandable "Thinking" section above Claude's response." [V] https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings
- Claude Code terminal: a spinner line such as "Deciphering… (10m 27s · ↓ 5.5k tokens)". [V-raw] https://code.claude.com/docs/en/costs
- Codex CLI: header "Working", replaced by a live summary; after the turn a separator "Worked for {elapsed}". [V] TUI/status_indicator_widget.rs, TUI/history_cell/separators.rs
- VS Code: finished steps fold into "Completed N steps". [V] https://code.visualstudio.com/docs/copilot/chat/copilot-chat
- Copilot CLI: status "Thinking". [V] https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli
- GitHub.com: "Copilot has started work"; on finish it adds you as a reviewer. [V] https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github
- Cowork: "Progress indicators" show each step. [V] Cowork article above
- OpenHands: "Thinking" between agent steps. [V] https://docs.openhands.dev/openhands/usage/agent-canvas/conversations.md

Finding: no product read prints a "turn completed" line. The reply ending is the signal. The two markers that exist are quiet summaries of elapsed work: Codex's "Worked for 2m 14s" and VS Code's "Completed N steps".

## 3. How tool use is shown, and why it matters

### Labels

| Product | Command | File read / search | File edit | Web | Other | Source |
|---|---|---|---|---|---|---|
| Codex CLI | "Running" / "Ran" | "Exploring" / "Explored" with sub-lines "Read", "List", "Search" | "Edited {file}" / "Edited files" | "Searching the web" / "Searched the web" | "Calling" / "Called"; "Proposed Plan", "Updated Plan" | [V] TUI/exec_cell/render.rs, TUI/history_cell/patches.rs, search.rs, mcp.rs, plans.rs |
| Claude Code terminal | — | — | — | — | Repeated calls collapse to one line such as `Called slack 3 times` | [V-raw] https://code.claude.com/docs/en/interactive-mode |
| Cursor | Doc headings only: "Run shell commands", "Read files", "Edit files", "Search files and folders", "Web" | | | | Transcript labels [N] | [V] https://cursor.com/docs/agent/overview |

Pattern worth copying from Codex: every label is a present/past pair of a plain verb, and reads are grouped under one "Explored" row.

Not verified: Claude Code's exact transcript labels for reads and edits, claude.ai's web-search label, and ChatGPT web/desktop transcript labels.

### Collapsed by default, with a way in

- Claude Code desktop has three transcript views. Normal: "Tool calls collapsed into summaries, with full text responses". Thinking: the same "plus Claude's thinking". Verbose: "Every tool call, file read, and intermediate step Claude takes, plus Claude's thinking". Opened as "Transcript view" or Ctrl+O. [V] https://code.claude.com/docs/en/desktop
- Claude Code terminal: Ctrl+O "Shows detailed tool usage and execution, with a timestamp and the model used on each assistant message. Also expands lines that collapse by default". [V-raw] https://code.claude.com/docs/en/interactive-mode
- VS Code: "Expand a call to inspect its inputs and output."; view modes "Compact", "Verbose", "Conversation"; before approving you can "expand the tool details, change the parameters, and select **Allow**." Raw inputs are therefore one tap away, not on the surface. [V] https://code.visualstudio.com/docs/copilot/agents/agent-tools
- Antigravity: "By default, the details in each subtask are collapsed"; "use the toggle to expand the exact steps that the agent took." [V] https://antigravity.google/docs/tools/
- Grok Build: `/density` to "Set how much of each tool call the transcript shows": Detailed, Diff focus, Balanced, Grouped, Compact. [V] https://docs.x.ai/build/modes-and-commands
- Devin CLI: default "compact one-line tool summaries"; Ctrl+O opens a "full-screen viewer for the thinking trace and full tool cards". [V] https://docs.devin.ai/cli/reference/keyboard-shortcuts.md
- GitHub cloud agent: "Session logs show Copilot's internal reasoning and the tools it used"; "Each commit message includes a link to the session logs". [V] https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/track-copilot-sessions
- Gemini CLI: `ui.compactToolOutput`, and "(press <key> to expand MCP tool details)". [V] https://geminicli.com/docs/reference/configuration/

Every product read keeps tool activity in the transcript. All of them summarise it by default and expand on request. None hides it.

### Thinking

Labelled "Thinking" (claude.ai, Copilot CLI, OpenHands), "collapsed reasoning" (VS Code), "reasoning summaries" (Codex config). Always collapsed or optional.

### Why showing agent actions matters

Anthropic:
- "Prioritize transparency by explicitly showing the agent's planning steps." [V] https://www.anthropic.com/engineering/building-effective-agents
- "Humans need visibility into agents' problem-solving processes." and "The challenge is in finding the right level of detail." and "Too little information leaves humans unable to assess whether the agent is on track to achieve its goal." [V] https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents
- "Being able to observe the way Claude thinks makes it easier to understand and check its answers." [V] https://www.anthropic.com/news/visible-extended-thinking

OpenAI:
- "Most importantly, you're always in control." and "an on-screen narration provides visibility into exactly what ChatGPT is doing." [V] https://openai.com/index/introducing-chatgpt-agent/
- Codex "provides verifiable evidence of its actions through citations of terminal logs and test outputs" [V, fragment; the fetch of this page returned some unrelated text, so re-check before quoting] https://openai.com/index/introducing-codex/
- "Inspect the visible steps, sources, tool actions, and results... Fluent writing or a confident summary is not enough to establish that a task succeeded." [V] L/working-with-agents.md

Google:
- "Delegating work to an agent requires trust, but scrolling through raw tool calls is tedious." Heading: "Verify with Artifacts, not logs." [V] https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/
- PAIR: "Users shouldn't implicitly trust your AI system in all circumstances, but rather calibrate their trust correctly." and "The best explanation is likely a partial one." [V] https://pair.withgoogle.com/chapter/explainability-trust/

GitHub: "Logs do not replace your own review and testing." [V] https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent

Microsoft HAX: G11 "Make clear why the system did what it did" — "Enable the user to access an explanation of why the AI system behaved as it did." [V] https://www.microsoft.com/en-us/haxtoolkit/library/

Nielsen Norman Group:
- "People strive for predictability and control, and, in most cases, more information translates to better decision making." [V] https://www.nngroup.com/articles/visibility-system-status/
- Progressive disclosure: "Initially, show users only a few of the most important options." and "Offer a larger set of specialized options upon request." [V] https://www.nngroup.com/articles/progressive-disclosure/
- "For AI agents to gain traction, users must be able to understand, guide, and trust them – capability alone is not enough." [V] https://www.nngroup.com/articles/designing-ai-agents/

Counter-evidence, which argues against dumping everything: NN/g reports that step-by-step explanations "are often unfaithful to the model's actual computation" and that "people rarely click citation links." [V] https://www.nngroup.com/articles/explainable-ai/. Anthropic adds the same caveat about thinking: "we don't know for certain that what's in the thought process truly represents what's going on in the model's mind." This supports showing **actions** (what was run, read and changed) prominently and treating **reasoning** as optional.

## 4. Permission and approval prompts

### Claude Code

- Prompt (from the docs' screenshot description): title "Bash command", the line "This command requires approval", the question "Do you want to proceed?", and options "Yes"; "Yes, and don't ask again for: npm test \*"; "Yes, and switch to auto mode"; "No". Footer: "Esc to cancel" and "Tab to amend". [V-raw] https://code.claude.com/docs/en/permissions
- Scope of "don't ask again": Bash commands "Permanently per repository and command"; file edits "Until session end"; web fetch "Permanently per repository and domain". [V-raw] same page
- Remembered rules live under `/permissions`: "The dialog lists all permission rules". Rule types are Allow, Ask, Deny. [V-raw] same page
- Mode names: desktop "Manual", "Accept edits", "Plan", "Auto", "Bypass permissions". The docs note "Earlier versions of the Code tab labeled these modes Ask permissions, Auto accept edits, and Plan mode." [V] https://code.claude.com/docs/en/desktop, https://code.claude.com/docs/en/permission-modes
- Plan approval: "Yes, and use auto mode"; "Yes, manually approve edits"; "No, keep planning". [V] https://code.claude.com/docs/en/permission-modes
- The older "No, and tell Claude what to do differently" wording is [R]; the current docs show "No" plus "Tab to amend".

### Claude Cowork

"Allow once" and "Always allow"; "choose Allow or Deny"; connector settings "Always ask" and "Needs approval"; "Allow for all scheduled runs". Modes "Manual" (formerly "Ask before acting"), "Auto", "Skip" (formerly "Act without asking"). [V] https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork

### OpenAI Codex / ChatGPT Work

- CLI titles: "Would you like to run the following command?", "Would you like to make the following edits?" [V] TUI/bottom_pane/approval_overlay.rs
- CLI options: "Yes, proceed"; "Yes, just this once"; "Yes, and don't ask again for commands that start with `{prefix}`"; "Yes, and don't ask again for this command in this session"; "Yes, and don't ask again for these files"; "No, continue without running it"; "No, and tell Codex what to do differently". Network: "Yes, and allow this host for this conversation"; "Yes, and allow this host in the future". [V] same file
- App modes: "Ask for approval", "Approve for me", "Full access", set from "the permissions control below the composer". [V] L/permission-modes.md
- Remembered commands are "Rules". Advice: "choose the narrowest scope that lets the task continue". [V] L/agent-configuration/rules.md, L/sandboxing.md
- Browser prompts: "Allow once", "Allow for this site", "Allow for all sites", "Decline". Connector tool calls: "Accept", "Decline", "Cancel". [V] L/llms-full.txt

### GitHub Copilot

- VS Code buttons: "Allow Once", "Skip", "In this Session", "Always Allow". Levels: "Manual permissions", "Assisted permissions", "Allow all". Management commands: "Chat: Manage Tool Approval", "Chat: Reset Tool Confirmations". [V] https://code.visualstudio.com/docs/agents/run/approvals
- CLI: "1. Yes / 2. Yes, and approve TOOL for the rest of the running session / 3. No, and tell Copilot what to do differently (Esc)". Folder trust: "Yes, and remember this folder for future sessions". [V] https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli, https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli

### Cursor

Run Modes "Auto-review", "Allowlist", "Run Everything", under "Settings > Agents > Approvals & Execution"; "Click **Allow** to let the read through."; CLI "approve (y) or reject (n)". [V] https://cursor.com/docs/agent/security/run-modes, https://cursor.com/docs/cli/using. "Run", "Skip" and "Add to allowlist" are [R].

### Google, xAI, others

- Gemini CLI: "Allow once", "Allow for this session", "Allow for all future sessions", "Allow this command for all future sessions", "No, suggest changes (esc)". Folder trust: "Trust folder", "Trust parent folder", "Don't trust". [V] https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx, https://geminicli.com/docs/cli/trusted-folders/
- Antigravity: presets "Request Review", "Default", "Auto", "Turbo"; rule lists Deny / Ask / Allow; "Allow list" / "Deny list"; plan button "Proceed". [V] https://antigravity.google/docs/agent-settings/, https://antigravity.google/docs/permissions/
- Grok Build: prompt rows `allow_once`, `allow_command_always`, `always_allow_all_sessions`, `reject`. [V] https://docs.x.ai/build/settings/reference
- Jules: "approve plan". [V] https://jules.google/docs/review-plan/
- OpenHands CLI: "Always ask for confirmation"; `--always-approve`. [V] https://docs.openhands.dev/openhands/usage/cli/terminal.md

### What the prompts have in common

1. The positive verb is **Allow** nearly everywhere outside the two terminal tools that use Yes/No.
2. Remembering is always phrased as a scope the person can read: "once", "for this session", "for this site", "for commands that start with …", "in the future".
3. The place that lists remembered choices is called **Permissions** (Claude Code, Codex, VS Code), **Rules** (Codex), **Approvals** (VS Code, Cursor) or an **Allowlist** (Cursor, Antigravity). "Trust" is used only for trusting a **folder** (Gemini CLI, Copilot CLI), never for the list of granted permissions.
4. The word for "trust" matters less than prompt volume. Anthropic: "in practice users accept 93% of them anyway" and that leads to "approval fatigue, where people stop paying close attention to what they're approving." [V] https://www.anthropic.com/engineering/claude-code-auto-mode. NN/g: "Do not use confirmation dialogs for routine actions." [V] https://www.nngroup.com/articles/confirmation-dialog/

## 5. Naming and choosing the model

- claude.ai: the "model menu next to the send button"; names shown as "Claude Fable 5.2, Haiku 5.5, Sonnet 5.5, Opus 5.5"; the recommended effort is marked "Default"; effort labels "Low", "Medium", "High", "Extra high", "Max". [V] https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings
- Claude Code: "model picker"; aliases `sonnet`, `opus`, `haiku`; prose uses "Opus 5.5" while ids such as `claude-opus-5-5` appear only in commands and config. "`/model` saves your choice as the default for new sessions". [V] https://code.claude.com/docs/en/model-config
- ChatGPT: "model menu"; options Instant ("Fast responses for everyday questions"), Medium, High, Extra High, Pro; "GPT-6 is rolling out as the current default in Chat". Work/Codex: a "Power slider" from "Faster" to "Smarter"; display format "GPT-6.2 Sol · Medium". [V] https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt, L/models.md, L/model-selection.md
- VS Code: "Language model" picker with "Auto". [V] https://code.visualstudio.com/docs/copilot/customization/language-models
- Cursor: "Auto"; names like "Claude 4.6 Opus". [V] https://cursor.com/docs/models
- Gemini CLI: "Auto (Gemini 3)" — "Let the system choose the best Gemini 3 model for your task."; "Manual". [V] https://geminicli.com/docs/cli/model/
- Antigravity: picker header "Model"; "Gemini 4 Neon", "Claude Opus 5.5 (Thinking)"; "default model for new conversations". [V] https://antigravity.google/docs/models/

Finding: every product shows a friendly name, often joined to an effort level with a middle dot. API ids appear only in config and CLI flags. The default is either marked "Default" or offered as "Auto".

## 6. Usage

- claude.ai: "Settings > Usage" shows usage, time left in the "Current session", and the next reset; "a session limit that resets every five hours"; "weekly limit"; "usage credits". [V] https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits
- Claude Code: `/usage` shows "plan usage bars" for subscribers; the docs say of the dollar figure that "the session cost figure isn't relevant for billing purposes" for subscribers. Inline there is only the live count beside the spinner and a context percentage in the "Context" card. Limit messages: "You've hit your session limit", "You've hit your weekly limit". [V-raw] https://code.claude.com/docs/en/costs; [V] https://code.claude.com/docs/en/desktop
- Codex: "usage dashboard"; "5-hour and weekly Codex usage windows"; "Credits"; inline CLI footer "100% context left"; `/status`. [V] L/pricing.md, TUI/bottom_pane/footer.rs
- GitHub: "premium requests", and in the CLI "AI credits"; session overview shows "token usage, and session length". [V] https://docs.github.com/en/copilot/concepts/billing/copilot-requests
- Cursor: "Included usage"; "Your remaining usage and next reset date are shown in your editor settings." [V] https://cursor.com/docs/account/pricing
- Gemini: Settings > "Usage Limits"; "Your limit refreshes every 5 hours until you reach your weekly limit." [V] https://support.google.com/gemini/answer/16275805
- Devin: Settings > "Usage & limits"; "Agent Compute Units (ACUs)". [V] https://docs.devin.ai/admin/billing/usage.md
- Grok Build: "/usage shows your credit usage." [V] https://docs.x.ai/build/overview

Finding: no consumer chat prints token counts per message. Tokens appear in terminal tools, in an on-demand command, or in a detail view. What people see is "usage", "limit", "resets", shown as bars on a page called **Usage**, plus an optional context percentage.

## 7. Code changes and isolated copies

Naming changes:
- Claude Code: the "**Changes** card" with line counts such as `+42 -18`; "diff view"; "Review changes"; "Create PR". [V-raw] https://code.claude.com/docs/en/claude-code-on-the-web
- Codex: "review pane"; scopes "Unstaged", "Staged", "Commit", "Branch", "Last turn"; glossary Diff: "Set of Git file changes shown for inspection, comments, staging, or reverting." [V] L/code-review, L/glossary.md
- VS Code: "Keep" / "Undo"; "Changes" pill. [V] https://code.visualstudio.com/docs/copilot/chat/chat-checkpoints
- Jules: "Publish branch", "Publish PR"; "Files changed". [V] https://jules.google/docs/code/
- Antigravity: "Review" pane; "Changes"; "Agent Edits". [V] https://antigravity.google/docs/review-changes/
- Conductor: "Review", "Create PR", "Merge", "Archive"; "Diff Viewer". [V] https://www.conductor.build/docs/guides/review-and-merge

Explaining an isolated copy in plain words:
- Codex: "A worktree allows you to create a second copy ("checkout") of your repository." and "You can think of Local as the foreground and Worktree as the background." The choices are "**Local**: work directly in your current project directory. **Worktree**: isolate changes in a Git worktree. **Cloud**: run a remote task in its own workspace." [V] L/environments/git-worktrees, L/environments/modes.md
- Claude Code: "Each git worktree is a separate checkout on its own branch"; "so parallel sessions can read the same checkout but each writes to its own." The desktop toggle is labelled "Worktree". [V-raw] https://code.claude.com/docs/en/common-workflows; [V] https://code.claude.com/docs/en/agent-view, https://code.claude.com/docs/en/desktop
- Conductor: "An isolated workspace is a separate, git-backed copy of a project for one stream of work." and "Workspace isolation is development isolation, not a security boundary." [V] https://www.conductor.build/docs/concepts/workspaces-and-branches
- VS Code: "A Git worktree keeps code changes separate, but isn't a security boundary." [V] https://code.visualstudio.com/docs/copilot/agents/overview
- Cloud variants: Claude "isolated, Anthropic-managed VM"; Jules "Each task runs in a fresh virtual machine"; Cursor "isolated VMs in the cloud"; GitHub "its own ephemeral development environment".

Finding: "Changes" is the heading, "diff" is the view, "pull request"/"PR" and "branch" are used unexplained. "Worktree" is kept as a label by Claude Code, Codex and VS Code, but each explains it as a separate copy of the project.

## 8. Status words

| Product | Statuses | Source |
|---|---|---|
| Claude Code agent view | "Working", "Needs input", "Idle", "Completed", "Failed", "Stopped"; groups "Ready for review", "Needs input", "Working", "Completed" | [V] https://code.claude.com/docs/en/agent-view |
| ChatGPT / Codex | "**Running** – A chat is actively working. **Needs input** – A chat needs your approval, answer, or another decision. **Ready** – A chat has completed and has unread activity. **Blocked** – A chat failed or encountered a system error." | [V] L/pets.md |
| GitHub | "queued", "working", "waiting for review", "completed"; also "in progress", "failed", "idle waiting for user", "timed out", "cancelled" | [V] https://github.blog/changelog/2026-03-26-agent-activity-in-github-issues-and-projects/, https://github.blog/changelog/2026-03-05-discover-and-manage-agent-activity-with-new-session-filters/ |
| Jules (API) | QUEUED, PLANNING, AWAITING_PLAN_APPROVAL, AWAITING_USER_FEEDBACK, IN_PROGRESS, PAUSED, FAILED, COMPLETED | [V] https://jules.google/docs/api/reference/sessions/ |
| Grok Build | "Needs input", "Working", "Idle", "Inactive", "Completed", "Failed" | [V] https://docs.x.ai/build/features/dashboard |
| Conductor | "backlog, in progress, in review, and done" | [V] https://www.conductor.build/changelog/0.35.0-workspace-status |
| Devin (API) | working, blocked, finished, expired | [V] https://docs.devin.ai/api-reference/v1/sessions/retrieve-details-about-an-existing-session |
| Devin Review | "Needs your attention", "Ready to merge" | [V] https://docs.devin.ai/work-with-devin/devin-review |

Finding: three products (Claude Code, Codex, Grok Build) independently settled on **Working** and **Needs input**. "Completed" and "Failed" are near-universal. "Blocked" is ambiguous: Codex uses it for failure, Devin for waiting on the person.

## 9. Planning, review, and the name of a job

- Planning is "Plan" or "Plan mode" in every product read: Claude Code, Codex (`/plan`, "Plan mode"), Cursor (modes "Agent", "Ask", "Plan", "Debug"), VS Code ("Plan agent"; buttons "Start Implementation", "Implement Plan", "Approve Plan Only"), Gemini CLI, Antigravity ("Implementation Plan", "Proceed"), Grok Build, Jules ("Give me a plan"), Devin, Conductor ("Plan Mode"). Sources as in sections 4 and 8, plus https://code.visualstudio.com/docs/copilot/agents/planning and https://cursor.com/docs/agent/modes.
- Review is "Code review" (Claude Code card titled "Code review" with "Apply fixes"; Copilot code review), `/review` (Codex), "Bugbot" (Cursor), "Devin Review", "Critic" (OpenHands: "an additional evaluation pass that reviews the agent's work").
- There is no shared word for the implementing step. Cursor calls the mode "Agent"; VS Code's buttons say "Implement".
- The job: "task" (Jules, Codex glossary, GitHub.com, Cowork, Conductor), "session" (Claude Code, GitHub, Devin), "conversation" (OpenHands, Antigravity), "workspace" (Conductor). "Run" appears only in APIs (Cursor) and for scheduled work.
- Helpers are "subagents" everywhere (Claude Code, Codex, Antigravity, Grok Build).

## 10. Content-design guidance

Buttons and confirmations:
- Apple: "Aim for a one- or two-word title that describes the result of selecting the button."; "A specific button title like "Erase," "Convert," "Clear," or "Delete" helps people understand the action they're taking."; "Use alerts sparingly." [V] https://developer.apple.com/tutorials/data/design/human-interface-guidelines/alerts.json (data source for https://developer.apple.com/design/human-interface-guidelines/alerts)
- NN/g: "Instead of Yes/No answers, provide response options that summarize what will happen for each possible response."; "Be specific and inform users about the consequence of their action." [V] https://www.nngroup.com/articles/confirmation-dialog/
- Polaris: "Lead with a strong, actionable verb."; "Destructive buttons should trigger a confirmation dialog before the action is completed." [V] https://unpkg.com/@shopify/polaris@9.14.0/src/components/Button/README.md
- GOV.UK: "Write button text in sentence case, describing the action it performs."; "Only use warning buttons for actions with serious destructive consequences that cannot be easily undone by a user." [V] https://design-system.service.gov.uk/components/button/
- Atlassian warnings: "Inform, but don't alarm."; "You should also inform them whether any actions they take can be easily undone." [V] https://atlassian.design/foundations/content/designing-messages/warning-messages
- Apple on AI: "Generally, ask for confirmation before performing a significant action on someone's behalf." [V] https://developer.apple.com/tutorials/data/design/human-interface-guidelines/generative-ai.json
- OpenAI: "Actions that are sensitive, irreversible, or have high stakes should trigger human oversight until confidence in the agent's reliability grows." [V] https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf

Permission requests:
- Apple: "Write copy that clearly describes how your app uses the ability, data, or resource you're requesting."; "Aim for a brief, complete sentence that's straightforward, specific, and easy to understand." [V] https://developer.apple.com/tutorials/data/design/human-interface-guidelines/privacy.json

Errors:
- GOV.UK: "Describe what has happened and tell them how to fix it." [V] https://design-system.service.gov.uk/components/error-message/
- Atlassian: "Avoid putting technical information in the message or having people look in another location." [V] https://atlassian.design/foundations/content/designing-messages/error-messages
- Apple: "avoid blame, and be clear about what someone can do to fix it." [V] https://developer.apple.com/tutorials/data/design/human-interface-guidelines/writing.json
- Microsoft: describe the problem "in terms of target user actions or goals, not in terms of what the code is unhappy with." [V] https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-error

Status labels:
- GOV.UK: "If you are creating your own statuses, use adjectives rather than verbs."; "The more you add, the harder it is for users to remember them."; statuses in sentence case. [V] https://design-system.service.gov.uk/patterns/complete-multiple-tasks/
- Atlassian: "Don't use color alone to signify an important attribute." [V] https://atlassian.design/components/lozenge/usage

Vocabulary:
- NN/g: "Use words, phrases, and concepts familiar to the user, rather than internal jargon."; "Users should not have to wonder whether different words, situations, or actions mean the same thing."; "Jakob's Law states that people spend most of their time using digital products other than yours." [V] https://www.nngroup.com/articles/ten-usability-heuristics/
- NN/g on agents: "When agents reuse established UI conventions, users can focus on decisions rather than mechanics." [V] https://www.nngroup.com/articles/designing-ai-agents/
- Apple: "Create a list of common terms, and reference that list to keep your language consistent." [V] writing.json above

No public voice-and-tone or UI-writing guide from Anthropic was found. OpenAI's was not searched for. Material Design's dialog pages are JavaScript-rendered and could not be read.

---

## A. Recommended glossary for Botbench

| Botbench concept | Recommended | Alternative | Who uses it | Why |
|---|---|---|---|---|
| Screen "Turn" | **Chat**, with a **New chat** button | Session | claude.ai, ChatGPT/Codex, Gemini, VS Code, Cursor | It is the word people already know; "Turn" is glossary-only at OpenAI. |
| "turn completed" | No line. At most a quiet divider: **Worked for 2m 14s** | Done | Codex ("Worked for {elapsed}"), VS Code ("Completed N steps") | No product announces completion; the reply ending is the signal. |
| "session started on <model id>" | Drop the line; show a model chip: **Sonnet 5.5 · Medium** | "Using Sonnet 5.5" | claude.ai, ChatGPT ("GPT-6.2 Sol · Medium"), Antigravity | Friendly name everywhere; ids only in details. |
| Command row | **Ran `npm test`** (live: "Running…") | "Ran command" | Codex CLI | Plain past-tense verb plus the real command. |
| File read rows | **Read auth.ts**; group several as **Explored 5 files** | "Looked at 5 files" | Codex ("Explored" > "Read"), Claude Code ("Called slack 3 times") | Grouping keeps the evidence without the noise. |
| File edit row | **Edited auth.ts +12 −1** | "Changed 2 files" | Codex ("Edited"), Claude Code (`+12 -1`) | Line counts are the familiar summary of an edit. |
| Token counts in transcript | Remove from messages; keep a **Context 42%** indicator and put tokens in the row's details | Live count beside the working indicator only | Claude Code (Context card, spinner count), Codex ("100% context left") | No consumer chat shows per-message tokens. |
| "worktree" | **Separate copy**, with helper text "Works in its own copy of the project (a git worktree), so your files stay untouched until you accept." | Keep "Worktree" as a toggle label | Codex ("a second copy"), Conductor ("separate, git-backed copy"), Claude Code/VS Code keep "Worktree" | Lead with the plain meaning; keep the git term findable. |
| "pre-approved for this task" | **Allowed for this task** | "Always allowed in this task" | Cowork ("Always allow"), Codex ("for this session") | Same verb as the button; scope stated in words. |
| "standing permission" and its offer | **Always allow**, offered as "Always allow `npm test` in this project" | "Don't ask again for `npm test`" | Cowork, VS Code, Gemini CLI, Claude Code/Codex ("don't ask again for …") | Every product names the exact thing and the scope. |
| Screen "Trust" | **Permissions**, with two tabs: **Always allowed** and **Activity** | "Approvals" | Claude Code (`/permissions`), Codex, VS Code ("Permissions"); Jules ("activity feed"), ChatGPT ("Activity view") | "Trust" elsewhere means trusting a folder, not a list of grants. |
| Approval buttons | **Allow once** / **Always allow…** / **Deny** | "Decline" for the negative | Cowork (Allow once, Always allow, Deny), VS Code (Allow Once, Always Allow), ChatGPT (Allow once, Decline) | Verb buttons that state the outcome (Apple, NN/g). |
| "Decline with a note" | **Deny and say what to do instead** | "Deny with feedback" | Codex and Copilot CLI ("No, and tell … what to do differently"), Gemini CLI ("No, suggest changes") | Says what happens next, not what the control is. |
| State: queued | **Queued** | Waiting to start | GitHub, Jules | Universal. |
| State: building | **Working** | In progress | Claude Code, Codex ("Running"), Grok Build, GitHub | The most shared word for active agent work. |
| State: verifying | **Checking** (detail: "Running tests") | Running checks | GitHub/Conductor ("Checks") | "Verifying" is internal; "checks" is familiar from pull requests. |
| State: reviewing | **In review** | Reviewing | Conductor ("in review"), GitHub ("waiting for review") | Adjective form, per GOV.UK. |
| State: awaiting decision | **Needs input** when the agent asked something; **Ready for review** when the work is finished and awaits accept/reject | Needs your decision | Claude Code, Codex, Grok Build; Claude Code ("Ready for review") | Two different asks deserve two labels; both are established. |
| State: blocked on a rate limit | **Paused · usage limit**, with "Resumes at 3:14" | Waiting for limit to reset | Claude ("You've hit your session limit", reset time shown), Jules ("Paused") | Say why and when; avoid "rate limit" and avoid "Blocked", which is ambiguous. |
| State: interrupted | **Stopped** | Interrupted | Claude Code ("Stopped"), VS Code ("Stop") | Matches the Stop button the person pressed. |
| State: decided | **Accepted** / **Rejected**; use **Merged** if accept merges a branch | Done / Discarded | GitHub ("Merged"), Conductor ("done") | Name the real outcome. |
| "task" | **Task** | — | Jules, Codex, GitHub.com, Cowork, Conductor | The shared word for a defined piece of delegated work. |
| "run" | **Attempt** (only when a task has more than one) | Run | "Run" is API-only (Cursor) or for schedules | Hide the concept unless there are several. |
| "plan" | **Plan** | — | All products | Universal. |
| "branch" | **Branch** | — | All products | Universal among people who can use the result. |
| Roles planner / implementer / reviewer | Name the steps: **Plan → Build → Review** | Planner / Coder / Reviewer | "Plan" and "Review"/"Code review" are universal; "Implement" in VS Code | People follow stages more easily than personas; "Build" is my suggestion, since no shared word exists. |
| "driver" / "CLI" | **Agent**, shown by product name: "Claude Code", "Codex", "Gemini", "Grok" | Provider | Conductor ("choose a Claude Code, Codex, Cursor … model"), VS Code ("Agent" picker) | People know the product names, not "driver". |
| "Connect" a subscription | **Connect** — "Connect Claude Code", then "Connected" | Sign in | Claude ("connect GitHub"), connectors generally | Already the familiar verb; "Sign in" is better if the step is literally a login. |
| Usage page | **Usage**, with "Current session", "Weekly limit", "Resets at …" | Usage & limits | claude.ai (Settings > Usage), Codex, Gemini, Devin | The same words the person sees in the provider's own app. |

### Tool rows: what to show by default and what to put behind a tap

1. **Always in the transcript, one line each:** a plain past-tense verb, the object, and the result. "Ran `npm test` · 3 failed", "Edited auth.ts +12 −1", "Explored 5 files". This is what Claude Code ("Tool calls collapsed into summaries"), Codex, VS Code, Antigravity and Devin do by default.
2. **One tap:** the full command and its output, the diff, the list of files read.
3. **A second level ("Details"):** raw arguments or JSON, timestamps, model, token counts. VS Code and Claude Code's verbose view put it here.
4. **Open by default, not collapsed:** anything waiting for approval, anything that failed, and file-deletion or other hard-to-undo actions.
5. **Thinking:** collapsed under "Thinking", optional.
6. **Never hidden.** A single setting for density (Grok Build's "Compact / Balanced / Detailed", Claude Code's "Normal / Thinking / Verbose") is the established way to let people choose.

Reasons: Anthropic says "Humans need visibility into agents' problem-solving processes" and that "The challenge is in finding the right level of detail." Google's own argument for summaries is that "scrolling through raw tool calls is tedious." NN/g's progressive disclosure gives the mechanism. OpenAI warns that "a confident summary is not enough to establish that a task succeeded", which is why the evidence must stay one tap away and never be removed.

## B. Where the products disagree

1. **Chat vs session vs task.** Consumer apps say chat; Claude Code says session; Jules and Codex say task. Recommendation: **Chat** for the conversational screen and **Task** for a delegated job with a plan, a branch and a decision. That is the split OpenAI's glossary makes, and it matches the owner's goal of familiarity.
2. **Yes/No vs Allow/Deny.** Claude Code and Codex terminals use "Yes" / "No" sentences; graphical products use "Allow once" / "Always allow". Recommendation: **Allow** buttons. Botbench is a touch app, and Apple and NN/g both advise against Yes/No.
3. **Deny vs Decline vs Skip vs Reject.** Anthropic uses Deny, ChatGPT uses Decline, VS Code uses Skip, Cursor CLI and Grok use reject. Recommendation: **Deny**, because Botbench mostly drives Claude Code and its rules are Allow / Ask / Deny. "Decline" is a sound second choice and is what Botbench has now, so changing it is optional.
4. **Permissions vs Rules vs Allowlist vs Approvals.** Recommendation: **Permissions**. It is the most common and the plainest.
5. **Worktree as a label.** Claude Code, Codex and VS Code show the word; Conductor says "workspace". Recommendation: lead with "separate copy" and keep "worktree" in the helper text.
6. **Working vs Running vs In progress.** Recommendation: **Working** (Claude Code, Grok Build, GitHub).
7. **Blocked.** Codex means failed; Devin means waiting on the person. Recommendation: do not use it.
8. **Mode names keep changing.** Claude went from "Ask permissions" to "Manual"; Cowork from "Ask before acting" to "Manual"; Codex from "Agent (full access)" to "Full access". Recommendation: describe behaviour in a sentence under any mode name, because the names are not stable enough to rely on.
9. **How much to show.** Google argues for artifacts over logs; OpenAI and GitHub stress logs as evidence. They agree in practice: summary first, logs available.

## C. What not to do

1. **Do not hide tool activity.** No product read does, and Anthropic, OpenAI, PAIR and HAX G11 all tie visibility to trust and checking.
2. **Do not show raw JSON or arguments on the surface.** Every product collapses it. Google: "scrolling through raw tool calls is tedious."
3. **Do not invent vocabulary** ("Turn", "standing permission", "driver"). NN/g: "Use words, phrases, and concepts familiar to the user, rather than internal jargon."
4. **Do not show a model id as the only name.** Every picker read uses friendly names.
5. **Do not print "turn completed" or per-message token counts.** No consumer product does.
6. **Do not label buttons Yes / No / OK.** Apple and NN/g both say to name the outcome.
7. **Do not offer "always allow" without stating exactly what and where.** Every product names the command, file, host or site, and the scope.
8. **Do not ask for approval on routine, undoable actions.** Anthropic measured 93% acceptance and names "approval fatigue"; NN/g: "Do not use confirmation dialogs for routine actions."
9. **Do not use "Trust" for the permissions list,** and do not use "Blocked" as a status.
10. **Do not let a summary replace the evidence.** OpenAI: "a confident summary is not enough to establish that a task succeeded."
11. **Do not use colour alone or many custom statuses.** Atlassian and GOV.UK.
12. **Do not present thinking as proof.** Anthropic and NN/g both say it may not reflect what the model did.

---

## What could not be verified

- Composer placeholders for claude.ai, ChatGPT, Gemini, Grok and Cursor. Only Codex CLI's "Ask Codex to do anything" was read.
- Transcript labels for tool use in claude.ai, ChatGPT web/desktop, Cursor and the Gemini app. Verified labels are from Codex CLI source and Claude Code docs.
- Claude Code's exact row labels for file reads and edits in the terminal.
- Cursor's "Run" / "Skip" / "Keep" / "Undo" / "Add to allowlist" buttons, and Cursor UI status labels.
- Gemini app model picker labels ("Fast / Thinking / Pro" is recalled).
- Material Design dialog guidance (pages would not render); Polaris "actionable language" page (404); GOV.UK plain-English page.
- The OpenAI Codex launch post quote is a fragment from a fetch that also returned unrelated text.
- Most quotes passed through a fetch tool's summariser. Spot-check any quote before publishing it outside the team.
- Botbench's actual screens were not inspected; concept names come from the brief.
