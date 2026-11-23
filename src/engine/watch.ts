import type { DatabaseSync } from "node:sqlite";
import { watchedRepositories, type Config } from "../config.ts";
import { ghArgs, ghSaid, ghSaysLimited, githubRetryDelay, backoffMs, parseApiHead, parseWatchedIssues, repoName, type RunGh, type WatchedIssue } from "../github.ts";
import { now as nowIso, transaction } from "../store/db.ts";
import { githubOfRepository } from "./intake.ts";
import { words } from "./task.ts";

/*
 * The issue watch (issue #73, ADR 0008). For each repository whose settings have a "watch", Botbench lists, every
 * `intervalMinutes`, the repository's OPEN issues carrying the watched label, with the owner's own gh (src/github.ts,
 * read only: nothing is written to GitHub, no comment, label, close or assignment), and proposes each issue it has not
 * seen before on Work, for the owner to start or dismiss. It never starts a run, builds anything or asks a model: a run
 * starts only when the owner presses Start and then submits the composer, under today's rules for a run from an issue.
 *
 * The label is the gate: only people who can apply labels to the repository should be able to apply it. The seen table
 * (`watched_issues`) holds each issue by (repository, number) from the first poll that saw it, so an issue already in it
 * is never proposed again, after a restart too, and a dismissed one never returns. A poll that fails (gh missing, not
 * signed in, out of time, GitHub's limit, an answer that cannot be read) writes nothing, shows its repository's failure
 * in plain words with what gh said and the next try, and is tried again at the next interval: no proposal is made or
 * lost by it. After GitHub's limit the next try waits until GitHub says (githubRetryDelay), with a capped backoff.
 *
 * One watch is registered per store, started with the server and stopped cleanly on shutdown, each repository on its
 * own timer, and never two polls of one repository at once: the shape of paperclip's
 * chat-channels/github/chat-github-cloud-ingress.ts (one registered poller, a timer per source, an in-flight guard), and
 * of its task checkout and heartbeat services (a durable row is the claim, written once; the timer only says when to look
 * again). Approaches only: no code was copied.
 */

/** How a watched repository's polls stand, as Settings and Work show it. */
export interface WatchStatus {
  /** The repository's path, as its settings name it. */
  path: string;
  /** The GitHub repository its remote names (host/owner/name), once a poll has found it. */
  repository: string | null;
  label: string;
  intervalMinutes: number;
  /** waiting: not polled yet; checking: a poll is under way; checked: the last poll worked; failed: it did not. */
  state: "waiting" | "checking" | "checked" | "failed";
  /** When the last poll that worked ended. */
  checkedAt: string | null;
  /** Why the last poll failed, in Botbench's words; null unless failed. */
  problem: string | null;
  /** What gh printed when it failed, on one line, with any credentials in an address taken out; null when nothing. */
  said: string | null;
  /** When the next poll is due. */
  nextAt: string | null;
}

/** An issue proposed as a run: an issue seen by a poll and not dismissed, from which no run was started. */
export interface Proposal {
  id: number;
  /** host/owner/name. */
  repository: string;
  number: number;
  url: string;
  /** Outside text, as gh listed it when first seen. */
  title: string;
  /** Outside text: the author's login, or null for an account GitHub no longer has. */
  author: string | null;
  /** The watched repository on this Mac it was seen for: where Start opens the composer. */
  repoPath: string;
  firstSeenAt: string;
}

export interface Watch {
  /** Poll one watched repository now; while one of its polls is under way, that one is answered instead of starting another. */
  pollNow(path: string): Promise<void>;
  status(): WatchStatus[];
  /** The proposals on Work, newest first. */
  proposals(): Proposal[];
  /** One proposal by its id; null when there is none, it was dismissed, or a run was started from it. */
  proposal(id: number): Proposal | null;
  /** Dismiss a proposal: it is marked dismissed in the seen table and never proposed again. Whether one was dismissed. */
  dismiss(id: number): boolean;
  /** Stop every timer and wait for the polls under way. The store is free for another watch after. */
  close(): Promise<void>;
}

export interface WatchOptions {
  db: DatabaseSync;
  config: Config;
  /** The owner's gh. Its time limit (GH_LIMIT_MS) is runGh's own. */
  run: RunGh;
  /** Where gh runs; the process's folder when left out. Every command names its repository itself. */
  cwd?: string;
  /** A new issue was proposed: called once for each, after its row is stored. */
  onProposed?(proposal: Proposal): void;
  /** A repository's status or the proposals changed. */
  onChange?(): void;
  /** Poll each repository at start and then at its interval; false leaves every poll to pollNow (tests). */
  timers?: boolean;
  now?: () => number;
}

/** The longest wait after GitHub's limits, whatever the backoff reaches. */
const LIMIT_BACKOFF_CAP_MS = 3600_000;

/** One watch per store: a second start for the same store is refused, so no repository is polled twice at once. */
const registered = new Map<DatabaseSync, Watch>();

const proposalOf = (row: Record<string, unknown>): Proposal => ({
  id: Number(row.id),
  repository: String(row.repository),
  number: Number(row.number),
  url: String(row.url),
  title: String(row.title),
  author: row.author === null ? null : String(row.author),
  repoPath: String(row.repo_path),
  firstSeenAt: String(row.first_seen_at),
});

/** Still proposed, and no run was started from an issue fetch of the same repository and number. */
const OPEN_PROPOSAL = `w.state = 'proposed' AND NOT EXISTS (SELECT 1 FROM runs r JOIN issue_fetches f ON f.id = r.issue_fetch_id WHERE lower(f.repository) = lower(w.repository) AND f.number = w.number)`;

/** The proposals in the store, newest first. Read by the routes too, with no watch running. */
export function listProposals(db: DatabaseSync): Proposal[] {
  return db.prepare(`SELECT w.* FROM watched_issues w WHERE ${OPEN_PROPOSAL} ORDER BY w.id DESC`).all().map(proposalOf);
}

export function startWatch(o: WatchOptions): Watch {
  if (registered.has(o.db)) throw new Error("The issue watch is already running for this store. Stop it before starting another.");
  const { db } = o;
  const clock = o.now ?? Date.now;
  const cwd = o.cwd ?? process.cwd();
  const timed = o.timers !== false;
  const entries = watchedRepositories(o.config);
  const statuses = new Map<string, WatchStatus>(entries.map((e) => [e.path, { path: e.path, repository: null, label: e.label, intervalMinutes: e.intervalMinutes, state: "waiting", checkedAt: null, problem: null, said: null, nextAt: null }]));
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Map<string, Promise<void>>();
  /** How many polls of a repository in a row GitHub's limits stopped: the backoff doubles with each. */
  const limited = new Map<string, number>();
  let closed = false;

  const changed = (): void => {
    try {
      o.onChange?.();
    } catch (err) {
      console.error(`Telling the screens that the issue watch changed failed: ${words(err)}`);
    }
  };

  const schedule = (path: string, delayMs: number): void => {
    const status = statuses.get(path)!;
    status.nextAt = new Date(clock() + delayMs).toISOString();
    if (!timed || closed) return;
    clearTimeout(timers.get(path));
    const timer = setTimeout(() => void pollNow(path), delayMs);
    timer.unref();
    timers.set(path, timer);
  };

  /** Store the issues not seen before, all together, and return the proposals that are new. */
  const remember = (repository: string, repoPath: string, issues: WatchedIssue[]): Proposal[] =>
    transaction(db, () => {
      const at = nowIso();
      const insert = db.prepare("INSERT INTO watched_issues (repository, number, repo_path, url, title, author, state, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?) ON CONFLICT (repository, number) DO NOTHING RETURNING *");
      return issues.flatMap((issue) => insert.all(repository, issue.number, repoPath, issue.url, issue.title, issue.author, at).map(proposalOf));
    });

  const poll = async (path: string): Promise<void> => {
    const entry = entries.find((e) => e.path === path)!;
    const status = statuses.get(path)!;
    const intervalMs = entry.intervalMinutes * 60_000;
    let nextMs = intervalMs;
    status.state = "checking";
    changed();
    const fail = (problem: string, said: string | null): void => {
      Object.assign(status, { state: "failed", problem, said: said === "" ? null : said });
    };
    try {
      const found = await githubOfRepository(o.config, path);
      if ("problem" in found) return fail(`${found.problem} Botbench reads the issues of the GitHub repository the remote names.`, null);
      status.repository = repoName(found.repo);
      const result = await o.run(ghArgs.watchIssues(found.repo, entry.label), { cwd });
      if (!result.started) return fail("The gh tool is not installed, or is not on the PATH Botbench runs with. Install it and sign in with gh auth login in a terminal.", null);
      if (result.code !== 0) {
        const said = ghSaid(result);
        if (ghSaysLimited(result)) {
          const attempt = (limited.get(path) ?? 0) + 1;
          limited.set(path, attempt);
          // The head of one GitHub answer says how long: retry-after, or the reset of x-ratelimit-remaining 0.
          const probe = await o.run(ghArgs.watchHead(found.repo), { cwd });
          const head = probe.started ? parseApiHead(probe.stdout) : null;
          const wait = (head === null ? null : githubRetryDelay(head, { attempt, now: clock(), baseMs: intervalMs, capMs: LIMIT_BACKOFF_CAP_MS })) ?? backoffMs({ attempt, baseMs: intervalMs, capMs: LIMIT_BACKOFF_CAP_MS });
          nextMs = Math.max(intervalMs, wait);
          return fail("GitHub asked Botbench to wait before it reads the issues again.", said);
        }
        const signIn = /gh auth login/.test(said);
        return fail(signIn ? "The gh tool is not signed in. Run gh auth login in a terminal on this Mac." : "The gh tool could not list the issues.", said === "" ? `It stopped with exit code ${result.code ?? "none"}.` : said);
      }
      limited.delete(path);
      const issues = parseWatchedIssues(result.stdout, found.repo, entry.label);
      if (closed) return;
      const added = remember(repoName(found.repo), path, issues);
      Object.assign(status, { state: "checked", checkedAt: nowIso(), problem: null, said: null });
      for (const proposal of added) {
        try {
          o.onProposed?.(proposal);
        } catch (err) {
          console.error(`Telling the owner about issue #${proposal.number} of ${proposal.repository} failed: ${words(err)}`);
        }
      }
    } catch (err) {
      // An answer that cannot be read, or a store that cannot write: nothing was stored, so nothing is lost.
      fail(words(err), null);
    } finally {
      schedule(path, nextMs);
      changed();
    }
  };

  const pollNow = (path: string): Promise<void> => {
    if (closed || !statuses.has(path)) return Promise.resolve();
    const under = running.get(path);
    if (under !== undefined) return under;
    const p = poll(path).finally(() => running.delete(path));
    running.set(path, p);
    return p;
  };

  const watch: Watch = {
    pollNow,
    status: () => entries.map((e) => ({ ...statuses.get(e.path)! })),
    proposals: () => listProposals(db),
    proposal: (id) => {
      const row = db.prepare(`SELECT w.* FROM watched_issues w WHERE w.id = ? AND ${OPEN_PROPOSAL}`).get(id);
      return row === undefined ? null : proposalOf(row);
    },
    dismiss: (id) => {
      const done = Number(db.prepare("UPDATE watched_issues SET state = 'dismissed', dismissed_at = ? WHERE id = ? AND state = 'proposed'").run(nowIso(), id).changes) > 0;
      if (done) changed();
      return done;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...running.values()]);
      registered.delete(db);
    },
  };
  registered.set(db, watch);
  if (timed) for (const e of entries) schedule(e.path, 0);
  return watch;
}
