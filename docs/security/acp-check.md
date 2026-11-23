# Can one ACP driver drive more agent CLIs under Botbench's guarantees? (checked 2026-11-23)

A small, bounded spike (#170), asked for by the owner. It is an evaluation, not an implementation: no driver was written and nothing in `src/` changed.

**Answer: not as one generic driver. It can work for specific agents, and Grok is the best fit.** The Agent Client Protocol (ACP, protocol version 1) gives Botbench a permission request it answers, an event stream with each tool call's name, input and output, cancel, and session load and resume. Two native ACP servers on this Mac, `grok agent stdio` (Grok 1.0.92) and `agy acp` (Antigravity 1.5.14), did all of that live. The protocol does not decide which actions ask, cannot switch tools off, and does not make an agent run its commands through the client. Those depend on each agent, so one generic driver would not hold Botbench's guarantees.

## 1. What was run

- A zero-dependency Node client (about 150 lines, newline-delimited JSON-RPC 2.0 on stdio) that advertised `fs.readTextFile`, `fs.writeTextFile` and `terminal`, and implemented all three. File calls were limited to a throwaway git repository. A terminal request could be run, refused, or wrapped in `sandbox-exec`.
- The agents were started with only the variables on `src/drivers/launch.ts`'s allowlist, every key-shaped name removed, each in its own process group.
- A decoy file was placed in the home folder and removed afterwards.
- **Nothing was installed:** no npm package, adapter or SDK. No agent was started with permissions bypassed and no sign-in was performed.
- **Seven model turns** in all: three on Antigravity (`gemini-3.8-flash-low`), four on Grok (`grok-4.5`, low reasoning), two of the Grok turns in a run stalled by a bug in the test client.

| CLI | Version | ACP mode | Result |
|---|---|---|---|
| Claude Code | 2.1.322 | none of its own | Needs a third-party adapter; not installed (section 5) |
| Codex | 0.171.0 | none (`app-server` is Codex's own protocol) | Needs a third-party adapter; not installed |
| Gemini CLI | 0.70.0 | `--acp` | `initialize` works; `session/new` refuses individual accounts and points to Antigravity |
| Antigravity | 1.5.14 | `agy acp` | Tested |
| Grok | 1.0.92 | `grok agent stdio` | Tested |
| OpenCode | not installed | | Not tested |

## 2. What was seen

**An edit, allowed then denied.**

- Antigravity sent each edit as a tool call, then a permission request with a diff and two options (allow once, reject once). Allowed, the file was written. Denied, the file was not written, and the command that followed in the same turn was reported failed without running.
- Grok sent each edit with a diff and three options. Denied, the file was not written and the turn ended as cancelled. Allowed, Grok then read through the client's file method. A write through the client's file method was not reached and is not tested.
- A permission answer in ACP is an option id or "cancelled". There is no field for a message to the model, so "deny and say what to do instead" needs a follow-up prompt.

**A shell command.**

- Antigravity asked before every command, then **ran it itself**. It never used the client's terminal or file methods although both were offered, and a `cat` of the decoy in the home folder printed its contents. Its command tool can leave a command running in the background.
- Grok **did not ask** about `cat` of the decoy or `touch`, either by default or with `--permission-mode default`. It then asked the client to run the command (`terminal/create`, with its own environment list and working folder), waited for the exit and read the output. So the command ran in the client's process, and in this test it read the decoy, because the client ran it unconfined.
- The same `sandbox-exec` profile, run by hand, refused the decoy and the network. A Grok-requested command under that profile was not observed end to end, and a refused `terminal/create` was not reached. **Confinement of Grok's commands is shown by construction, not by observation.**

**Cancel mid-turn.** Both answered within 15 ms with stop reason `cancelled`. Antigravity stopped its own command. Grok sent no kill for the terminal the client was running, and the command finished about 20 seconds after the cancel. Under ACP the client must kill its own terminals.

**Kill the client and resume.** After a restart, `session/load` replayed the history (9 updates from Antigravity, 6 from Grok) and `session/resume` returned success without history. No turn was sent after resuming, so carried-over context was not checked with the model.

**Usage limit.** Not tested; none was hit. ACP has no usage-limit error or stop reason. The reference projects detect limits from agent-specific text or codes.

**A hang.** The test client once answered a failed read with a string error code. Grok rejected the reply, never noticed the request had failed, and waited forever, with later prompts queued behind it. A driver needs its own deadline on every request and turn.

## 3. The four guarantees

| Guarantee | Antigravity `agy acp` 1.5.14 | Grok `grok agent stdio` 1.0.92 |
|---|---|---|
| **Permissions:** every request reaches the broker; failure means deny; never bypassed | **Partly.** Every edit and command asked; allow and deny were honoured; a deny ends the turn. No message can go with a deny. | **Partly.** Edits asked and a deny was honoured. Commands never asked. Botbench could still gate them when Grok asks the client to run them (untested). An `always-approve` slash command exists, so prompt text that starts with `/` needs care. |
| **Tool controls:** every call visible; long-lived tools, personal settings, hooks and personal MCP servers off | **Partly.** Every call is visible with input and output. ACP cannot switch tools off; background commands stay. Whether personal settings load was not tested. | **Partly.** Every call is visible. No switch-off over ACP was found (`--disallowed-tools` in this mode not tested). It merges the owner's MCP servers. |
| **Confinement:** Botbench confines the commands; credentials unreadable to them | **Not preserved.** It ran commands itself and read the decoy. Only a sandbox around its whole process would confine it, as for Grok today. | **Partly.** Commands and file reads go through the client, so Botbench could confine each command with its own profile and keep Grok's sign-in out of reach. By construction; not observed. |
| **Lifecycle:** start clean in a folder, one turn, events, cancel, resume, usage limit | **Preserved**, except usage limits (not tested). | **Partly.** Cancel left the client's command running; prompts queue instead of failing. Usage limits not tested. |

## 4. The protocol and the agents

The protocol gives: a permission request the client answers (the option kinds are display hints; the agent owns what is remembered); tool calls with raw input and output; cancel; session load and resume; MCP servers passed at session start (it does not say whether they replace the agent's own or are added).

The protocol leaves to the agent: which actions ask; whether a tool exists; whether commands go through the client's terminal (it only forbids calling it when the client did not offer it); whether files go through the client; any usage-limit signal.

What the reference projects do (source read, see `docs/competitive/`): none of Tutti, OpenMausBot or Agenta offers the client terminal. OpenMausBot runs Grok in this mode, including with permissions bypassed in its full-access level. Agenta's source notes that the Claude adapter starts a session in an automatic mode that never asks unless the mode is forced, and that the Codex adapter's full-access preset sets approvals to never.

## 5. Dependencies

| Package (not installed; from `npm view`) | Licence | Built on | Fits Botbench's rules? |
|---|---|---|---|
| `@agentclientprotocol/claude-agent-acp` 0.110.0 | Apache 2.0 | The Claude Agent SDK | **No.** A vendor agent SDK between Botbench and Claude Code. Botbench already drives `claude` directly. |
| `@agentclientprotocol/codex-acp` 2.10.0 | Apache 2.0 | Its own copy of Codex, wrapping `codex app-server` | **No gain.** A third-party runtime dependency over the protocol Botbench already drives directly (`codex-app-server-check.md`). |
| `@agentclientprotocol/sdk` 2.9.1 | Apache 2.0 | | **Not needed.** The protocol is small. |

Only a vendor's own ACP server (`agy acp`, `grok agent stdio`) fits "drive existing CLIs, no vendor agent SDKs, zero runtime dependencies".

## 6. Risks

- What asks is each agent's decision. A driver must gate at the methods it controls (`terminal/create`, the file methods), not rely on the permission request alone, and must refuse an agent that runs commands itself unless its whole process is sandboxed.
- No tool can be switched off over ACP. Background commands, slash commands and the owner's personal MCP servers stay unless agent-specific flags remove them. Each needs measuring per agent and per version.
- The client owns terminal cleanup on cancel, on close and on its own exit.
- An agent can hang on one malformed reply and can queue prompts.
- No message with a deny; no standard usage-limit signal.
- Gemini CLI's ACP is already closed to individual accounts. A protocol does not keep a CLI alive.

## 7. Recommendation

**Adopt ACP for specific agents only: Grok first, Antigravity second. Keep the hand-written drivers for Claude Code and Codex.**

- **Grok over ACP** could move it from review and chat to a gated builder: its edits ask Botbench, and its commands and file reads run in Botbench's process, where the broker, the safety floor and Botbench's own confinement apply. Grok's sign-in would then be out of reach of its commands, which is better than today's sandbox around the whole process.
- **Antigravity over ACP** gives a real permission request for every edit and command, but it runs commands itself, so it is acceptable only inside a sandbox around its whole process.
- **What would change the answer for a generic ACP driver:** agents that use the client's terminal for all execution, a standard way to restrict tools, or a usage-limit signal in the protocol.

**Smallest next step, one yes-or-no test:** one Grok turn where the client refuses to run the command (does Grok then run it itself?) and runs an allowed command under Botbench's sandbox profile (are the decoy and Grok's sign-in unreadable, and the network closed?); and whether `grok --disallowed-tools` works in this mode. If all hold, write a decision record and a Grok ACP driver that kills its terminals on cancel and close, sets a deadline on every request, answers "cancelled" on any error, and refuses any vendor request it does not know. This does not block Peers P5.

## Not tested

Usage-limit detection. Grok's write through the client's file method, and what Grok does when the client refuses a command. A Grok-requested command under `sandbox-exec`, end to end. Whether either agent loads personal settings or MCP servers. Antigravity's `--sandbox` flag. The Claude Code and Codex adapters. OpenCode.
