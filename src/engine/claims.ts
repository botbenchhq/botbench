import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appendLog } from "../approvals/broker.ts";
import { repositoryClaims, repositoryDelivery, type Config } from "../config.ts";
import { githubRepoOf, redact, repoName, type GitHub, type RepoRef } from "../github.ts";
import { now } from "../store/db.ts";
import { ownWorkbenches, workbenchName } from "../workbench.ts";
import { deleteRemoteBranchesAt, makeClaimCommit, pushNewBranch, pushNewBranches, remoteAddress, remoteTaskBranches } from "../worktrees.ts";
import { claimBranchName, claimTimeWords, lockBranch, messageIssue, parseClaimBranch, type ClaimName } from "./claim-branch.ts";
import { deliverySteps } from "./delivery.ts";
import { githubOfRepository, runIssue } from "./intake.ts";
import { getRun, runTasks, type Run } from "./run.ts";
import { words } from "./task.ts";

/*
 * Claiming an issue (Peers, step P3). A run started from an issue, of a repository whose setting `claimIssues` is on
 * (off by default), and that the owner set to open pull requests, tells other workbenches as soon as it starts that
 * this one started on that issue: it pushes a commit Botbench makes for the claim to two new branches on the
 * repository's remote, in one atomic push. When the run ends without a pull request (cancelled, failed, or done with
 * no pull request opened or on its way), both are deleted again.
 *
 * What leaves the machine, and when: only for a run the owner chose pull requests for, the same choice that lets
 * Botbench push the task's branch at all (CLAUDE.md: "a push or a pull request only when the owner chose it for that
 * run"); the composer says so before Send. A run that keeps its work on this Mac claims nothing on the remote, even
 * with the setting on; its screen says the claim stayed on this Mac.
 *
 * Why branches and not a comment on the issue: a branch is written with the owner's own git and the push permission
 * Botbench already uses for a pull request, and the view of other workbenches already reads the remote's branches with
 * `git ls-remote`, so the claim needs no new gh command, no new permission and no write to the issue (src/github.ts
 * writes nothing to an issue). A comment would notify everybody who watches the issue, stay in its history after it is
 * deleted, and be owned by the owner's GitHub account rather than by this workbench's branch name, which is what tells
 * one workbench's claim from another's. And a comment cannot be created only if none is there; a branch can.
 *
 * The earliest claim wins, and the remote decides it (approach from Paperclip server/src/services/issues.ts `checkout`,
 * where one conditional update sets an issue's holder only while it has none, and a checkout of an issue somebody else
 * holds fails with who holds it). Git gives the same on any remote without force: the claim's push creates the issue's
 * lock branch `botbench/claims/issue-<number>` (engine/claim-branch.ts lockBranch), which the remote takes only while no
 * branch of that name exists, and with `--atomic` it creates the named branch
 * `botbench/<workbench>/run-<N>/issue-<number>-at-<time>` with it or neither. So of two workbenches that claim at once,
 * exactly one push is taken. The other's is refused; it reads the remote, finds the named branch at the lock's commit
 * (the holder, by its name alone), and withdraws: the run is stopped, nothing of it was pushed, and its screen names
 * the holder and its claim time. The lock is read again before a delivery pushes the task's branch and before it opens
 * the pull request; a run whose lock another workbench now holds opens none.
 *
 * Taking over an old claim, after a confirm that names its holder (`claim_takeovers`), only lets the run go ahead while
 * the holder's lock stays: its named branch is pushed alone, and nothing of the holder's is deleted or moved (no force,
 * so it could not be). A run whose own claim could not be made (no remote, no network, a remote that is not the GitHub
 * repository it is written as) goes on as usual, said in plain words; it is not protected from a second pull request.
 *
 * What is pushed is one commit Botbench makes for the claim: no parent and no files (worktrees.ts makeClaimCommit), so
 * nothing of the repository and none of the owner's unpushed commits leave with it.
 *
 * A branch is deleted only when all three hold: it is this run's own (its named branch, under a name this installation
 * has had, or the lock while it points at this run's claim commit), the remote branch is still at that commit, and it
 * has no pull request in any state. Otherwise it is left on the remote and the run says why. The commit is stored
 * (`claiming`) before it is pushed, so a Botbench that stopped in the middle still finds and releases it after a
 * restart (`recover`, after the release of a claim whose run ended is taken over from Paperclip's
 * `adoptStaleCheckoutRun`). Every step that pushed, gave up or released a claim is also in the action log (rule
 * `issue_claim`).
 *
 * What is read back from the remote (branch names and commit ids from `git ls-remote`) was written by whoever pushed
 * it. It is data: a branch counts only when its whole name matches the claim or lock pattern (a workbench name of at
 * most 30 lowercase letters, digits and hyphens, a run number, an issue number, a time), it is shown as plain text, and
 * it is never put in a prompt, a path or a command. No commit message or file of another workbench's is read.
 */

/** The issue a run is for: the one attached with "From an issue", else the one number its message names; null when none, or more than one. */
export function runIssueNumber(db: DatabaseSync, run: Pick<Run, "id" | "prompt">): number | null {
  const attached = runIssue(db, run.id);
  if (attached !== null) return attached.number;
  return messageIssue(run.prompt);
}

export type ClaimStep = "claiming" | "claimed" | "not_claimed" | "withdrawn" | "released" | "kept";
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
   * the issue's lock is read again. Null to go on; otherwise why not, in plain words, once this run's claim was
   * withdrawn because another workbench holds the lock. Never rejects: a lock that cannot be read holds nothing up.
   */
  beforeSend(runId: number | null, when: "push" | "pull_request", branch: string): Promise<string | null>;
  /**
   * At start: settle the claims a stopped Botbench left in the middle of their push, and release those of runs that
   * ended without a pull request while no Botbench was there to release them.
   */
  recover(): void;
  /** Resolves once every claim and release in flight has finished. */
  idle(): Promise<void>;
}

/** Who holds an issue's lock: the named claim branch at the lock's commit, read from its name alone; null when none is. */
type Holder = ClaimName | null;

export function createClaims(o: { db: DatabaseSync; config: Config; github: GitHub; clock?: () => Date; onRunChange?: (runId: number) => void; stopRun?: (runId: number) => void }): Claims {
  const { db, config, github } = o;
  const clock = o.clock ?? (() => new Date());
  const report = (runId: number, what: string) => (err: unknown): void => console.error(`${what} for run ${runId} failed: ${words(err)}`);

  /** Append a step, log one that wrote to the remote or ended the claim, then tell the run's screen. A listener that fails undoes nothing. */
  const record = (run: Run, step: ClaimStep, c: { issue: number; remote?: string; branch?: string; commit?: string; detail: string }, command?: string): void => {
    const detail = redact(c.detail);
    db.prepare("INSERT INTO issue_claims (run_id, step, issue, remote, branch, commit_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(run.id, step, c.issue, c.remote ?? null, c.branch ?? null, c.commit ?? null, detail, now());
    if (step !== "not_claimed" && step !== "claiming") appendLog(db, { taskId: null, runId: run.id, attemptId: null, rule: "issue_claim", tool: "git", command: command ?? c.branch ?? "", cwd: run.repo, detail });
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

  /** The run's claim while it may be on the remote: pushed (`claimed`), or stored before a push whose end was not (`claiming`). */
  const onRemote = (runId: number): HeldClaim | null => {
    const last = claimSteps(db, runId).at(-1);
    return (last?.step === "claimed" || last?.step === "claiming") && last.branch !== null && last.remote !== null && last.commit !== null ? (last as HeldClaim) : null;
  };
  const held = (runId: number): HeldClaim | null => {
    const c = onRemote(runId);
    return c?.step === "claimed" ? c : null;
  };

  /** The remote's Botbench branches, by name, with the commit each points at. Throws when the remote cannot be read. */
  const remoteRefs = async (run: Run, remote: string): Promise<Map<string, string>> => new Map((await remoteTaskBranches(run.repo, remote)).map((b) => [b.branch, b.commit]));

  /** Who holds the issue's lock at `lockAt`: the one named claim branch on that issue at the same commit; null when there is none. */
  const holderOf = (refs: ReadonlyMap<string, string>, issue: number, lockAt: string): Holder => {
    const named = [...refs].flatMap(([branch, commit]) => {
      const claim = commit === lockAt ? parseClaimBranch(branch) : null;
      return claim !== null && claim.issue === issue ? [claim] : [];
    });
    return named.length === 1 ? named[0]! : null;
  };
  /** Who was first, and when this run's own claim was made, as the start of a sentence. */
  const holderWords = (holder: Holder, issue: number, mine: ClaimName): string =>
    holder === null ? `Another workbench already holds the claim on issue #${issue} (the branch ${lockBranch(issue)} on the remote, which names no workbench's claim)` : `${holder.workbench} started on issue #${issue} at ${claimTimeWords(holder.startedAt)}, before this workbench did (${claimTimeWords(mine.startedAt)})`;
  const unknownHolderHelp = (holder: Holder, issue: number): string => (holder === null ? ` If no workbench is working on it, delete the branch ${lockBranch(issue)} on GitHub and start the run again.` : "");

  /**
   * Delete what of this run's claim is still on the remote, by the delete rule: its named branch, under one of this
   * installation's names, and the issue's lock while it points at this run's claim commit; each only while at the
   * commit Botbench pushed and with no pull request in any state, in one compare-and-delete. A named branch somebody
   * added to is left, and the lock still freed. Returns what happened in one sentence, whether nothing of the claim is
   * left on the remote, and the git command that deleted, if any.
   */
  const removeClaim = async (run: Run, c: HeldClaim): Promise<{ gone: boolean; said: string; command: string | null }> => {
    const { branch, remote, commit } = c;
    const lock = lockBranch(c.issue);
    const left = (why: string) => ({ gone: false, said: `Botbench left the branch ${branch} on the remote ${remote}: ${why}`, command: null });
    const parsed = parseClaimBranch(branch);
    // The recorded commit is trusted as this run's own only with a name this installation has had.
    if (parsed === null || parsed.issue !== c.issue || !ownWorkbenches(db).has(parsed.workbench)) return left("its name is not this workbench's own.");
    let refs: Map<string, string>;
    try {
      refs = await remoteRefs(run, remote);
    } catch (err) {
      return left(`the remote could not be read, so it could not be checked. ${words(err)} Delete the branch yourself once you are sure it is not in use.`);
    }
    const namedAt = refs.get(branch);
    const moved = namedAt !== undefined && namedAt !== commit;
    // Another workbench's lock, at any other commit, is never touched.
    const mine = [branch, lock].filter((b) => refs.get(b) === commit);
    const movedWords = "somebody added to it since Botbench pushed it, so it is not Botbench's to delete.";
    if (mine.length === 0) return moved ? left(movedWords) : { gone: true, said: `The branch ${branch} was already gone from the remote ${remote}.`, command: null };
    const found = await claimTarget(config, run.repo, remote);
    if ("problem" in found) return left(`Botbench could not check whether it has a pull request. ${found.problem}`);
    try {
      for (const b of mine) {
        const pr = await github.findPullRequest(found.repo, b);
        if (pr !== null) return left(`the branch ${b} has pull request #${pr.number}.`);
      }
    } catch (err) {
      return left(`Botbench could not check whether it has a pull request. ${words(err)}`);
    }
    try {
      await deleteRemoteBranchesAt({ repo: run.repo, remote, branches: mine, commit });
    } catch (err) {
      return left(`the remote did not delete it. ${words(err)}`);
    }
    const command = `git push --atomic ${mine.map((b) => `--force-with-lease=refs/heads/${b}:${commit}`).join(" ")} ${remote} ${mine.map((b) => `:refs/heads/${b}`).join(" ")}`;
    const deleted = `Botbench deleted the branch${mine.length === 1 ? "" : "es"} ${mine.join(" and ")} from the remote ${remote}.`;
    return moved ? { gone: false, said: `${deleted} It left the branch ${branch} there: ${movedWords}`, command } : { gone: true, said: deleted, command };
  };

  /** Give the claim up for `holder`'s lock: what of it is on the remote deleted by the release rule, and the step said with what this run does instead. */
  const withdraw = async (run: Run, c: HeldClaim, holder: Holder, instead: string): Promise<string> => {
    const mine = parseClaimBranch(c.branch)!;
    const removed = await removeClaim(run, c);
    const detail = `${holderWords(holder, c.issue, mine)}, so ${instead}: when two workbenches start on one issue, the earliest claim goes ahead.${unknownHolderHelp(holder, c.issue)} ${removed.said}`;
    record(run, "withdrawn", { issue: c.issue, remote: c.remote, branch: c.branch, commit: c.commit, detail }, removed.command ?? c.branch);
    return detail;
  };

  /** Whether the issue's lock, as the remote has it now, lets this run go on: its own, nobody's, its own workbench's, or a claim it took over. */
  const lockLetsGo = (run: Run, refs: ReadonlyMap<string, string>, c: { issue: number; commit: string }): { go: true } | { go: false; holder: Holder } => {
    const lockAt = refs.get(lockBranch(c.issue));
    if (lockAt === undefined || lockAt === c.commit) return { go: true };
    const holder = holderOf(refs, c.issue, lockAt);
    if (holder !== null && (ownWorkbenches(db).has(holder.workbench) || takenOver(db, run.id).has(holder.branch))) return { go: true };
    return { go: false, holder };
  };

  const claim = async (run: Run): Promise<void> => {
    if (!repositoryClaims(config, run.repo) || claimSteps(db, run.id).length > 0) return;
    const issue = runIssueNumber(db, run);
    if (issue === null) return;
    // Nothing leaves the machine for a run that keeps its work here: only the owner's choice of pull requests pushes.
    if (run.delivery !== "pull_request") return record(run, "not_claimed", { issue, detail: `Other workbenches are not told that you started on issue #${issue}: this run keeps its work on this Mac, so Botbench pushes nothing for it. Choose Open a pull request when you start a run to tell them.` });
    const { remote } = repositoryDelivery(config, run.repo);
    const notClaimed = (why: string): void => record(run, "not_claimed", { issue, detail: `Botbench could not tell other workbenches that you started on issue #${issue}: ${why} The run goes on as usual.` });
    const found = await claimTarget(config, run.repo, remote);
    if ("problem" in found) return notClaimed(found.problem);
    const workbench = workbenchName(db);
    const branch = claimBranchName(workbench, run.id, issue, clock());
    const lock = lockBranch(issue);
    let commit: string;
    try {
      commit = await makeClaimCommit(run.repo, `Botbench: ${workbench} started on issue #${issue}\n\nThis branch tells other workbenches that ${workbench} started on issue #${issue} (Botbench run ${run.id}). It holds no files, and Botbench deletes it if the run ends without a pull request.`);
    } catch (err) {
      return notClaimed(`the claim's commit could not be made. ${words(err)}`);
    }
    // Stored before the push: a Botbench that stops in the middle finds it again at its next start (recover).
    record(run, "claiming", { issue, remote, branch, commit, detail: `Botbench is pushing the branches ${branch} and ${lock} to the remote ${remote}, so other workbenches can see you started on issue #${issue}.` });
    const pushCommand = `git push --atomic ${remote} ${commit}:refs/heads/${lock} ${commit}:refs/heads/${branch}`;
    const claimed = (extra: string, command: string): void => record(run, "claimed", { issue, remote, branch, commit, detail: `Botbench pushed ${extra} to the remote ${remote}, so other workbenches can see you started on issue #${issue}. The claim holds no files, and is deleted if the run ends without a pull request.` }, command);
    let pushError: unknown;
    try {
      await pushNewBranches({ repo: run.repo, remote, branches: [lock, branch], commit });
      return claimed(`the branches ${branch} and ${lock}`, pushCommand);
    } catch (err) {
      pushError = err;
    }
    // Refused, or not known to have arrived: the remote says who holds the lock.
    let refs: Map<string, string>;
    try {
      refs = await remoteRefs(run, remote);
    } catch {
      return notClaimed(`the branch ${branch} could not be pushed to the remote ${remote}. ${words(pushError)}`);
    }
    const lockAt = refs.get(lock);
    if (lockAt === commit) return claimed(`the branches ${branch} and ${lock}`, pushCommand);
    if (lockAt === undefined) return notClaimed(`the branch ${branch} could not be pushed to the remote ${remote}. ${words(pushError)}`);
    const holder = holderOf(refs, issue, lockAt);
    if (holder !== null && ownWorkbenches(db).has(holder.workbench)) return notClaimed(`run ${holder.run} of this workbench already holds the claim on issue #${issue}.`);
    const taken = holder === null ? undefined : takenOver(db, run.id).get(holder.branch);
    if (holder !== null && taken !== undefined) {
      // Taken over: the holder's lock stays as it is, and only this run's named branch is pushed, so others see it too.
      try {
        await pushNewBranch({ repo: run.repo, remote, branch, commit });
      } catch (err) {
        return notClaimed(`the branch ${branch} could not be pushed to the remote ${remote}. ${words(err)}`);
      }
      record(run, "claimed", { issue, remote, branch, commit, detail: `Botbench pushed the branch ${branch} to the remote ${remote}, so other workbenches can see you started on issue #${issue}. You took over ${holder.workbench}'s claim from ${claimTimeWords(taken.startedAt)}; its branches stay on the remote as they are. Yours holds no files, and is deleted if the run ends without a pull request.` }, `git push ${remote} ${commit}:refs/heads/${branch}`);
      return;
    }
    const mine = parseClaimBranch(branch)!;
    record(run, "withdrawn", { issue, remote, branch, commit, detail: `${holderWords(holder, issue, mine)}, so this run stopped: when two workbenches start on one issue, the earliest claim goes ahead. The remote refused this workbench's claim, so nothing of this run was pushed.${unknownHolderHelp(holder, issue)}` }, pushCommand);
    o.stopRun?.(run.id);
  };

  const release = async (run: Run): Promise<void> => {
    const c = onRemote(run.id);
    if (c === null) return;
    const removed = await removeClaim(run, c);
    if (removed.gone) record(run, "released", { issue: c.issue, remote: c.remote, branch: c.branch, commit: c.commit, detail: `The run ended without a pull request. ${removed.said.replace(/\.$/, "")}: other workbenches no longer see issue #${c.issue} as started here.` }, removed.command ?? c.branch);
    else record(run, "kept", { issue: c.issue, remote: c.remote, branch: c.branch, commit: c.commit, detail: `The run ended without a pull request, but ${removed.said}` }, removed.command ?? c.branch);
  };

  /** A claim whose push a stopped Botbench never saw end, for a run still going: claimed when the remote has its lock or named branch, else not claimed. */
  const settle = async (run: Run, c: HeldClaim): Promise<void> => {
    let refs: Map<string, string>;
    try {
      refs = await remoteRefs(run, c.remote);
    } catch (err) {
      return record(run, "not_claimed", { issue: c.issue, detail: `Botbench stopped while it was telling other workbenches that you started on issue #${c.issue}, and could not read the remote ${c.remote} again after its restart: ${words(err)} The run goes on as usual.` });
    }
    const lock = lockBranch(c.issue);
    const there = [c.branch, lock].filter((b) => refs.get(b) === c.commit);
    if (there.length > 0) return record(run, "claimed", { issue: c.issue, remote: c.remote, branch: c.branch, commit: c.commit, detail: `Botbench pushed ${there.join(" and ")} to the remote ${c.remote}, so other workbenches can see you started on issue #${c.issue}. The claim holds no files, and is deleted if the run ends without a pull request.` }, `git push --atomic ${c.remote} ${c.commit}:refs/heads/${lock} ${c.commit}:refs/heads/${c.branch}`);
    record(run, "not_claimed", { issue: c.issue, detail: `Botbench stopped while it was telling other workbenches that you started on issue #${c.issue}, and the remote ${c.remote} did not take the claim. The run goes on as usual.` });
  };

  const beforeSend = async (runId: number, when: "push" | "pull_request", branch: string): Promise<string | null> => {
    const run = getRun(db, runId);
    if (run === null) return null;
    const last = claimSteps(db, runId).at(-1);
    const nothing = when === "push" ? `Botbench did not push the branch ${branch} or open a pull request` : `Botbench opened no pull request: the branch ${branch} it pushed stays on the remote, withdrawn, and no pull request is opened from it`;
    if (last?.step === "withdrawn") return `This run gave way to an earlier claim on issue #${last.issue}, so ${nothing}. ${last.detail}`;
    const c = held(runId);
    if (c === null) return null;
    let verdict: ReturnType<typeof lockLetsGo>;
    try {
      verdict = lockLetsGo(run, await remoteRefs(run, c.remote), c);
    } catch (err) {
      report(runId, "Reading the claim on its issue again")(err);
      return null;
    }
    if (verdict.go) return null;
    const why = await withdraw(run, c, verdict.holder, nothing);
    // The run gave way: what it has not built yet is not built either. A run with nothing left to stop stays as it is.
    try {
      o.stopRun?.(runId);
    } catch (err) {
      report(runId, "Stopping it after its issue claim gave way")(err);
    }
    return why;
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
        report(runId, "Reading the claim on its issue again")(err);
        return null;
      });
    },
    recover() {
      try {
        const rows = db.prepare("SELECT DISTINCT run_id FROM issue_claims ORDER BY run_id").all();
        for (const row of rows) {
          const runId = Number(row.run_id);
          const run = getRun(db, runId);
          const c = onRemote(runId);
          if (run === null || c === null) continue;
          if (endedWithoutPullRequest(db, run)) after(runId, () => release(getRun(db, runId)!), "Releasing its issue after a restart");
          else if (c.step === "claiming") after(runId, () => settle(getRun(db, runId)!, c), "Settling its issue claim after a restart");
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
