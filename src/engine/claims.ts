import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appendLog } from "../approvals/broker.ts";
import { repositoryClaims, repositoryDelivery, type Config } from "../config.ts";
import { githubRepoOf, redact, repoName, type GitHub, type RepoRef } from "../github.ts";
import { now } from "../store/db.ts";
import { ownWorkbenches, workbenchName } from "../workbench.ts";
import { deleteRemoteBranchAt, makeClaimCommit, pushNewBranch, remoteAddress, remoteBranchCommit, remoteTaskBranches } from "../worktrees.ts";
import { claimBranchName, claimedBefore, claimTimeWords, messageIssue, parseClaimBranch, type ClaimName } from "./claim-branch.ts";
import { deliverySteps } from "./delivery.ts";
import { githubOfRepository, runIssue } from "./intake.ts";
import { getRun, runTasks, type Run } from "./run.ts";
import { words } from "./task.ts";

/*
 * Claiming an issue (Peers, step P3). With the repository's setting `claimIssues` on (off by default), a run started
 * from an issue pushes a branch to the repository's remote as soon as it starts, long before there is any work to
 * push, so another workbench reading the remote (engine/peers.ts) sees that this one started on that issue. When the
 * run ends without a pull request (cancelled, failed, or done with no pull request opened or on its way), the branch
 * is deleted again.
 *
 * Why an early branch push and not a comment on the issue: a branch is written with the owner's own git and the push
 * permission Botbench already uses for a pull request, and the view of other workbenches already reads the remote's
 * branches with `git ls-remote`, so the claim needs no new gh command, no new permission and no write to the issue
 * (src/github.ts writes nothing to an issue). A comment would notify everybody who watches the issue, stay in its
 * history after it is deleted, and be owned by the owner's GitHub account rather than by this workbench's branch name,
 * which is what tells one workbench's claim from another's. The branch carries what the view needs in its name
 * (engine/claim-branch.ts): the workbench, the run, the issue number and the time the claim was made.
 *
 * The earliest claim wins (approach from Paperclip server/src/services/issues.ts, where a checkout of an issue somebody
 * else holds fails with who holds it). GitHub has no compare-and-set that fits a branch per workbench, so the claims on
 * the issue are read again at three points: just after this run's own claim is pushed, before a delivery pushes the
 * task's branch, and before it opens the pull request. A run that finds an earlier claim from another workbench at any
 * of them withdraws: its own claim branch is deleted by the release rule below, the run is stopped (at the start) or
 * its delivery opens no pull request (later), and its screen names the winner and its claim time. Two workbenches can
 * still both push in the gap between one's read and the other's push; neither then opens a second pull request, since
 * the later one sees the earlier claim before it opens one. A claim the owner took over after a confirm that names its
 * holder (`claim_takeovers`) is left out of the comparison; its branch is never touched.
 *
 * What is pushed is one commit Botbench makes for the claim: no parent and no files (worktrees.ts makeClaimCommit), so
 * nothing of the repository and none of the owner's unpushed commits leave with it. Never by force: a branch already
 * there under that name refuses the push. A claim that cannot be made (no remote, no network, a refused push, a remote
 * that is not the GitHub repository it is written as) is recorded in plain words and never holds up or fails the run.
 *
 * The branch is deleted only when all three hold: its name is this workbench's own (a name this installation has had),
 * the remote branch is still at the commit this workbench pushed, and it has no pull request in any state. Otherwise it
 * is left on the remote and the run says why. Every step that pushed, gave up or released a claim is also in the
 * action log (rule `issue_claim`), and a start of Botbench releases what a stopped one left claimed (`recover`, after
 * the release of a claim whose run ended is taken over from Paperclip's `adoptStaleCheckoutRun`).
 */

/** The issue a run is for: the one attached with "From an issue", else the one number its message names; null when none, or more than one. */
export function runIssueNumber(db: DatabaseSync, run: Pick<Run, "id" | "prompt">): number | null {
  const attached = runIssue(db, run.id);
  if (attached !== null) return attached.number;
  return messageIssue(run.prompt);
}

export type ClaimStep = "claimed" | "not_claimed" | "withdrawn" | "released" | "kept";
export interface ClaimRecord {
  step: ClaimStep;
  issue: number;
  remote: string | null;
  branch: string | null;
  commit: string | null;
  /** What happened, in plain words, for the run's screen. */
  detail: string;
  at: string;
}
type HeldClaim = ClaimRecord & { remote: string; branch: string; commit: string };

/** Every step of a run's claim, in order; none for a run that claimed nothing. */
export function claimSteps(db: DatabaseSync, runId: number): ClaimRecord[] {
  return db
    .prepare("SELECT step, issue, remote, branch, commit_id, detail, created_at FROM issue_claims WHERE run_id = ? ORDER BY id")
    .all(runId)
    .map((row) => ({ step: String(row.step) as ClaimStep, issue: Number(row.issue), remote: row.remote === null ? null : String(row.remote), branch: row.branch === null ? null : String(row.branch), commit: row.commit_id === null ? null : String(row.commit_id), detail: String(row.detail), at: String(row.created_at) }));
}

/** A run's claim as its screen shows it: the last step; null for a run that claimed nothing. */
export const claimOf = (db: DatabaseSync, runId: number): { state: ClaimStep; issue: number; branch: string | null; words: string } | null => {
  const last = claimSteps(db, runId).at(-1);
  return last === undefined ? null : { state: last.step, issue: last.issue, branch: last.branch, words: last.detail };
};

/** The claims of other workbenches a run took over (stored with the run, engine/run.ts createRun), by branch. */
function takenOver(db: DatabaseSync, runId: number): Map<string, { holder: string; startedAt: string }> {
  return new Map(db.prepare("SELECT branch, holder, started_at FROM claim_takeovers WHERE run_id = ? ORDER BY id").all(runId).map((row) => [String(row.branch), { holder: String(row.holder), startedAt: String(row.started_at) }]));
}

/**
 * Whether a run has ended without a pull request: cancelled, failed, or done with none opened and none on its way. A
 * pull request is on its way for an accepted task whose delivery has not ended: one of a run that opens pull requests
 * with no step yet (engine/delivery.ts pushes after the accept), or any whose last step is not a failure. A delivery
 * that failed leaves none on its way; a later Try again that opens one is its own sign to other workbenches.
 */
function endedWithoutPullRequest(db: DatabaseSync, run: Run): boolean {
  if (run.status === "cancelled" || run.status === "failed") return true;
  if (run.status !== "done") return false;
  for (const task of runTasks(db, run.id).filter((t) => t.status === "accepted")) {
    const steps = deliverySteps(db, task.id);
    if (steps.some((s) => s.step === "opened")) return false;
    const last = steps.at(-1);
    if (last === undefined ? run.delivery === "pull_request" : last.step !== "failed") return false;
  }
  return true;
}

/** A push address git may send a remote to that is a folder on this Mac: an absolute path or a file: address. */
const localFolder = (address: string): boolean => path.isAbsolute(address) || /^file:\/\//i.test(address);

/**
 * The GitHub repository a claim is pushed to and its pull requests are looked for in, when git fetches from and pushes
 * to one place and that place is the repository the remote is written as; else why not. Git's rewrite rules may send
 * the written address elsewhere: to the same GitHub repository, or to a folder on this Mac (nothing leaves the Mac
 * then), is accepted; to another GitHub repository, another host, or anything Botbench cannot read as either, is not.
 */
export async function claimTarget(config: Config, repo: string, remote: string): Promise<{ repo: RepoRef } | { problem: string }> {
  const found = await githubOfRepository(config, repo);
  if ("problem" in found) return found;
  const address = await remoteAddress(repo, remote).catch(() => null);
  // The pull requests are looked for where git fetches; the branch is pushed and deleted where it pushes. Those must be one place.
  if (address === null || address.fetch !== address.push) return { problem: `The remote ${remote} pushes to another address than it fetches from, so Botbench cannot be sure which repository the branch is on.` };
  if (address.push === address.configured) return found;
  const used = githubRepoOf(address.push);
  if (used !== null) return repoName(used).toLowerCase() === repoName(found.repo).toLowerCase() ? found : { problem: `The remote ${remote} is written as ${repoName(found.repo)} but git sends it to ${repoName(used)}, so Botbench cannot be sure which repository the branch is on.` };
  if (localFolder(address.push)) return found;
  return { problem: `The remote ${remote} is written as ${repoName(found.repo)} but git sends it to ${redact(address.push)}, which Botbench cannot read as that repository, so it cannot be sure which repository the branch is on.` };
}

export interface Claims {
  /** The run listener: a run just started claims its issue; a run that ended without a pull request releases it. Never throws. */
  runChanged(run: { id: number }): void;
  /**
   * Before a delivery of one of the run's tasks pushes its branch (`push`) or opens its pull request (`pull_request`):
   * the claims on the run's issue are read again. Null to go on; otherwise why not, in plain words, once this run's
   * claim was withdrawn for an earlier one. Never rejects: a claim that cannot be read again holds nothing up.
   */
  beforeSend(runId: number | null, when: "push" | "pull_request", branch: string): Promise<string | null>;
  /** At start: release the claims of runs that ended without a pull request while no Botbench was there to release them. */
  recover(): void;
  /** Resolves once every claim and release in flight has finished. */
  idle(): Promise<void>;
}

export function createClaims(o: { db: DatabaseSync; config: Config; github: GitHub; clock?: () => Date; onRunChange?: (runId: number) => void; stopRun?: (runId: number) => void }): Claims {
  const { db, config, github } = o;
  const clock = o.clock ?? (() => new Date());
  const report = (runId: number, what: string) => (err: unknown): void => console.error(`${what} for run ${runId} failed: ${words(err)}`);

  /** Append a step, log one that wrote to the remote or ended the claim, then tell the run's screen. A listener that fails undoes nothing. */
  const record = (run: Run, step: ClaimStep, c: { issue: number; remote?: string; branch?: string; commit?: string; detail: string }, command?: string): void => {
    const detail = redact(c.detail);
    db.prepare("INSERT INTO issue_claims (run_id, step, issue, remote, branch, commit_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(run.id, step, c.issue, c.remote ?? null, c.branch ?? null, c.commit ?? null, detail, now());
    if (step !== "not_claimed") appendLog(db, { taskId: null, runId: run.id, attemptId: null, rule: "issue_claim", tool: "git", command: command ?? c.branch ?? "", cwd: run.repo, detail });
    try {
      o.onRunChange?.(run.id);
    } catch (err) {
      report(run.id, "Announcing its issue claim")(err);
    }
  };

  // One chain per run, so a release waits for its claim's push, and a check before a delivery for both.
  const chains = new Map<number, Promise<unknown>>();
  const queue = <T>(runId: number, step: () => Promise<T>): Promise<T> => {
    const next = (chains.get(runId) ?? Promise.resolve()).catch(() => {}).then(step);
    chains.set(runId, next);
    void next.then(
      () => chains.get(runId) === next && chains.delete(runId),
      () => chains.get(runId) === next && chains.delete(runId),
    );
    return next;
  };
  const after = (runId: number, step: () => Promise<void>, what: string): void => void queue(runId, step).catch(report(runId, what));

  const held = (runId: number): HeldClaim | null => {
    const last = claimSteps(db, runId).at(-1);
    return last?.step === "claimed" && last.branch !== null && last.remote !== null && last.commit !== null ? (last as HeldClaim) : null;
  };

  /**
   * Delete this workbench's own claim branch, by the delete rule: own name, still at the pushed commit, no pull request
   * in any state. Returns what happened in one sentence's end, and whether it is gone.
   */
  const removeBranch = async (run: Run, c: HeldClaim): Promise<{ gone: boolean; said: string }> => {
    const { branch, remote, commit } = c;
    const left = (why: string) => ({ gone: false, said: `Botbench left the branch ${branch} on the remote ${remote}: ${why}` });
    const parsed = parseClaimBranch(branch);
    if (parsed === null || !ownWorkbenches(db).has(parsed.workbench)) return left("its name is not this workbench's own.");
    let at: string | null;
    try {
      at = await remoteBranchCommit(run.repo, remote, branch);
    } catch (err) {
      return left(`the remote could not be read, so it could not be checked. ${words(err)} Delete the branch yourself once you are sure it is not in use.`);
    }
    if (at === null) return { gone: true, said: `The branch ${branch} was already gone from the remote ${remote}.` };
    if (at !== commit) return left("somebody added to it since Botbench pushed it, so it is not Botbench's to delete.");
    const found = await claimTarget(config, run.repo, remote);
    if ("problem" in found) return left(`Botbench could not check whether it has a pull request. ${found.problem}`);
    try {
      const pr = await github.findPullRequest(found.repo, branch);
      if (pr !== null) return left(`it has pull request #${pr.number}.`);
    } catch (err) {
      return left(`Botbench could not check whether it has a pull request. ${words(err)}`);
    }
    try {
      await deleteRemoteBranchAt({ repo: run.repo, remote, branch, commit });
    } catch (err) {
      return left(`the remote did not delete it. ${words(err)}`);
    }
    return { gone: true, said: `Botbench deleted the branch ${branch} from the remote ${remote}.` };
  };
  const deleteCommand = (c: HeldClaim): string => `git push --force-with-lease=refs/heads/${c.branch}:${c.commit} ${c.remote} :refs/heads/${c.branch}`;

  /** Another workbench's claim on the run's issue made before this run's own, the earliest of them; null when there is none. */
  const earlierClaim = async (run: Run, c: HeldClaim): Promise<ClaimName | null> => {
    const mine = parseClaimBranch(c.branch);
    if (mine === null) return null;
    const taken = takenOver(db, run.id);
    const own = ownWorkbenches(db);
    // Only other workbenches' claims count: two runs of this workbench on one issue are the owner's own choice.
    const rivals = (await remoteTaskBranches(run.repo, c.remote)).flatMap(({ branch }) => {
      const claim = branch === c.branch || taken.has(branch) ? null : parseClaimBranch(branch);
      return claim !== null && !own.has(claim.workbench) && claim.issue === c.issue && claimedBefore(claim, mine) ? [claim] : [];
    });
    return rivals.sort((a, b) => (claimedBefore(a, b) ? -1 : 1))[0] ?? null;
  };

  /** Give the claim up for `winner`'s earlier one: its branch deleted by the release rule, and the step said with what this run does instead. */
  const withdraw = async (run: Run, c: HeldClaim, winner: ClaimName, instead: string): Promise<string> => {
    const mine = parseClaimBranch(c.branch)!;
    const removed = await removeBranch(run, c);
    const detail = `${winner.workbench} started on issue #${c.issue} at ${claimTimeWords(winner.startedAt)}, before this workbench did (${claimTimeWords(mine.startedAt)}), so ${instead}: when two workbenches start on one issue, the earliest claim goes ahead. ${removed.said}`;
    record(run, "withdrawn", { issue: c.issue, remote: c.remote, branch: c.branch, commit: c.commit, detail }, removed.gone ? deleteCommand(c) : c.branch);
    return detail;
  };

  const claim = async (run: Run): Promise<void> => {
    if (!repositoryClaims(config, run.repo) || claimSteps(db, run.id).length > 0) return;
    const issue = runIssueNumber(db, run);
    if (issue === null) return;
    const { remote } = repositoryDelivery(config, run.repo);
    const notClaimed = (why: string): void => record(run, "not_claimed", { issue, detail: `Botbench could not tell other workbenches that you started on issue #${issue}: ${why} The run goes on as usual.` });
    const found = await claimTarget(config, run.repo, remote);
    if ("problem" in found) return notClaimed(found.problem);
    const workbench = workbenchName(db);
    const branch = claimBranchName(workbench, run.id, issue, clock());
    let commit: string;
    try {
      commit = await makeClaimCommit(run.repo, `Botbench: ${workbench} started on issue #${issue}\n\nThis branch tells other workbenches that ${workbench} started on issue #${issue} (Botbench run ${run.id}). It holds no files, and Botbench deletes it if the run ends without a pull request.`);
      await pushNewBranch({ repo: run.repo, remote, branch, commit });
    } catch (err) {
      return notClaimed(`the branch ${branch} could not be pushed to the remote ${remote}. ${words(err)}`);
    }
    const taken = [...takenOver(db, run.id).values()].map((t) => ` You took over ${t.holder}'s claim from ${claimTimeWords(t.startedAt)}; its branch stays on the remote.`).join("");
    record(run, "claimed", { issue, remote, branch, commit, detail: `Botbench pushed the branch ${branch} to the remote ${remote}, so other workbenches can see you started on issue #${issue}. It holds no files, and is deleted if the run ends without a pull request.${taken}` }, `git push ${remote} ${commit}:refs/heads/${branch}`);
    // Read again at once: another workbench may have claimed the issue first.
    const c = held(run.id)!;
    let winner: ClaimName | null;
    try {
      winner = await earlierClaim(run, c);
    } catch (err) {
      return report(run.id, "Reading the claims on its issue again")(err);
    }
    if (winner === null) return;
    await withdraw(run, c, winner, "this run stopped");
    o.stopRun?.(run.id);
  };

  const release = async (run: Run): Promise<void> => {
    const c = held(run.id);
    if (c === null) return;
    const removed = await removeBranch(run, c);
    if (removed.gone) record(run, "released", { issue: c.issue, remote: c.remote, branch: c.branch, commit: c.commit, detail: `The run ended without a pull request. ${removed.said.replace(/\.$/, "")}: other workbenches no longer see issue #${c.issue} as started here.` }, deleteCommand(c));
    else record(run, "kept", { issue: c.issue, remote: c.remote, branch: c.branch, commit: c.commit, detail: `The run ended without a pull request, but ${removed.said}` });
  };

  const beforeSend = async (runId: number, when: "push" | "pull_request", branch: string): Promise<string | null> => {
    const run = getRun(db, runId);
    if (run === null) return null;
    const last = claimSteps(db, runId).at(-1);
    const nothing = when === "push" ? `Botbench did not push the branch ${branch} or open a pull request` : `Botbench opened no pull request: the branch ${branch} it pushed stays on the remote, withdrawn, and no pull request is opened from it`;
    if (last?.step === "withdrawn") return `This run gave way to an earlier claim on issue #${last.issue}, so ${nothing}. ${last.detail}`;
    const c = held(runId);
    if (c === null) return null;
    let winner: ClaimName | null;
    try {
      winner = await earlierClaim(run, c);
    } catch (err) {
      report(runId, "Reading the claims on its issue again")(err);
      return null;
    }
    return winner === null ? null : withdraw(run, c, winner, nothing);
  };

  return {
    runChanged(changed) {
      try {
        const run = getRun(db, changed.id);
        if (run === null) return;
        if (run.status === "planning" && claimSteps(db, run.id).length === 0) after(run.id, () => claim(run), "Claiming its issue");
        else if (endedWithoutPullRequest(db, run)) after(run.id, () => release(getRun(db, run.id)!), "Releasing its issue");
      } catch (err) {
        report(changed.id, "Claiming or releasing its issue")(err);
      }
    },
    beforeSend(runId, when, branch) {
      if (runId === null) return Promise.resolve(null);
      return queue(runId, () => beforeSend(runId, when, branch)).catch((err: unknown) => {
        report(runId, "Reading the claims on its issue again")(err);
        return null;
      });
    },
    recover() {
      try {
        const rows = db.prepare("SELECT DISTINCT run_id FROM issue_claims ORDER BY run_id").all();
        for (const row of rows) {
          const runId = Number(row.run_id);
          const run = getRun(db, runId);
          if (run !== null && held(runId) !== null && endedWithoutPullRequest(db, run)) after(runId, () => release(getRun(db, runId)!), "Releasing its issue after a restart");
        }
      } catch (err) {
        console.error(`Releasing the issue claims left by the last Botbench failed: ${words(err)}`);
      }
    },
    async idle() {
      while (chains.size > 0) await Promise.allSettled([...chains.values()]);
    },
  };
}
