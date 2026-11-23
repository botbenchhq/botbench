# Can Codex be a builder through `codex app-server`? (checked 2026-11-23, Codex 0.171.0)

**Answer: not through Codex's approval requests alone. Two other shapes do work, and one is recommended below.** `codex app-server` sends its approval requests to the client, for commands (`item/commandExecution/requestApproval`) and for file changes (`item/fileChange/requestApproval`). But on 0.171.0, a command or patch the client accepts then runs **outside Codex's sandbox**: an approval *is* an escalation. Botbench's permission check allows a confined command without asking, so if Botbench answered "accept", every allowed command would run unconfined. This was first found with a scripted model endpoint and has now been **confirmed with the real model on the owner's Mac** (below). Two other shapes, both measured live, give a gate before every command together with a sandbox that still holds after the gate says yes:

- **(c) Codex's own sandbox, never asking, plus a `PreToolUse` hook that asks Botbench.** This is the recommended builder shape. It mirrors how Claude Code is driven.
- **(a) The whole `codex app-server` inside Botbench's `sandbox-exec` profile**, as Grok is run, with Codex's own sandbox off and `approvalPolicy: "untrusted"`. This one works too, but its commands can read Codex's sign-in.

**What was built (B19 in `docs/security/threat-model.md`):** neither of those, but the shape the owner chose: `on-request` in Codex's own sandbox under Botbench's profile, with **every** approval request taken for what this check found it to be, an escalation. Each becomes one card saying Codex asks to run it outside its sandbox, decided by the owner every time (refused in a fully autonomous run); no grant, mode or confinement rule ever answers one, and anything but the owner's own allow is a decline (`src/drivers/codex-app-server.ts`). What stays in the sandbox never asks, so the gap measured in (b) remains: a command the sandbox refuses without asking produces no item. Review and chat stay on `codex exec` (`src/drivers/codex.ts`, `CODEX_CAPABILITIES`).

## 1. The finding, confirmed live (2026-11-23)

Setup: the owner's signed-in `codex-cli 0.171.0` (`/opt/homebrew/bin/codex`, "Logged in using ChatGPT"), started as `codex app-server` with no sandbox around it, `gpt-5.6-luna`, effort `low`, and `-c mcp_servers={}`, `web_search="disabled"`, `--disable hooks plugins apps`. It was driven over JSON-RPC on stdio by a short script (`initialize` with `experimentalApi`, `initialized`, `thread/start {cwd, approvalPolicy, sandbox, model, ephemeral:true}`, `turn/start`). The workspace was a throwaway git repository under `/tmp`. The write target was a new folder `~/cx70-out`, outside every writable root. (`/tmp` itself is writable under `workspace-write`, so it could not serve as "outside".) The model was asked to run `touch ~/cx70-out/landed-<case>` once, and the script gave every request the same answer. Decoys and folders were removed afterwards.

| Approval policy | Sandbox | Asked? | Answer | Result |
| --- | --- | --- | --- | --- |
| `untrusted` | read-only | yes | `accept` | **written** (outside the sandbox) |
| `untrusted` | workspace-write | yes | `accept` | **written** |
| `untrusted` | read-only | yes | `decline` | not run; item `status:"declined"` |
| `never` | read-only | no | none | refused by the sandbox: "Operation not permitted" |
| `on-request` | read-only | no | none | refused by the sandbox |
| `on-request`, model asks for escalation | read-only | yes, `reason:"probe"` | `accept` | **written** |
| `granular` (all four true) | read-only | yes, after the sandboxed try failed | `accept` | **written** |
| `untrusted`, `apply_patch` adding a file in `~/cx70-out` | read-only | yes (`item/fileChange/requestApproval`) | `accept` | **written** |

The evidence lines, trimmed of ids, from the first row:

```
<< thread/settings/updated  "approvalPolicy":"untrusted", "sandboxPolicy":{"type":"readOnly","networkAccess":false}
<< item/commandExecution/requestApproval  {"kind":"command","command":"/bin/zsh -lc 'touch /Users/…/cx70-out/landed-T1'",
     "cwd":"/tmp/cx70/ws","proposedExecpolicyAmendment":["touch","/Users/…/cx70-out/landed-T1"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":…},"cancel"]}
>> {"id":0,"result":{"decision":"accept"}}
<< item/completed  {"type":"commandExecution","status":"completed","exitCode":0,"source":"unifiedExecStartup"}
$ ls ~/cx70-out  →  landed-T1
```

Codex says so itself under `granular`: the request came only after the sandboxed try had failed, with `"reason":"command failed; retry without sandbox?"`. Under `on-request` (OpenMausBot's default), commands are asked about only when they need to leave the sandbox, so accepting one means letting it out. The patch case looks the same: `item/started` carried `changes:[{"path":"/Users/…/cx70-out/patched-T8.txt","kind":{"type":"add"}}]`, the request carried no paths, and the file was written in a read-only sandbox.

So there is no setting on 0.171.0 where a command both reaches Botbench's gate as an approval request and stays in Codex's sandbox once allowed.

## 2. How OpenMausBot handles it

Read: `server/drivers/codex.ts`, `server/drivers/codex-approval-config.ts`, `server/safety-floor-gate.ts`, `server/auto-approve.ts` (not `enterprise/`).

- **It accepts that approval is escalation.** Its named modes are `on-request` with `workspace-write` (Ask and Auto) and `never` with `danger-full-access` (Full) (`namedApprovalParams`). Under `on-request`, a request only comes when a command wants out of the sandbox, so the card the owner answers *is* the decision to run it unsandboxed. A request that carries `additionalPermissions` or `networkApprovalContext`, and every `item/permissions/requestApproval`, is marked `requiresExplicitApproval`, so only a person or explicit Full may answer it. Its comment says: "Codex's `never` means 'do not ask to escalate', not 'grant every requested permission': only Full may synthesize approvals."
- **What it puts around it:** `withResolvedSandbox` refuses a turn whose `thread/start` reports a looser sandbox than asked. Unknown server requests fail closed. An unanswered card is declined after 15 minutes. The safety floor applies only "where the server would allow a command with nobody looking", and its own header says it "cannot reach an engine that never asks: … Codex with approvals off". The floor is off by default.
- So OpenMausBot does not give a confined command a gate. The commands that stay in the sandbox are never seen, and the ones it sees leave the sandbox if allowed. Botbench's rules (every command reaches the check, an allowed command stays confined, the floor always applies) need more than that.

Codex's own help says the same: `--dangerously-bypass-approvals-and-sandbox` is "intended solely for running in environments that are externally sandboxed". The npm package ships no other docs (`README.md` only).

## 3. The shapes, each measured live

### (a) The whole `codex app-server` inside Botbench's `sandbox-exec` profile

This is how Grok is run. `toolsProfile` (`src/drivers/cli-sandbox.ts`) was used unchanged: home and the shared secret list denied, then `~/.codex` (Codex's own folder), the workspace and a private temporary folder opened, and no network except Botbench's provider proxy (`startProviderProxy(["openai.com","chatgpt.com"])`, `proxyEnv`). Codex ran with `sandbox: "danger-full-access"` (macOS cannot nest a second sandbox) and `approvalPolicy: "untrusted"`.

- **It starts and works.** Through a logging proxy, Codex contacted only `chatgpt.com:443`, and every connection went through the proxy variables.
- **Every command and every patch asks.** One turn of 9 commands plus a patch and a `git status` sent 11 requests: 10 `item/commandExecution/requestApproval` and 1 `item/fileChange/requestApproval`. `ls`, `pwd`, `cat README.md` and `git status` each asked too. `on-request` and `never` under full access send none.
- **Accepted, they stay confined** (every request answered `accept`):

  | Command | Result |
  | --- | --- |
  | `touch ~/cx70-out/landed-O4` | `Operation not permitted` |
  | `cat ~/.ssh/<decoy>` | `Operation not permitted` |
  | `cat ~/.botbench/<decoy>` | `Operation not permitted` |
  | `curl https://example.com` (via the proxy) | `CONNECT tunnel failed, response 403` |
  | `curl --noproxy '*' https://example.com` | `Could not resolve host` |
  | `git push origin …` to a bare repository in `~/cx70-out` | failed (the remote is unreadable) |
  | `sudo -n true` | `operation not permitted: sudo` |
  | `apply_patch` adding a file in `~/cx70-out` | `failed` |
  | `sh test.sh`, `apply_patch` on `README.md`, `git status --short` inside the copy | worked |
  | **`cat ~/.codex/<decoy>`** | **`DECOY-CODEX-cx70`, readable** |

- **A refused command is visible.** Each failed command above came back as an item with `status:"failed"`, its exit code and its output.
- **What it does not give:** Codex must read and write `~/.codex` to work, so **its commands can read Codex's sign-in** (`auth.json`). They can also reach `chatgpt.com` and `openai.com` through the proxy, and for a builder, any host the repository allows. That is Grok's known limit (B18), but a builder runs the repository's own code (tests, install scripts), and an allowed host would be a way out for the token. `git` warned "couldn't create cache file … xcrun_db" (macOS's per-user temporary folder is closed); this is harmless.

### (b) Codex's own sandbox, `on-request`, no gate (a builder that cannot ask)

Run with Botbench's chat permissions profile (`codexConfig`, `:workspace`, the copy writable, no network), with the `sandbox` parameter left out so the profile is in force: `activePermissionProfile:{"id":"botbench-chat","extends":":workspace"}`.

- **The floor's actions fail in the sandbox.** `git push` to a local bare remote outside the workspace failed ("does not appear to be a git repository"; without the profile, "unable to create temporary object directory"). `sudo -n true` failed ("operation not permitted"). `touch` outside the copy and `cat` of the `~/.ssh` and `~/.codex` decoys failed. Commands have no network. (Without Botbench's profile, plain `workspace-write` **read the `~/.ssh` decoy**: Codex's default sandbox reads everywhere.)
- **What the owner would lose:** there is no approval card for anything, no "Ask before every command", and no safety floor decision. A floor-named command that the sandbox does allow (for example a destructive `git` or `rm` inside the copy) simply runs. Under `on-request` the model may still ask to escalate, and Botbench could only decline that.
- **A refused command is not in the event stream.** A command the sandbox refused with "Operation not permitted" got **no item at all**: `touch` outside, `sudo` and both `cat`s were missing, and only the model's reply mentioned them. A command that failed for another reason was reported (`git push`, exit 128). The action log would miss exactly the attempts that matter.

### (c) Codex's own sandbox, `never`, plus a `PreToolUse` hook (recommended)

Codex 0.171.0 has command hooks (`hooks.<Event>` with `type="command"`, `timeout`). They run in `codex app-server` when the `hooks` feature is on and the hook is trusted.

- **Defining and trusting a hook from session flags works:** `-c 'hooks.PreToolUse=[{hooks=[{type="command",command="<node> <hook>",timeout=N}]}]'` plus `-c 'hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:…"}}'`. The hash is the one `hooks/list` reports for that key. Without the state the hook is listed with `"trustStatus":"untrusted"` and never runs. The dotted form `hooks.state."<key>".trusted_hash=…` is refused ("unrecognized configuration setting … is ignored"). `hooks/list` (an app-server request) shows each hook's source, hash, `enabled` and `trustStatus`, so Botbench can check its own hook before every turn.
- **It sees every command and every patch, with their input.** Seen: `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo DENYME"},…}` and `{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Add File: /Users/…/cx70-out/patched-H6.txt …"}}`. `PostToolUse` gets `tool_response`, **including for a command the sandbox refused** (`"touch: …: Operation not permitted\n"`), which the event stream omits. So the action log can come from the hooks.
- **A deny blocks.** Output `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Botbench refused it"}}` gives the model "Command blocked by PreToolUse hook: Botbench refused it.", and `hook/completed` reports `status:"blocked"`. Exit code 2 with a message on stderr blocks too. Printing nothing lets the command run.
- **What the hook allows still runs in Codex's sandbox**, under Botbench's profile (`approvalPolicy:"never"`, `activePermissionProfile:"botbench-chat"`). `sh test.sh` and a patch to `README.md` worked. `touch` outside failed ("Operation not permitted"), `cat ~/.codex/<decoy>` failed (**the sign-in stays unreadable to commands**), and the patch outside the copy was rejected ("writing outside of the project").
- **Its failures let the command run.** A hook that exits 1 (`status:"failed"`, "hook exited with code 1"), times out (`status:"failed"`, "hook timed out after 4s"), prints something that is not JSON (`status:"completed"`), or answers `permissionDecision:"ask"` (`status:"failed"`, "unsupported permissionDecision:ask") **lets the command run**, inside Codex's sandbox. `permissionDecision:"allow"` is unsupported too. So the hook can only refuse, and a hook that fails is the same as a hook that said yes.

### Other things checked

- No approval policy tried (`untrusted`, `on-request`, `granular`, `never`), with or without a permissions profile, keeps an accepted command in Codex's sandbox. Execpolicy rules and the `acceptWithExecpolicyAmendment` and `acceptForSession` answers decide which later commands are asked about. They were not found to change where an accepted one runs, and were not tested further.
- `codex app-server` has no `--ignore-user-config` or `--ignore-rules` (`codex exec` has both). The owner's `~/.codex/config.toml` is loaded, so a driver must override every setting it relies on and check what is in force (`thread/settings/updated` for the sandbox, `hooks/list` for hooks).

## 4. Recommendation

**Codex as a builder: shape (c).** Run `codex app-server` with Botbench's permissions profile (a builder variant of `codexConfig`: the task's copy writable, the repository's git folder read-only, no network unless the repository allows hosts), with `approvalPolicy:"never"`, `--enable hooks`, and one trusted `PreToolUse` hook (with no matcher, so it covers every tool) that puts each call to Botbench's broker and safety floor, as Claude Code's hook does. It gives:

- Every command and patch reaches the gate before it runs, with the command text or patch.
- What the gate allows still runs in Codex's sandbox, with Codex's sign-in, the secret list and Botbench's data folder unreadable to commands.
- Reading, editing in the copy and confined commands pass without a card. Approval cards, "Ask before every command" and the floor work, with the hook waiting while the owner decides.
- `PostToolUse` gives the action log every result, refusals included.

**What it does not give, stated exactly:** the hook can only refuse. Any failure of the hook process lets that one command run ungated, still inside Codex's sandbox. That includes a crash other than exit 2, Codex's hook timeout, output Codex cannot read, or an unsupported decision. So the driver must:

- deny (exit 2) on every error the hook can see, the broker unreachable or slow included;
- keep its own deadline below Codex's `timeout`, which must be long enough for a card;
- stop the turn at the first `hook/completed` with `status:"failed"` and record it as a refusal that blocks the accept;
- check before each turn that `hooks/list` shows its one hook as trusted and enabled, and no other hook, and that `thread/settings/updated` reports the profile in force, refusing to start otherwise;
- keep the broker's socket and secret out of the commands' environment (`shell_environment_policy`).

The hook trust form is an undocumented detail of 0.171.0 and must be re-checked on each Codex version. This is the floor "always applies" up to a failed hook; the hook failing once is not "broker failure = deny" in the strict sense, so the owner should accept that residual before it is built.

**Fallback: shape (a)**, if hooks change. It has the stronger gate: Botbench answers every request, so broker failure is a plain decline. But its commands can read `~/.codex` and reach OpenAI through the proxy. **Not (b):** it removes every card and the floor and hides refused commands. **Not Codex's approvals inside its own sandbox:** an accepted request runs unsandboxed.

**Codex in chat and review:** keep `codex exec` with Botbench's profile and `approval_policy="never"` as today. Codex is not trusted there, nothing is asked, and its sign-in is unreadable to its commands. The same hook could later give chat approval cards and a full action log (refused commands included) without changing the confinement.

## Appendix: the first check, with a scripted endpoint (same day)

Before the live run, the same protocol was driven against a scripted Responses endpoint on 127.0.0.1 (`-c model_provider=…`), because the session it ran in could not read `~/.codex`. In that session, inside macOS Seatbelt, a command Codex runs inside its own sandbox fails with `sandbox_apply: Operation not permitted` (exit 71), and one run outside succeeds. It found the same thing as the live run above: `untrusted`, `on-request` with escalation, `granular`, a permissions profile and `features.exec_permission_approvals=true` all ran an accepted command outside the sandbox. It also found:

- `decline` is honoured although `availableDecisions` lists only `accept`, `acceptWithExecpolicyAmendment` and `cancel`.
- The params of `item/fileChange/requestApproval` carry no paths or diff. They come in the `item/started` of the `fileChange` item with the same id.
- `exec_command`'s `sandbox_permissions:"require_escalated"` is not marked in the request (only `reason`), so a client cannot tell an escalation from an ordinary request.
- `apply_patch` is offered to a scripted endpoint only with a catalog entry that has `apply_patch_tool_type` (`-c model_catalog_json=…`), since the bundled models are `code_mode_only`.
