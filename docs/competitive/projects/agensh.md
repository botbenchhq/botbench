# Microsoft Agensh

| | |
|---|---|
| Repository | https://github.com/microsoft/Agensh |
| Commit read | 2dae4e1, 2026-11-03 (shallow clone) |
| Licence | MIT (`LICENSE`), copyright Microsoft Corporation. No enterprise folder and no hosted tier. The paper `agensh.pdf` is in the repo. It relies on third-party services (Gitea, Mattermost, MySQL), each under its own licence, which are pulled as images and not vendored. |
| Stack | Python 3.11+ standard library for the driver (`agensh/`), FastAPI and aiomysql for the board service (`board-service/`), TypeScript on Node for the per-worker router (`mini-router/`), Bash for launch and bootstrap. Gitea is the git host and CI (Gitea Actions), Mattermost the chat, MySQL the event queue and board history. Deploys as a single-node Docker Compose stack on a Linux host. |
| Size and activity | About 190 files and roughly 8k lines of core code, plus a 75 MB clone (most of it the demo GIF and PDF). Unit tests (`tests/unit/`), a model-free smoke test that drives two scripted workers through the real services (`tests/smoke/run_smoke.sh`), and GitHub CI (`.github/workflows/ci.yml`). It began as a research artefact. A newer "task pack" layer (`docs/task_pack_design.md`, still marked "draft for discussion") turns it into a tool for real repositories. |
| Evidence basis | Source read only; not run |

## Promise and intended customer

The README promises "a self-organized multi-agent harness that scales to 1,024 agents", in which "agents discover and claim sub-tasks, share findings, verify results and merge progress asynchronously, without a central orchestrator" (`README.md:22-26`). The headline numbers are ProgramBench test-pass rates: a mean of 19.31% with 1 agent and 28.78% with 128 agents on the five hardest tasks, and 33.89% to 55.06% on pandoc with 1,024 agents. They are reported, not reproduced here.

There are two customers. The first is researchers reproducing the paper (`REPRODUCE.md`, `tasks/programbench/`). The second, newer one is a person or small team who points a team of 1 to 16 agents ("optimized for 4–16", `docs/acceptance_testing.md:4`) at their own repository through `.agensh/project.toml`, gets `main` delivered upstream as a GitHub pull request that is never merged automatically, and can optionally act as "product owner" (`tasks/software-project/README.md`).

Every agent in a run belongs to one operator, on one host, with one model gateway. Nothing in the design involves agents owned by different people.

## What is actually implemented

| Capability | Evidence level | Source reference | Note |
|---|---|---|---|
| No central orchestrator; workers claim their own sub-tasks | Implemented | `prompts/agents.txt:36-42`, `tasks/software-project/templates/work_cycle.txt:1-15` | The loop lives in the prompt. The runtime only routes events, renders the board and enforces CI gates. The paper says the loop is realised "through workflow instructions ... rather than hard-coding" (`agensh.pdf` §2.3). |
| CLAIM entries on a shared board | Implemented | `board-service/shared_lessons.py:14,77-79`, `board-service/main.py:42,469-496` | Free text of at most 100 characters with a fixed TTL (default 3600 s). There is no structure and no exclusivity. |
| Claim conflict detection | Absent (in code) | `board-service/shared_lessons.py:420-426` | The server accepts any number of overlapping claims. It only renders them under the header "pick a different angle if your plan duplicates theirs". Conflicts are left to the agents, which are told to settle them by DM (`prompts/agents.txt:16-20,66`). |
| Shared findings board (FACT, OBSERVED, FAIL, PATCH_SUMMARY) | Implemented | `board-service/shared_lessons.py`, `board-service/main.py`, `mini-router/sql/03_board_schema.sql` | Append-only MySQL history, a recent view held in memory, grep across the full history, and expandable detail. |
| Mid-turn delivery of DMs and peer board entries | Implemented | `mini-router/mcp_notice_shim.cjs:1-5`, `board-service/main.py:341-412` | Notices are appended to the result of the next infrastructure MCP tool call. A short lease (`main.py:262-295`) stops parallel wrappers draining the same notices. |
| Duplicate-effort measurement | Partial | `board-service/shared_lessons.py:276-342,437-480` | Exact and "semantic" (file/symbol/test anchors) dedup applies to findings, not to claims or code. The lifecycle export records `written_count` and `render_count` per entry. Neither the code nor the paper measures duplicated code work. |
| Merge only through PRs with a CI gate | Implemented | `docker/bootstrap/bootstrap.sh:281-318`, `agensh/quality.py:52-82` | `main` accepts direct pushes only from the admin, and the `coders` team may merge. `required_approvals:0`, so agents merge their own PRs. |
| Broken-`main` gate (fix-main only) | Implemented | `agensh/quality.py:18-26,116-162`, `agensh/team_run.py:836-924` | The author of the breaking merge is alerted first, the team after 15 minutes, and the gate lifts after 60. |
| Path-based peer review | Implemented | `agensh/quality.py:164-183`, `agensh/team_run.py:863-879` | Optional. An approval must come from someone other than the author, and a later change request withdraws it. |
| Claim to issue-assignee sync | Implemented | `agensh/backlog.py:1-47`, `agensh/team_run.py:788-817` | One-way. Removes only the assignees the driver added itself. |
| Durable per-worker event queue with retry | Implemented | `mini-router/sql/01_events_schema.sql`, `mini-router/src/state.ts:20-26,194-280`, `mini-router/src/dispatcher.ts` | Five attempts with backoff. Rows stuck in `sending` return to `pending` on reboot. |
| Idle watchdog and "publish something" nudge | Implemented | `agensh/team_run.py:648-710`, `mini-router/src/dispatcher.ts:151-166`, `mini-router/src/board_client.ts:131-148` | Idle time is judged from native session-log mtimes, and the watchdog needs `sudo`. |
| Pause, resume and finalize; token budget | Implemented | `agensh/team_run.py:926-1106`, `scripts/strip_metadata_proxy.py:35-47,280-283`, `prompts/lifecycle/*.txt` | At 100% of the budget the proxy returns HTTP 429. Resume starts fresh sessions and gives them a state summary. |
| Four harnesses (Copilot, Claude Code, Codex, Pi) | Implemented | `agent/claude/acp.py`, `agent/codex/acp.py`, `agent/pi/acp.py`, `agent/copilot/config.sh`, `mini-router/src/main.ts:36-39` | Each image holds one harness, and each harness is exposed over ACP. |
| Scaling to 1,024 agents | Unverified | `agensh.pdf` App. C ("16 nodes, with 64 agents per node") | The released code is single-node Compose only. Multi-node is a stated non-goal (`docs/task_pack_design.md:20-22`, `REPRODUCE.md:3`). |
| "Verify results" step | Partial | `board-service/verifier.py:1-2,46-56`, `tasks/*/templates/work_cycle.txt` | The board's "verifier" is a text check that rejects placeholder evidence such as "tbd" or "should pass". The file states "it does not execute the claimed tests" (`verifier.py:2`). Real verification is the Gitea CI gate. |
| Emergent roles (integrators, reviewers) | Unverified | `agensh.pdf` §3.2 | Reported from trajectories. No code supports roles, and none is expected to. |

## Architecture

```
host: agensh.team_run (Python driver, one per run)
  ├─ prepare/sync/export/evaluate hooks (task pack)
  ├─ background loops: watchdog, reminders, main_health, backlog_sync,
  │                    digest, token_watch, issue_watch, control_watch
  └─ docker compose profile
       ├─ gitea (+ actions runner)      shared workspace, issues, PRs, CI
       ├─ mattermost                    task channel + DMs
       ├─ mysql                         events queue, agent_kv, board_gists, cursors
       ├─ board-service (FastAPI)       shared context board
       ├─ secret-service                per-agent Gitea/Mattermost tokens
       ├─ egress-proxy                  model gateway: injects real key, meters, budgets
       ├─ egress-filter (optional)      domain allowlist for worker HTTP(S)
       └─ per worker i:
            mini-router-i (TS)  ← Gitea SSE + Mattermost WS → events → ACP prompt
            worker-i (harness)  ← ACP over Unix socket, MCP: gitea, mattermost, board
```

- Driver: `agensh/team_run.py:180-1247`. It seeds the repo (`push_seed`, `:349`), opens issue #1 (`:396`), wakes workers in a staggered sequence by Mattermost DM (`:589-629`), and runs the loops listed above.
- Compose generation: `tools/gen_compose_prod.py:2,19-24` adds one worker and router pair per agent, with per-worker CPU and memory limits (`:42-66`).
- Router: `mini-router/src/main.ts:86-234` wires a Gitea listener, a Mattermost listener, the dispatcher and a retry sweeper. Health reflects only the Gitea SSE connection (`:197-205`).
- Board: `board-service/main.py`. Schema in `mini-router/sql/03_board_schema.sql`, cursors and leases in `_MIGRATIONS` (`main.py:196-221`).
- Data model: the `events` table (`dedup_key`, `agent`, `payload`, `state`, `attempts`, `next_retry_at`, `batch_id`), `board_gists` (`board_id`, `thread_id`, `type`, `content`, `expires_at`, `delegation_id`, `detail`), `board_cursor(agent, board_id, gist_id)`, `shown(event_id, agent)` and `pending_leases(agent, lease_token, lease_until)`.

## How agents are connected and managed

The interface between Agensh and the agent is ACP (Agent Client Protocol) over a Unix socket. `agent/acp_bridge.py:1-40` serves one connection at a time and starts the harness as UID 10000, refusing to run it as root (`:23-24`). A disconnect cancels the active prompt. Copilot speaks ACP natively. Claude Code, Codex and Pi have adapters:

- `agent/claude/acp.py` drives `claude` in stream-json mode with `--permission-mode bypassPermissions` (`:60`) and keeps the session for resume.
- `agent/codex/acp.py` bridges Codex app-server to ACP. `agent/pi/acp.py` bridges Pi RPC to ACP.
- `agent/check_harness.py` rejects images that contain the wrong harness or more than one.

The router keeps one persistent ACP session per worker. The session id is stored in MySQL `agent_kv` under `acp_session_id:<harness>` (`mini-router/src/main.ts:104-113`), so a router crash restores the same native session. A planned resume deletes those keys so that every worker starts a fresh session (`agensh/team_run.py:545-552`).

The dispatcher serialises turns. A turn is a batch of up to 32 queued events grouped into one prompt (`mini-router/src/dispatcher.ts:51-74`). The unread board snapshot is prepended as `==== SHARED CONTEXT ====` (`dispatcher.ts:134-144`, `board_client.ts:26-60`). Events that arrive during a turn wait for the next one. The only exceptions are DMs, urgent product-owner events and new peer board entries, which the shim appends to MCP tool results.

To add a harness you write a `config.py` and an ACP adapter under `agent/<name>/`, add it to the router's `agentKind` union (`mini-router/src/main.ts:18,37`) and to `SESSION_DIRS` for the watchdog (`scripts/team_status.py:22-23`), and build an image. There is no plugin interface. It is a short code change in four places.

Lifecycle: the driver starts worker containers one by one (`AGENSH_STAGGERED_BRINGUP`), waits 20 s, and sends a wake DM. The stagger is 30 s for the first hour, then 3 s (`agensh/schedule.py:25-28`). The paper gives the reason as "to reduce scope contention" (App. C).

## Models, tools, subscriptions and environments

- **No subscriptions.** Every harness is pointed at one model gateway (`LLM_UPSTREAM` in `~/.agensh/upstream.env`). Workers hold a dummy key (`local-proxy-<agent>`). The egress proxy injects the real credential (`docker/docker_compose.team.yml:27-52`, `scripts/strip_metadata_proxy.py:14-20`). Copilot is configured as an OpenAI-compatible provider, and its GitHub tokens are unset (`agent/copilot/config.sh:38-52`). Claude Code needs the Messages API, the others the Responses API.
- **Per-worker model override** by request rewriting (`AGENSH_AGENT_MODELS`, `strip_metadata_proxy.py:26`). The gateway must serve the same wire API.
- **Tools.** Each worker gets three MCP servers: Gitea (upstream `gitea-mcp`), Mattermost and the board (`board-service/mcp.cjs`). They are cut down by an allowlist (`agent/config/mcp_allowed_tools.json`) and a denylist (`agent/config/mcp_deny_tools.json`). The denylist removes, for example, `create_branch`, `create_or_update_file` and `fork_repo`, so code moves through git rather than API file writes. Claude Code's native tools are limited to `Bash, Read, Write, Edit, Glob, Grep, NotebookEdit, Skill, Todo/Task*` (`agent/claude/config.py:13-15`). The proxy strips `request_user_input` from tool declarations (`docker_compose.team.yml:37`), so a worker cannot stop and ask the operator.
- **Isolation.** One container per worker, each with its own HOME and `/work` clone, running as a non-root UID with cgroup memory and CPU limits (`tools/gen_compose_prod.py:42-66`, `docker/agensh.slice`). The default network is `internal: true`. Only the egress proxy and the edge proxy can reach outside (`docker/docker_compose.team.yml:1-25`). Worker internet access is `open`, `allowlist` (through `scripts/egress_filter.py`) or `offline`. Inside its container the agent runs with bypassed permissions.
- **Credentials.** `secret-service/main.py` serves per-agent Gitea and Mattermost tokens to routers on the private network, behind an `X-Internal-Auth` shared secret. The host's `gh` credentials for delivery never enter containers (`docs/acceptance_testing.md` "Delivery").

## Context and memory scoping

| Scope | What | Enforcement |
|---|---|---|
| Private to a worker | Native session (HOME), `/work` checkout, unshown event queue | Separate container and volume per worker; the queue is keyed by `agent` |
| Shared in the team | Board, Gitea repo, issues and PRs, Mattermost channel and DMs | Board membership via `BOARD_MEMBERS_JSON` (`board-service/main.py:28-34,156-169`) |
| Per-reader state | Which board entries a worker has seen | `board_cursor` advanced with `GREATEST` so it never moves back (`main.py:248-259`) |
| Cross-run | Nothing, apart from the repository, issues and board when a resumable run resumes | `prompts/lifecycle/before_pause.txt`: "anything not in the repository, the issues or the board is lost" |

Claude's auto memory is turned off (`agent/claude/config.py:55`, `autoMemoryEnabled: False`), so shared state lives only in the infrastructure.

The board boundary is weak. `_authorize` trusts the `thread_id` or `viewer` value the caller sends, with the comment "uses the caller's identity within the private service network" (`board-service/main.py:156-169`). The MCP wrapper fills that value from `AGENT_NAME` (`board-service/mcp.cjs:14,132`). But a worker has a shell and curl ("whatever is at hand is fine", `prompts/agents.txt:75`) and can reach `board-service:8660` directly, so it could write a CLAIM or FAIL in a peer's name. Nothing in the source prevents that.

## Identity, permissions and autonomous execution

- **Agent identity.** Each worker has its own Gitea user in the `coders` team and its own Mattermost user. Both are created by bootstrap, and their tokens are held by the secret service. Git provenance and PR authorship are therefore per agent, so `breaking_change` can find who merged a failing commit (`agensh/team_run.py:824-834`).
- **Human identity.** There is an optional single product owner (`AGENSH_HUMAN`) with a Gitea and Mattermost account. Their DMs, mentions and comments are marked urgent and delivered mid-turn (`mini-router/src/listeners/mattermost/notification.ts:113-127`, `listeners/gitea/listener.ts:70`). With a product owner, CODEOWNERS on protected paths makes them the only approver, and only they can end the run by closing issue #1. A worker's close is reopened (`agensh/team_run.py:1002-1024`). More than one human is a non-goal (`docs/task_pack_design.md:20-28`).
- **Autonomy.** Fully unattended inside the container: bypassed permissions, no human-input tool, a task brief stating "there is NO human to ask" (`tasks/software-project/prompts/task_brief.txt:7-9`). The safety floor is structural: network isolation, protected files changeable only by admin or owner, CI-gated merges, delivery as an unmerged upstream PR, and a token budget.
- **Audit.** Git history, Gitea events, the per-request usage log (`usage.jsonl`), the egress log (`egress/egress.jsonl`), `main-health.json`, `run_state.json`, digests and the board lifecycle export. There is no single audit stream that ties actions to approvals, because there are no approvals.

## Coordination of tasks and dependencies

The core of the assignment, mechanism by mechanism.

**Form of a claim.** A row in `board_gists` with `type='CLAIM'`. Its `content` is free text of at most 100 characters (`shared_lessons.py:15,70-74`). It also carries an optional `delegation_id` (a self-chosen work label) and `expires_at = now + ttl`. The TTL is the server default `BOARD_CLAIM_TTL_SECONDS` of 3600 s (`main.py:42,483-487`). The HTTP API accepts `ttl_seconds`, but the MCP tool does not expose it (`mcp.cjs:130-137`), so agents always get one hour. The software-project prompt asks for the shape `CLAIM #7: add the --json flag` (`templates/work_cycle.txt:2-5`). ProgramBench claims name an "area" (`tasks/programbench/prompts/work_cycle.txt:2`).

**Where claims are stored.** MySQL `board_gists` is append-only. The in-memory `SharedLessons._entries` holds a window of 2000 entries (`shared_lessons.py:17,142-144`). On restart, history is replayed through the same admission rules (`main.py:98-134`).

**Conflict detection and resolution.** No code compares claims. The board does not reject or flag a second claim on the same issue or area. Duplicates are not merged for claims either (`_dedupe_entries` keeps every claim as its own entry, `shared_lessons.py:333-341`). Detection is left to the reader. Active claims are rendered at the start of each turn, and a new peer claim reaches a worker mid-turn. The prompt then says: a `CLAIM` on what you are building is "a collision; settle it by direct message", and any other claim means "keep building" (`prompts/agents.txt:62-67`). Resolution is negotiation over Mattermost DM, which "interrupts what they are doing" (`agents.txt:16-20`). The paper describes it the same way: "they are encouraged to resolve the issue through direct messages" (§2.1).

**Expiry and abandoned work.** Expiry only hides a claim. `_select_entries` filters expired claims out of the view (`shared_lessons.py:345-356`), and the row stays in history. There is no heartbeat. Renewal means writing a new CLAIM ("renew the claim if you need longer", `work_cycle.txt:4-5`), and the forced-write nudge reminds the worker to "refresh your CLAIM" after any turn that published nothing (`board_client.ts:136-137`). Expiry does nothing to branches or PRs. With the issues backlog, an expired claim removes the assignee the driver set (`backlog.py:35-47`). After a pause, the resume prompt warns "earlier claims may be stale" (`prompts/lifecycle/resume.txt:9`).

**How a worker decides what to do next.** In the prompt, not in code: "read issue #1, the open issues and the board, and pick an open issue nobody has claimed. If the piece of the goal you want has no issue yet, open one for it" (`templates/work_cycle.txt:1-2`). When idle: "look at the open issues, the board and main for gaps, untested paths or failing checks, claim one and close it" (`software-project/prompts/idle.txt`). An optional planning phase lets worker 1 write `ARCHITECTURE.md` and one issue per PR-sized piece before the others wake (`prompts/planning.txt`, `team_run.py:472-491`). There is no priority field and no dependency field. Dependencies are left to messages ("negotiate dependencies", paper §2.2) and to issue text.

**Duplicate effort.** Prevention is soft. Measures in source:
1. Claims are visible at turn start and pushed mid-turn.
2. `FAIL` entries ("the highest-value entry: it stops peers spending budget on it", `agents.txt:27-28`), with "do not retry something recorded as FAIL" repeated at turn start (`board_client.ts:53-56`).
3. Staggered wake-up to reduce "scope contention".
4. A refined `PATCH_SUMMARY` with the same `delegation_id` replaces the author's earlier one in the view, and a later `FAIL` with that id marks it `invalidated` (`shared_lessons.py:92-142`).

Measurement covers only board text: exact and anchor-based dedup counts (`_dup`, `written_count`) and render counts in the lifecycle export (`shared_lessons.py:437-480`). Neither the paper nor the code reports how much code work was duplicated or how many claims collided.

**Merge and verification flow.**
1. Branch from the latest `main` and implement. "You do not need to sync code with others during implementation."
2. Run the PR checks locally.
3. Push and open a PR. Gitea Actions runs `agensh / pr`.
4. Merge when green, with `merge_when_checks_succeed`. If the merge is refused, merge `main` into the branch, re-run the checks and push.
5. Post a `PATCH_SUMMARY` of the form `files= | idea= | evidence=`.

(`templates/work_cycle.txt:3-15`.) Branch protection lets the `coders` team merge with zero approvals and blocks direct pushes (`bootstrap.sh:281-310`). Required checks are `agensh / pr` and `agensh/main-health`, plus `agensh/review` when review paths are set. Text merge conflicts are detected by git. Semantic breakage shows up as a red full suite on `main`.

**Failure recovery.**
- Broken `main`. `HealthGate.observe` takes the state of `agensh / main` on the head of `main` (`quality.py:132-151`). The breaking PR's merger receives `broken.txt` alone, "so the team does not converge on one failure" (`team_run.py:845-847`). A `FAIL` entry goes on the board, and open PRs get `pending` unless they are fix-main. The whole team is alerted at 15 minutes, and the gate lifts at 60 so that "a flaky suite cannot stall the team" (`agensh/README.md`).
- Delivery failures. ACP prompt errors mark events `failed`, with a backoff over five attempts. Router reboot returns `sending` rows to `pending` (`state.ts:194-280`).
- Silent workers. A 10-minute idle detector DMs the worker unless its queue still has rows (`team_run.py:683-710`).
- Upstream sync conflicts become an issue for the team, "never forced" (`tasks/software-project/hooks/sync.py:6,41-49`).
- Driver failure or SIGTERM. The driver quiesces, exports and archives (`team_run.py:1141-1200`).

**Asking for help.** There is no structured request. A worker posts in the channel or sends a DM. The paper says the message interface lets workers "request assistance in a timely manner" (§2.2). The paper's examples of help are emergent: an integrator chosen from several who answered, and a takeover "after another worker's attempt fails" (§3.2). Asking the human is cut off, because `request_user_input` is stripped unless a product owner exists, and even then the owner is reached only through the chat.

**Failure modes and coordination overhead reported.** The paper has no failure-mode or overhead section. It does not report token cost per agent, collision counts or wasted work. What it does report, and what the code implies:
- staggered activation "to reduce scope contention" (App. C)
- the observation that "a single-agent run can rarely sustain the full 6-hour runtime" (App. C), which is why idle nudges and stop hooks exist
- workers revising their integration protocol "after some failures" (§3.2)
- gains that flatten with scale: mean pass rate 19.31 → 20.68 → 26.52 → 28.78% at 1, 8, 32 and 128 agents. At 128 agents, roughly 128 times the compute buys about 9.5 points.

The code also implies two problems the authors met. The forced-write nudge (`dispatcher.ts:151-166`) and the "do not publish a placeholder" guidance mean that low-value board writes and silent turns happened. The fix-main lift at 60 minutes means flaky suites stalled teams.

## Collaboration between different human owners

None. One operator owns the host, the Gitea and Mattermost admin accounts, the model gateway key and every agent. Only one human role exists, the product owner, and "more than one human product owner per project" is a non-goal (`docs/task_pack_design.md:20-28`). All services sit on one Docker network. The 1,024-agent run used 16 nodes, but the released code has no multi-node transport (`REPRODUCE.md:3`). The only link to the outside world is delivery: `main` is pushed to `agensh/<run-id>` on GitHub and a PR is opened for humans to review (`tasks/software-project/hooks/export.py:168-183`).

## Verification and acceptance of outcomes

- **Per PR:** the pack's fast checks as the required Gitea status `agensh / pr`. The workflow is generated by `quality.render_workflow` (`quality.py:52-82`) and uses `run:` steps only, so it needs no internet.
- **Per merge:** the full suite as `agensh / main`, enforced through `agensh/main-health` on every open PR.
- **Protected paths:** CI workflows, `.agensh/` and `protected_paths` are Gitea protected files. With no product owner only the admin can change them, which means never during a run (`team_run.py:738-759`). That stops agents weakening their own tests.
- **Peer review:** optional and path-based (`quality.py:164-183`).
- **Board "verification":** a lexical filter on `evidence=` (`board-service/verifier.py`) that rejects placeholders. A PATCH_SUMMARY counts as a "verified" checkpoint when its evidence contains words such as "passed", "verified" or "now returns" (`shared_lessons.py:30-33,157-166`). Its text says verified, but nothing executes the evidence.
- **Final acceptance:** `acceptance.final` or `acceptance.main` runs on the delivered head, with a held-out `private_dir` mounted only for the final commands (`tasks/software-project/README.md`). The upstream PR is opened and never merged, so a human accepts.

## Install to first useful result

As documented (`docs/acceptance_testing.md`, `REPRODUCE.md:42-61`):

1. A Linux host with Docker Engine, Compose v2, systemd, cgroup v2, passwordless `sudo` for Docker, Python 3.11+, git, curl, jq and envsubst. Install the `agensh.slice` memory slice and the reboot-guard unit as root. Each worker defaults to 64 GiB of memory.
2. A model gateway URL and token in `~/.agensh/upstream.env`. Claude Code needs a Messages-API endpoint; the others need Responses. Subscription logins are not used.
3. Build the shared images: agent base, mini-router, board, secret service and bootstrap. The first build needs `docker.gitea.com`.
4. For a real repository: write `.agensh/project.toml` (goal, upstream, PR and main check commands, workers, budget, network), log in with `gh auth login` for delivery, then run `python3 -m agensh.project build|profile|run`.
5. Optional checks: unit tests, then the about-12-minute smoke test with two scripted workers. A live run with two Copilot workers on a small CLI feature used "about 2M" tokens.

There is no macOS path. It needs root on a Linux host.

## For Botbench

### Learn

- A claim protocol can stay advisory if two cheap things surround it. First, readers must see claims at the moment they decide, here at every turn start and mid-turn. Second, the one shared resource that matters, `main`, must be guarded by a hard gate. Agensh puts no exclusivity in claims at all and leans on git and CI to catch what slips through.
- Negative results are the most valuable shared memory. `FAIL` exists "so peers skip it". Botbench has nothing like it between workbenches.
- For a broken shared branch, alert the one person who broke it first and the whole team only later. This stops N agents converging on one failure.
- Fixed TTLs with renew-by-rewrite work inside one controlled swarm, where every agent is prompted and nudged the same way. They do not carry over to independent owners, whose agents keep different hours and follow different prompts.

**Transfer to a few developers' workbenches over GitHub:**

| Agensh element | Transfers? | Why |
|---|---|---|
| Claim cites an issue; one-way claim → assignee sync (`agensh/backlog.py`) | Yes | Same model as Botbench's issue claims. Showing the holder as a GitHub assignee is visible to people without Botbench. |
| Claim TTL plus renewal, stale claims hidden rather than deleted (`shared_lessons.py:345-356`) | Yes, adapted | Botbench already shows the claim's age and offers Take over after an hour. A renewal heartbeat (re-pushing or updating the claim) would separate an abandoned claim from a long one. |
| Fix-main gate with author-first alerting and a time-boxed lift (`quality.py:116-162`) | Yes | Fits branch protection and status checks on GitHub. Each workbench can post or read a shared status. |
| Typed findings, especially FAIL with a work label (`shared_lessons.py:92-142`) | Partly | Useful between owners as structured comments on the issue or PR. A shared board service needs a trust model Agensh does not have. |
| Collision settled by mid-turn DM (`agents.txt:16-20`) | Partly | Between owners this becomes a workbench-to-workbench message (ADR 0004). Interrupting another person's agent mid-turn needs that person's consent. |
| Advisory, non-exclusive claims | No | Two developers' agents duplicating hours of work costs more than a swarm member's few minutes. Botbench's earliest-claim-wins branch push is stronger, and should stay. |
| Self-declared identity on the board (`main.py:156-169`) | No | It only works because every caller sits on one private network owned by one operator. |
| Zero-approval self-merge by agents (`bootstrap.sh:297`) | No | Acceptable for a swarm with a final human-reviewed upstream PR. Between owners, merging into a shared `main` needs the other owner's review. |
| Staggered wake, idle nudges, forced-write nudges | No | These are swarm throughput tools. A workbench owner starts runs deliberately. |

### Reuse conceptually (with source references)

MIT licence: Botbench may adapt and even copy code, as long as it keeps the copyright and licence notice for copied portions. The items below are patterns only.

1. **Health gate as a pure state machine.** `HealthGate.observe` takes the state, sha and time and returns actions (`agensh/quality.py:116-162`, thresholds `:25-26`). The timing rules can then be tested without a forge. For Peers, one shared "main is red, only fix PRs" status that every workbench honours.
2. **Claim → assignee sync that removes only its own assignments.** `Assignments.managed` (`agensh/backlog.py:26-47`). Botbench could mirror a live claim as a GitHub assignee or label without ever undoing what a human set.
3. **Never-backwards read cursor plus lease for at-most-once mid-turn delivery.** `GREATEST(gist_id, ...)` (`board-service/main.py:248-259`) and the token-checked lease release (`:262-295`). These apply directly to delivering peer messages to a running Botbench agent (ADR 0004).
4. **Work label linking revisions and refutations.** A newer PATCH_SUMMARY with the same `delegation_id` replaces the old one, and a FAIL marks it invalidated (`board-service/shared_lessons.py:92-142`). This maps onto issue-number-keyed status updates from a peer workbench.
5. **Board unreachable rendered as "UNKNOWN, not empty".** `mini-router/src/board_client.ts:40-51`. Botbench's Other workbenches panel should say the same when GitHub cannot be read, instead of showing no claims.
6. **Durable event queue with per-agent dedup key and recovery on reboot.** `mini-router/sql/01_events_schema.sql:3-20`, `state.ts:271-280`.

### Improve on

- **Claims have no exclusivity and no conflict check.** The server admits overlapping claims (`shared_lessons.py:333-341`), and resolving them costs model turns and interrupts both agents. Botbench's atomic claim-branch push, where the remote refuses the second claim, prevents the collision instead of negotiating it.
- **Board identity is self-asserted** (`board-service/main.py:156-169`) while agents have shell access. Botbench can sign peer messages, or bind them to the GitHub identity that pushed the claim.
- **"Verified" is a word match** (`shared_lessons.py:30-33,157-166`, `verifier.py:2`). Botbench delivers evidence from actually running the checks and can point at it, rather than trusting the agent's description.
- **No duplicate-work metric.** Only text-dedup and render counts exist (`shared_lessons.py:437-480`). Botbench could measure collisions directly: claims refused, takeovers, PRs closed as duplicates.
- **Agents run with bypassed permissions and no human-input tool** (`agent/claude/acp.py:60`, `docker_compose.team.yml:37`). Botbench's broker and approvals are a different, owner-controlled stance.
- **Linux root host, single owner, one API gateway.** There is no Mac path, no subscription use and no remote or phone control. Botbench already beats this on time to first result for an individual developer.

### Deliberately avoid

- Putting the coordination protocol only in prompt text, with the runtime nudging agents to follow it. It cannot be audited or enforced across owners whose agents run different prompts.
- One-hour fixed TTLs hidden from the agent's control (`mcp.cjs` does not expose `ttl_seconds`), and expiry that hides a claim while its branch and PR remain.
- Lifting a safety gate on a timer without asking a human (`LIFT_AFTER`). Between owners, unblocking a shared `main` should be an explicit decision.
- Measuring success by throughput at scale (agents × hours). Botbench's North Star is a few owners coordinating with less human effort, not 1,024 agents.

## Capability ratings

1. byo-agent-clis: Partial. Copilot, Claude Code, Codex and Pi run in containers, but only against an API gateway; subscription logins are stripped.
2. model-providers: Partial. Any gateway speaking the Responses or Messages API, with per-worker model rewrites; one gateway per run.
3. tools-connectors: Implemented. Gitea, Mattermost and board MCP servers with allow and deny lists (`agent/config/`); no general connector system.
4. isolation: Implemented. A container per worker, non-root UID, cgroup limits, internal network with an egress proxy and optional domain allowlist.
5. approvals: Absent. Bypassed permissions and no human-input tool; protected paths and a product-owner review only on chosen paths.
6. memory-scoping: Partial. Private container and session per worker, a shared board with membership, but the board trusts the identity the caller asserts.
7. identity-authz: Partial. A Gitea and Mattermost account per agent and a secret service for tokens; one human owner; board auth is self-asserted.
8. task-coordination: Partial. Advisory TTL claims, mid-turn notices, FAIL board, claim → assignee sync; no exclusivity, dependencies or conflict detection in code.
9. cross-owner: Absent. One operator owns everything; a second human is a non-goal.
10. peer-transport: Absent. Single-node Compose network; multi-node is a non-goal in the released code.
11. verification: Implemented. Required PR checks, full suite on `main` with the fix-main gate, protected tests, optional peer review, final acceptance; the board's "verified" is lexical only.
12. durability: Implemented. MySQL event queue with retry and reboot recovery, session restore, pause and resume with a state summary, archive validation.
13. budgets-usage: Implemented. Per-request usage metering per agent, team token budget with a 90% warning and a 429 at 100%, wall-clock budget.
14. audit-observability: Partial. Usage, egress, health, run-state logs, digests, `team_status.py`; no unified audit trail and no dashboard.
15. remote-mobile: Partial. Mattermost and Gitea web UIs reachable through the nginx edge give an owner remote chat and review; no dedicated remote control.
16. time-to-first-result: High effort. Needs a Linux host with root, systemd units, several image builds and a model gateway; no Mac or subscription path.

## Open questions

- How often do two workers claim the same issue or area, and how many turns and tokens does a DM resolution cost? Only run logs would show this.
- Do workers renew claims, or do most claims simply lapse after an hour while the PR is still open?
- How often do workers forge or misattribute board entries through direct HTTP? Is it ever observed?
- How much of a 4-agent software-project run is spent on board writes forced by the nudge?
- Does the fix-main lift at 60 minutes let real regressions through in practice?
- How did the 16-node, 1,024-agent deployment share Gitea, Mattermost and the board? Is that code anywhere outside this release?
