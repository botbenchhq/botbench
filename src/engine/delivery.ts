import type { DatabaseSync } from "node:sqlite";
import { appendLog } from "../approvals/broker.ts";
import { repositoryDelivery, type Config } from "../config.ts";
import { ghArgs, githubRepoOf, redact, repoName, type GitHub, type PullRequest, type RepoRef } from "../github.ts";
import { now, transaction } from "../store/db.ts";
import { branchCommit, BRANCH_PREFIX, pushTaskBranch, remoteAddress, remoteBranchCommit } from "../worktrees.ts";
import { onTaskAccepted, taskDecision } from "./decision.ts";
import { taskReview } from "./review.ts";
import type { Delivery } from "./run.ts";
import { taskEvidence } from "./stations.ts";
import { MODE_WORDS, isRunMode } from "./modes.ts";
import { getTask, TaskError, words, type Task } from "./task.ts";
import { runIssue } from "./intake.ts";

/*
 * Delivery: an accepted task's branch pushed, and a pull request opened for it, by Botbench itself on this Mac with the
 * owner's own `git` and `gh` (src/github.ts). Agents never do this: their commands are confined and cannot push, and
 * nothing an agent wrote can start it. It starts only from the owner's choice: a run started with "Open a pull request",
 * whose task was just accepted (the decision's listener, below), or the owner's own "Open a pull request" on an
 * accepted task whose branch was kept.
 *
 * What is sent: the task's branch, at the commit recorded at the decision, to the branch of the same name on the
 * repository's remote (`origin` unless its settings name another), never by force; then one pull request into the
 * base branch (the settings' `baseBranch`, else the repository's default on GitHub), with a title and a body made from
 * the task. Never a merge, never the base or default branch, never another ref, never a remote branch deleted.
 *
 * Exactly once. Every check is made before anything is sent, each with a plain refusal. Then the ledger (`deliveries`,
 * append-only) gets the request before the push, the push, and the pull request. A delivery started again (Try again,
 * or after a restart) asks the remote what its branch holds and pushes only when the remote lacks it, and asks GitHub
 * for a pull request of the branch in any state before it opens one, so a second is never opened; the store refuses a
 * second pull request for one task too. A failure is recorded in plain words; the task stays accepted whatever happens.
 */

export type DeliveryStepKind = "requested" | "pushed" | "opened" | "failed";
export interface DeliveryStep {
  id: number;
  taskId: number;
  step: DeliveryStepKind;
  requestedBy: "owner" | "run" | null;
  remote: string | null;
  repository: string | null;
  base: string | null;
  branch: string | null;
  headCommit: string | null;
  url: string | null;
  number: number | null;
  adopted: boolean | null;
  /** The pull request's state as GitHub gave it when it was opened or found: OPEN, CLOSED or MERGED. */
  prState: string | null;
  failedStep: "check" | "push" | "pull_request" | null;
  detail: string | null;
  createdAt: string;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A task's delivery ledger, oldest first. */
export function deliverySteps(db: DatabaseSync, taskId: number): DeliveryStep[] {
  return db.prepare("SELECT * FROM deliveries WHERE task_id = ? ORDER BY id").all(taskId).map((row) => ({
    id: Number(row.id),
    taskId: Number(row.task_id),
    step: String(row.step) as DeliveryStepKind,
    requestedBy: text(row.requested_by) as DeliveryStep["requestedBy"],
    remote: text(row.remote),
    repository: text(row.repository),
    base: text(row.base),
    branch: text(row.branch),
    headCommit: text(row.head_commit),
    url: text(row.url),
    number: typeof row.number === "number" ? row.number : null,
    adopted: typeof row.adopted === "number" ? row.adopted === 1 : null,
    prState: text(row.pr_state),
    failedStep: text(row.failed_step) as DeliveryStep["failedStep"],
    detail: text(row.detail),
    createdAt: String(row.created_at),
  }));
}

/** What the run of a task chose for its accepted tasks; a task started on its own keeps its branch. */
export function runDelivery(db: DatabaseSync, task: Task): Delivery {
  if (task.runId === null) return "branch";
  const row = db.prepare("SELECT delivery FROM runs WHERE id = ?").get(task.runId);
  return row?.delivery === "pull_request" ? "pull_request" : "branch";
}

/**
 * A task's pull request as a client sees it: what its run chose (`choice`), and where the delivery stands: `none`
 * (nothing asked yet), `sending` (asked, not finished), `opened` (with the pull request's number and address), or
 * `failed` (with what went wrong, in words).
 */
export interface DeliveryView {
  choice: Delivery;
  state: "none" | "sending" | "opened" | "failed";
  number: number | null;
  url: string | null;
  /** The pull request was already there and was taken as this task's, not opened again. */
  adopted: boolean;
  /** OPEN, CLOSED or MERGED, as GitHub said when it was opened or found. */
  prState: string | null;
  /** The branch was pushed to the remote, whatever came after. */
  pushed: boolean;
  repository: string | null;
  base: string | null;
  remote: string | null;
  branch: string | null;
  problem: string | null;
  at: string | null;
}

export function deliveryOf(db: DatabaseSync, task: Task): DeliveryView {
  const steps = deliverySteps(db, task.id);
  const opened = steps.find((s) => s.step === "opened");
  const last = opened ?? steps.at(-1);
  const asked = [...steps].reverse().find((s) => s.step === "requested");
  const state = last === undefined ? "none" : last.step === "opened" ? "opened" : last.step === "failed" ? "failed" : "sending";
  return {
    choice: runDelivery(db, task),
    state,
    number: opened?.number ?? null,
    url: opened?.url ?? null,
    adopted: opened?.adopted === true,
    prState: opened?.prState ?? null,
    pushed: steps.some((s) => s.step === "pushed"),
    repository: asked?.repository ?? null,
    base: asked?.base ?? null,
    remote: asked?.remote ?? null,
    branch: asked?.branch ?? task.branch,
    problem: state === "failed" ? last!.detail : null,
    at: last?.createdAt ?? null,
  };
}

/** A check that failed before anything was sent, or a step that failed: `step` says which. */
class DeliveryFailure extends Error {
  readonly step: "check" | "push" | "pull_request";
  constructor(step: "check" | "push" | "pull_request", message: string) {
    super(redact(message));
    this.step = step;
  }
}

/** Where an accepted task would go: its remote, the remote's address with any credentials taken out, and the base branch if the settings name one. */
export interface DeliveryTarget {
  remote: string;
  address: string;
  repository: string | null;
  branch: string;
  base: string | null;
}

/** A fenced block of text a reader sees as it is: no mention, link, image or closing keyword in it does anything. */
function fenced(body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${body.replace(/\s+$/, "")}\n${fence}`;
}

const VERDICT: Record<string, string> = { looks_right: "Verdict: looks right", concerns: "Verdict: concerns" };

/**
 * The title and body of a task's pull request, made from what is stored. Everything an agent, a planner or the owner
 * wrote goes in fenced blocks, as data. For a run started from a GitHub issue the body closes that issue, the one line
 * Botbench writes from it: built from the stored number and repository alone, `Closes #N` on the issue's own repository
 * (`repo`, where the pull request is opened) and `Closes owner/name#N` elsewhere. Nothing the issue says is in the body.
 */
export function pullRequestText(db: DatabaseSync, task: Task, repo?: RepoRef): { title: string; body: string } {
  const plan = db.prepare("SELECT title, criteria FROM plan_tasks WHERE task_id = ?").get(task.id);
  let criteria: string[] = [];
  if (plan) {
    try {
      const parsed: unknown = JSON.parse(String(plan.criteria));
      if (Array.isArray(parsed)) criteria = parsed.filter((c): c is string => typeof c === "string");
    } catch {
      criteria = [];
    }
  }
  const title = plan ? String(plan.title) : task.prompt.trim().split("\n")[0]!;
  const checks = taskEvidence(db, task.id).filter((e) => e.kind === "check");
  const round = Math.max(0, ...checks.map((e) => e.round));
  const latest = checks.filter((e) => e.round === round);
  const review = taskReview(db, task.id);
  const run = task.runId === null ? undefined : db.prepare("SELECT * FROM runs WHERE id = ?").get(task.runId);
  const mode = isRunMode(run?.mode) ? MODE_WORDS[run.mode] : null;
  const parts = [
    "Built with Botbench: an accepted task, pushed and opened by Botbench on the owner's machine. Nothing was merged.",
    "## What was asked",
    fenced(plan ? String(plan.title) : task.prompt),
  ];
  if (criteria.length > 0) parts.push("## Acceptance criteria", fenced(criteria.map((c) => `- ${c}`).join("\n")));
  parts.push("## Checks", latest.length === 0 ? "No checks are set up for this repository." : fenced(latest.map((e) => `${e.outcome === "passed" ? "passed" : e.outcome === "timed_out" ? "timed out" : e.outcome}  ${e.command}`).join("\n")));
  if (review !== null) {
    const line = review.outcome === "reviewed" ? (review.verdict === null ? "No verdict in the asked form" : VERDICT[review.verdict]!) : `No review: ${review.problem ?? review.outcome}`;
    parts.push("## Review", `A model's opinion, not a check: ${review.agent}${review.model === null ? "" : ` (${review.model})`}.`, fenced(line));
  }
  if (mode !== null) parts.push("## Mode", fenced(mode));
  const issue = runIssue(db, task.runId);
  if (issue !== null) {
    const [, owner, name] = issue.repository.split("/");
    const here = repo !== undefined && repoName(repo).toLowerCase() === issue.repository.toLowerCase();
    parts.push("## Issue", `Started from a GitHub issue. Closes ${here ? "" : `${owner}/${name}`}#${issue.number}`);
  }
  parts.push(`Task ${task.id} · branch \`${task.branch}\` · commit \`${taskDecision(db, task.id)?.headCommit ?? task.headCommit}\``);
  return { title, body: `${parts.join("\n\n")}\n` };
}

export interface DeliveryOptions {
  db: DatabaseSync;
  config: Config;
  github: GitHub;
  /** Called after each step is recorded, so screens read the task again. */
  onTaskChange: (task: Task) => void;
}

export interface Deliveries {
  /**
   * Deliver an accepted task, in the background. Refused (TaskError), with nothing sent or recorded, for a task that is
   * not accepted, whose branch was deleted, whose pull request is open already, or that is being delivered now; and,
   * when `expect` is given, when the remote or branch is not the one the owner was shown.
   */
  deliver(taskId: number, o: { by: "owner" | "run"; expect?: { remote: unknown; branch: unknown; address?: unknown } }): void;
  /** Where an accepted task would be pushed, read from the repository (no network); null when it cannot be delivered. */
  target(task: Task): Promise<DeliveryTarget | null>;
  /** Whether a delivery of the task is under way in this process. */
  busy(taskId: number): boolean;
  /** Resolves when no delivery is under way. */
  idle(): Promise<void>;
  /** Stop taking new deliveries, and wait for those under way. */
  close(): Promise<void>;
}

export function createDeliveries(options: DeliveryOptions): Deliveries {
  const { db, config, github } = options;
  const running = new Map<number, Promise<void>>();
  let closed = false;

  const announce = (taskId: number): void => {
    try {
      options.onTaskChange(getTask(db, taskId)!);
    } catch (err) {
      console.error(`Announcing task ${taskId}'s delivery failed: ${words(err)}`);
    }
  };
  /** One step into the ledger and the action log, in one write. Nothing in it is unredacted text from git or gh. */
  const record = (task: Task, step: Omit<Partial<DeliveryStep>, "id" | "taskId" | "createdAt"> & { step: DeliveryStepKind }, said: string): void => {
    const at = now();
    transaction(db, () => {
      db.prepare("INSERT INTO deliveries (task_id, step, requested_by, remote, repository, base, branch, head_commit, url, number, adopted, pr_state, failed_step, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        task.id, step.step, step.requestedBy ?? null, step.remote ?? null, step.repository ?? null, step.base ?? null, step.branch ?? null, step.headCommit ?? null, step.url ?? null, step.number ?? null, step.adopted === undefined || step.adopted === null ? null : step.adopted ? 1 : 0, step.prState ?? null, step.failedStep ?? null, step.detail === undefined || step.detail === null ? null : redact(step.detail), at,
      );
      appendLog(db, { taskId: task.id, runId: task.runId, attemptId: task.attemptId, rule: "delivery", tool: "Branch", command: task.branch ?? "", cwd: task.repo, detail: redact(said) });
    });
    announce(task.id);
  };

  /** Refusals that need nothing but the store: checked before a delivery starts, and again when it does. */
  const deliverable = (taskId: number): { task: Task; commit: string } => {
    const task = getTask(db, taskId);
    if (!task) throw new TaskError(404, "No such task.");
    if (task.status !== "accepted") throw new TaskError(409, `Task ${task.id} is not accepted, so no pull request is opened for it. Only an accepted task's branch is pushed.`);
    const decided = taskDecision(db, task.id);
    if (decided === null || decided.branch !== "kept" || decided.headCommit === null) throw new TaskError(409, `Task ${task.id}'s branch was not kept, so there is nothing to push.`);
    if (deliverySteps(db, task.id).some((s) => s.step === "opened")) throw new TaskError(409, `Task ${task.id} already has its pull request, so no second one is opened.`);
    return { task, commit: decided.headCommit };
  };

  const target = async (task: Task): Promise<DeliveryTarget | null> => {
    if (task.branch === null) return null;
    const { remote, baseBranch } = repositoryDelivery(config, task.repo);
    const address = await remoteAddress(task.repo, remote).catch(() => null);
    if (address === null) return null;
    const repo = githubRepoOf(address.configured) ?? githubRepoOf(address.push);
    // A remote that is not on GitHub, or pushes elsewhere than it fetches from, is refused at the checks: nothing to confirm.
    if (repo === null || address.fetch !== address.push) return null;
    return { remote, address: redact(address.configured), repository: repoName(repo), branch: task.branch, base: baseBranch };
  };

  /** Every check, in order, before anything is sent. Returns what the delivery needs, or throws a DeliveryFailure at "check". */
  const check = async (task: Task, commit: string, expectAddress?: string): Promise<{ remote: string; repo: RepoRef; base: string; branch: string }> => {
    const fail = (why: string): never => {
      throw new DeliveryFailure("check", `${why} Nothing was sent.`);
    };
    const branch = task.branch!;
    if (!branch.startsWith(BRANCH_PREFIX)) fail(`The branch ${branch} is not one Botbench made under its own name (${BRANCH_PREFIX}…), so it is not pushed.`);
    const { remote, baseBranch } = repositoryDelivery(config, task.repo);
    let address: { configured: string; fetch: string; push: string } | null;
    try {
      address = await remoteAddress(task.repo, remote);
    } catch (err) {
      return fail(`The repository's remote ${remote} could not be read: ${words(err)}`);
    }
    if (address === null) return fail(`The repository at ${task.repo} has no remote named ${remote}. Add one with git remote add ${remote} followed by the GitHub address, or name another remote in Botbench's settings file (the repository's "remote").`);
    // What the remote's branch holds is asked where git fetches from; a remote that pushes somewhere else is not delivered to.
    if (expectAddress !== undefined && redact(address.configured) !== expectAddress) return fail(`The remote ${remote}'s address is ${redact(address.configured)} now, not the one you were shown (${expectAddress}).`);
    if (address.fetch !== address.push) return fail(`The remote ${remote} pushes to a different address (${redact(address.push)}) than it fetches from (${redact(address.fetch)}), so Botbench cannot check what it would overwrite there.`);
    const repo = githubRepoOf(address.configured) ?? githubRepoOf(address.push);
    if (repo === null) return fail(`The remote ${remote} (${redact(address.configured)}) is not a GitHub repository address, so the gh tool cannot open a pull request there.`);
    let at: string | null;
    try {
      at = await branchCommit(task.repo, branch);
    } catch (err) {
      return fail(`The branch ${branch} could not be read: ${words(err)}`);
    }
    if (at === null) fail(`The branch ${branch} is not in the repository any more.`);
    if (at !== commit) fail(`The branch ${branch} has moved since the task was accepted: it was at ${commit.slice(0, 12)} and is at ${at!.slice(0, 12)} now. Botbench pushes only what was accepted.`);
    const signedIn = await github.signedIn(repo.host).catch((err: unknown) => ({ problem: words(err) }));
    if ("problem" in signedIn) fail(signedIn.problem);
    let defaultBranch: string;
    try {
      defaultBranch = await github.defaultBranch(repo);
    } catch (err) {
      return fail(`GitHub did not say which branch is the default of ${repoName(repo)}: ${words(err)}`);
    }
    const base = baseBranch ?? defaultBranch;
    if (branch === base || branch === defaultBranch) fail(`The branch ${branch} is the repository's ${branch === defaultBranch ? "default" : "base"} branch, which Botbench never pushes to.`);
    // The pull request's own arguments are checked now too, so nothing about them fails once the branch is pushed.
    try {
      ghArgs.prCreate(repo, { base, head: branch, title: pullRequestText(db, task).title });
    } catch (err) {
      return fail(`The pull request could not be made: ${words(err)}`);
    }
    return { remote, repo, base, branch };
  };

  const run = async (taskId: number, by: "owner" | "run", expectAddress?: string): Promise<void> => {
    let task: Task;
    let commit: string;
    try {
      ({ task, commit } = deliverable(taskId));
    } catch (err) {
      // Nothing to do: already open, or no longer deliverable. Said once in the server's log.
      console.error(`Task ${taskId} was not delivered: ${redact(words(err))}`);
      return;
    }
    let where: Awaited<ReturnType<typeof check>>;
    try {
      where = await check(task, commit, expectAddress);
    } catch (err) {
      const why = err instanceof DeliveryFailure ? err.message : redact(`The checks before sending failed: ${words(err)} Nothing was sent.`);
      record(task, { step: "failed", failedStep: "check", detail: why }, `Did not open a pull request: ${why}`);
      return;
    }
    const { remote, repo, base, branch } = where;
    const repository = repoName(repo);
    record(task, { step: "requested", requestedBy: by, remote, repository, base, branch, headCommit: commit }, `Pushing the branch ${branch} to ${remote} (${repository}) and opening a pull request into ${base}${by === "run" ? ", as the run was set to" : ", as you asked"}.`);

    // The push: only when the remote lacks the commit; never over other commits.
    try {
      const there = await remoteBranchCommit(task.repo, remote, branch);
      if (there === commit) {
        record(task, { step: "pushed", remote, branch, headCommit: commit, detail: "already on the remote" }, `The branch ${branch} was already on ${remote} at ${commit.slice(0, 12)}, so it was not pushed again.`);
      } else if (there !== null) {
        throw new DeliveryFailure("push", `The remote ${remote} already has a branch named ${branch} with other commits (at ${there.slice(0, 12)}). Botbench never overwrites a branch, so nothing was pushed. Delete or rename that branch on the remote, then try again.`);
      } else {
        await pushTaskBranch({ repo: task.repo, remote, branch, commit });
        record(task, { step: "pushed", remote, branch, headCommit: commit }, `Pushed the branch ${branch} at ${commit.slice(0, 12)} to ${remote}.`);
      }
    } catch (err) {
      const why = err instanceof DeliveryFailure ? err.message : redact(`The branch ${branch} could not be pushed to ${remote}: ${words(err)}`);
      record(task, { step: "failed", failedStep: "push", detail: why }, `Did not open a pull request: ${why}`);
      return;
    }

    // The pull request: one already there, in any state, is taken as this task's; otherwise one is opened.
    try {
      const found = await github.findPullRequest(repo, branch);
      let pr: PullRequest;
      let adopted: boolean;
      if (found !== null) {
        pr = found;
        adopted = true;
      } else {
        const { title, body } = pullRequestText(db, task, repo);
        pr = await github.openPullRequest(repo, { base, head: branch, title, body, cwd: task.repo });
        adopted = false;
      }
      record(task, { step: "opened", url: pr.url, number: pr.number, adopted, prState: pr.state, branch, base, repository }, adopted ? `Found pull request #${pr.number} already there for the branch ${branch}, so no second one was opened: ${pr.url}` : `Opened pull request #${pr.number} into ${base}: ${pr.url}`);
    } catch (err) {
      const why = redact(`The branch ${branch} is on ${remote}, but the pull request could not be opened: ${words(err)}`);
      record(task, { step: "failed", failedStep: "pull_request", detail: why }, `Did not open a pull request: ${why}`);
    }
  };

  const start = (taskId: number, by: "owner" | "run", expectAddress?: string): void => {
    const going: Promise<void> = run(taskId, by, expectAddress)
      .catch((err: unknown) => {
        const why = redact(`Botbench stopped delivering this task: ${words(err)}`);
        console.error(`Delivering task ${taskId} failed: ${why}`);
        // Said on the task, with Try again, rather than left looking as if it were still under way.
        try {
          const task = getTask(db, taskId);
          if (task?.status === "accepted") record(task, { step: "failed", failedStep: "pull_request", detail: why }, `Did not open a pull request: ${why}`);
        } catch (also) {
          console.error(`Recording task ${taskId}'s failed delivery failed: ${redact(words(also))}`);
        }
      })
      .finally(() => {
        if (running.get(taskId) === going) running.delete(taskId);
      });
    running.set(taskId, going);
  };

  const deliver: Deliveries["deliver"] = (taskId, o) => {
    if (closed) throw new TaskError(503, "Botbench is shutting down.");
    if (running.has(taskId)) throw new TaskError(409, `Task ${taskId}'s pull request is being opened already.`);
    const { task } = deliverable(taskId);
    if (o.expect !== undefined) {
      const { remote } = repositoryDelivery(config, task.repo);
      if (o.expect.remote !== remote || o.expect.branch !== task.branch) throw new TaskError(409, `The remote or branch is not the one you were shown: it is ${task.branch} to ${remote} now. Nothing was sent. Look again, then confirm.`);
    }
    start(taskId, o.by, typeof o.expect?.address === "string" ? o.expect.address : undefined);
  };

  // A delivery left half-way by a stopped Botbench (asked or pushed, no pull request yet) is taken up again from its ledger.
  for (const row of db.prepare("SELECT task_id FROM deliveries GROUP BY task_id HAVING MAX(CASE WHEN step = 'opened' THEN 1 ELSE 0 END) = 0").all()) {
    const taskId = Number(row.task_id);
    const steps = deliverySteps(db, taskId);
    const last = steps.at(-1)!;
    if (last.step !== "requested" && last.step !== "pushed") continue;
    const asked = [...steps].reverse().find((s) => s.step === "requested");
    start(taskId, asked?.requestedBy ?? "owner");
  }

  // A run's accepted task whose acceptance was recorded but whose delivery never began (Botbench stopped in between).
  for (const row of db.prepare("SELECT t.id FROM tasks t JOIN runs r ON r.id = t.run_id JOIN decisions d ON d.task_id = t.id WHERE t.status = 'accepted' AND r.delivery = 'pull_request' AND d.branch = 'kept' AND NOT EXISTS (SELECT 1 FROM deliveries x WHERE x.task_id = t.id) ORDER BY t.id").all()) {
    const taskId = Number(row.id);
    if (!running.has(taskId)) start(taskId, "run");
  }

  // A task of a run that chose pull requests is delivered once its acceptance is recorded, whoever accepted it: the
  // owner, or a fully autonomous run's mode.
  const unlisten = onTaskAccepted((from, task) => {
    if (from !== db || closed || runDelivery(db, task) !== "pull_request" || running.has(task.id)) return;
    start(task.id, "run");
  });

  const idle = async (): Promise<void> => {
    while (running.size > 0) await Promise.allSettled([...running.values()]);
  };
  return {
    deliver,
    target,
    busy: (taskId) => running.has(taskId),
    idle,
    close: async () => {
      closed = true;
      unlisten();
      await idle();
    },
  };
}
