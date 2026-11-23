# Can Codex be a builder through `codex app-server`? (checked 2026-11-23, Codex 0.171.0)

**Answer: not yet.** `codex app-server` does send its approval requests to the client, and Botbench could answer them. But on 0.171.0, a command the client accepts then runs **outside Codex's sandbox**. Botbench's permission check allows a confined command without asking, so if Botbench answered "accept", the command could read the decoys for the vendor sign-ins, keys and Botbench's data folder, and reach the network. That breaks R27 and the rule that a mode never loosens the safety floor. The Codex driver therefore stays as it was: `edits: false`, `permissionRequests: false`, review and chat only on `codex exec` (`src/drivers/codex.ts`, `CODEX_CAPABILITIES`). Per the first criterion of the "Make Codex a builder" task, the work stopped at this check.

## What was checked, and how

The real installed `codex` 0.171.0 (`/opt/homebrew/bin/codex`), started as `codex app-server` and driven over JSON-RPC on stdio by a short script, with a new empty `CODEX_HOME`.

- **Protocol.** `codex app-server generate-json-schema` lists these server-to-client requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, and the older `execCommandApproval` and `applyPatchApproval`.
- **The sandbox in force.** Seen live: the `thread/start` answer reports it, for example `"sandbox":{"type":"readOnly","networkAccess":false}` or `{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,…}`, with `approvalPolicy`, `approvalsReviewer` and `activePermissionProfile`. A check like `withResolvedSandbox` could be built on it.
- **Approval requests and answers.** A real model turn needs Codex's sign-in, and the session this check ran in cannot read `~/.codex`: Codex stopped with "failed to open state DB at ~/.codex/state_5.sqlite". So the turns were driven by a scripted Responses endpoint on 127.0.0.1, set with `-c model_provider=…`. The endpoint asked for one `exec_command` call, then a final message. It stands in for the model only. Everything that decides whether to ask, how the answer is taken and how the command runs is the real CLI. Nothing of it is in the repository or the test suite.

The session ran inside macOS Seatbelt, and macOS does not let a sandboxed process start another sandbox. That gives a clean signal: a command Codex runs **inside** its own sandbox fails here with `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71). One it runs **outside** its sandbox succeeds.

| Approval policy (thread/start) | Sandbox | Command | Asked the client? | Answer | What ran |
| --- | --- | --- | --- | --- | --- |
| `never` | read-only | `touch made.txt` | no | none | inside the sandbox (exit 71) |
| `on-request` | read-only | `touch made.txt` | no | none | inside the sandbox (exit 71) |
| `untrusted` | read-only | `touch made.txt` | yes, `item/commandExecution/requestApproval` | `decline` | nothing: item `status:"declined"`, model told "rejected by user" |
| `untrusted` | read-only | `ls` | yes | `decline` | nothing |
| `untrusted` | read-only | `touch made.txt` | yes | `accept` | **outside the sandbox** (exit 0, `made.txt` written in a read-only sandbox) |
| `untrusted` | workspace-write | `touch made.txt` | yes | `accept` | **outside the sandbox** (exit 0) |
| `untrusted` | read-only | `ls` | yes | `accept` | **outside the sandbox** (exit 0) |
| `untrusted` + a permissions profile (`default_permissions`, `:workspace`, no network) | read-only | `touch made.txt` | yes | `accept` | **outside the sandbox** (exit 0) |
| `untrusted` + `features.exec_permission_approvals=true` | read-only | `touch made.txt` | yes | `accept` | **outside the sandbox** (exit 0) |
| `on-request` | read-only | `touch esc.txt` with `sandbox_permissions:"require_escalated"` | yes | `accept` | **outside the sandbox** (exit 0) |
| `granular` (`sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions` all true; needs `experimentalApi`) | read-only | `touch made.txt`, `ls`, escalated `touch` | yes | `accept` | **outside the sandbox** (exit 0) |

Other things seen:
- `exec_command` takes `sandbox_permissions: "require_escalated"` ("unsandboxed execution"). The approval request for such a command carries only `reason` (the model's justification). Nothing in it marks the command as escalated, so a client cannot tell an escalated request from an ordinary one.
- `decline` is honoured although `availableDecisions` lists only `accept`, `acceptWithExecpolicyAmendment` and `cancel`.
- A declined command is reported as an item (`commandExecution`, `status:"declined"`). `codex exec` prints nothing for a refused command that exits non-zero, so this would improve the transcript.
- A file change was not seen. Under the fallback model settings the scripted endpoint got, Codex offered no `apply_patch` tool, and a known model name offered no tools to it at all. `item/fileChange/requestApproval` is in the protocol but was not observed.

## Why this stops the builder

Either a command asks Botbench and, once allowed, runs unconfined, or it stays confined and never asks. On 0.171.0 no setting gives both. The builder criteria need both: every command reaches Botbench's check before it runs, and no command a Codex builder runs can read the decoys or reach the network.

The ways around it break another rule:
- **Botbench's own `sandbox-exec` around the whole `codex app-server`** (as for Grok, `src/drivers/cli-sandbox.ts`). That sandbox would have to let Codex read its own sign-in under `~/.codex`, so an accepted command could read it too.
- **`on-request`, with Botbench declining every escalation.** Commands stay in Codex's sandbox, but they run without reaching Botbench's check, the safety floor or "Ask before every command". Codex would be a builder that cannot ask. That is a product decision for the owner, not a gap this task may fill.

## What would reopen it

A Codex version where an accepted command still runs in the thread's sandbox (or where the request says the command is escalated, so Botbench can decline that case and accept the rest). To check: run a `thread/start` with `approvalPolicy: "untrusted"` and a read-only sandbox, accept one `touch` in the folder, and see whether the file is written. If it is, the sandbox was lifted. On the owner's Mac outside any sandbox, that test is the one that counts. The scripted endpoint was used here only because this session could not reach Codex's sign-in, and a live turn with the real model should confirm the table before any builder work starts.
