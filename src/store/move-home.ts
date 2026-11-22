import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SOCKET_FILE, socketAnswers } from "../approvals/broker.ts";
import type { Log } from "../config.ts";
import { repairWorktrees } from "../worktrees.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DB_FILE, transaction } from "./db.ts";

// Botbench was called Smelt. An installation from then keeps its data in ~/.smelt, in a database named smelt.sqlite,
// and its task worktrees under ~/.smelt/worktrees. This module moves such an installation into place before anything
// opens it. It never deletes data, and it never copies: a folder or file is renamed, which is atomic on one file
// system, or the start stops and says what to do.

/** The database's file name before the rename. */
export const LEGACY_DB_FILE = "smelt.sqlite";
/**
 * Left in the data folder while git's links to the task worktrees still name the old folder. It holds that old
 * folder's path, and it moves with the folder, so a start stopped half-way (or a folder the owner moved by hand after
 * a failed start) is finished by the next start.
 */
export const REPAIR_MARKER = "repair-worktrees";

const present = (p: string): boolean => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
/** The write-ahead log and shared-memory files first, the database last: a database is never found without its log. */
const DB_PARTS = ["-wal", "-shm", ""];

/**
 * Move an installation from before the rename into place. `legacy` is the old default folder, or null when the owner
 * named the data folder; a database under its old name inside `home` is renamed either way.
 */
export async function moveOldHome(o: { home: string; legacy: string | null; log: Log }): Promise<void> {
  if (o.legacy !== null && path.resolve(o.legacy) !== path.resolve(o.home) && present(o.legacy)) {
    if (present(o.home)) {
      o.log(`Using ${o.home}. The old data folder ${o.legacy} was left untouched and is not read; move what you still need from it yourself, or delete it once you are sure.`);
    } else {
      // A Smelt still running there would go on writing through its open files after the move: it is stopped first.
      if (await socketAnswers(path.join(o.legacy, SOCKET_FILE))) {
        throw new Error(`The old data folder ${o.legacy} is still in use: Smelt is still running on it. Nothing was moved. Stop it (for a login service: launchctl bootout, or unload its plist), then start Botbench again.`);
      }
      const renamed = moveFolder(o.legacy, o.home);
      o.log(`Moved the data folder ${o.legacy} to ${o.home}${renamed ? ` and renamed its database from ${LEGACY_DB_FILE} to ${DB_FILE}` : ""}: Smelt is now called Botbench.`);
      await finishRepair(o.home, o.log);
      return;
    }
  }
  if (renameDatabase(o.home, o.log)) o.log(`Renamed the database in ${o.home} from ${LEGACY_DB_FILE} to ${DB_FILE}: Smelt is now called Botbench.`);
  await finishRepair(o.home, o.log);
}

const stopped = (what: string, legacy: string, home: string, err: unknown): Error =>
  new Error(
    `${what}: ${err instanceof Error ? err.message : String(err)}. Nothing was deleted: everything is still in ${legacy}. ` +
      `Fix the cause and start Botbench again, or move the folder yourself (mv ${legacy} ${home}) and start it again.`,
    { cause: err },
  );

/** Rename `legacy` to `home`, with its database renamed inside it first. Returns whether the database was renamed. */
function moveFolder(legacy: string, home: string): boolean {
  let renamed: boolean;
  try {
    writeFileAtomic(path.join(legacy, REPAIR_MARKER), `${path.resolve(legacy)}\n`, 0o600);
    renamed = renameDatabase(legacy, () => {});
  } catch (err) {
    throw stopped(`The data folder ${legacy} could not be prepared for its move to ${home}`, legacy, home, err);
  }
  try {
    fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
    // One rename: the folder, with everything in it and its owner-only modes, is either still there or here.
    fs.renameSync(legacy, home);
  } catch (err) {
    throw stopped(`The data folder could not be moved from ${legacy} to ${home}`, legacy, home, err);
  }
  return renamed;
}

/** Rename `dir`'s database from its old name to its new one. Returns whether anything was renamed. */
function renameDatabase(dir: string, log: Log): boolean {
  const from = path.join(dir, LEGACY_DB_FILE);
  const to = path.join(dir, DB_FILE);
  const left = DB_PARTS.filter((part) => present(from + part));
  if (left.length === 0) return false;
  if (present(to)) {
    log(`${dir} holds both ${LEGACY_DB_FILE} and ${DB_FILE}. ${DB_FILE} is used; ${LEGACY_DB_FILE} was left untouched and is not read.`);
    return false;
  }
  for (const part of left) {
    if (present(to + part)) throw new Error(`${to + part} is in the way of renaming ${from + part}. Nothing was renamed or deleted; move one of them aside, then start Botbench again.`);
    fs.renameSync(from + part, to + part);
  }
  return true;
}

/**
 * After the data folder moved: point the tasks' stored worktree paths at the new folder, then have git repair its
 * links, repository by repository. The marker is removed only once every repository that still exists was repaired;
 * until then each start tries again and says what failed.
 */
async function finishRepair(home: string, log: Log): Promise<void> {
  const marker = path.join(home, REPAIR_MARKER);
  if (!present(marker)) return;
  const old = fs.readFileSync(marker, "utf8").trim();
  const byRepo = new Map<string, string[]>();
  const file = path.join(home, DB_FILE);
  if (present(file)) {
    const db = new DatabaseSync(file);
    try {
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'").get()) {
        const rows = db.prepare("SELECT id, repo_path, worktree_path FROM tasks WHERE worktree_path IS NOT NULL").all() as { id: number; repo_path: string; worktree_path: string }[];
        const update = db.prepare("UPDATE tasks SET worktree_path = ? WHERE id = ?");
        transaction(db, () => {
          for (const row of rows) {
            if (old === "" || !row.worktree_path.startsWith(old + path.sep)) continue;
            row.worktree_path = path.join(path.resolve(home), row.worktree_path.slice(old.length + 1));
            update.run(row.worktree_path, row.id);
          }
        });
        for (const row of rows) {
          if (!row.worktree_path.startsWith(path.resolve(home) + path.sep) || !present(row.worktree_path)) continue;
          byRepo.set(row.repo_path, [...(byRepo.get(row.repo_path) ?? []), row.worktree_path]);
        }
      }
    } finally {
      db.close();
    }
  }
  let failed = false;
  for (const [repo, paths] of byRepo) {
    if (!present(repo)) continue;
    try {
      await repairWorktrees(repo, paths);
    } catch (err) {
      failed = true;
      log(`The links between ${repo} and its task copies under ${home} could not be repaired: ${err instanceof Error ? err.message : String(err)} Botbench tries again at its next start; until then do not run "git worktree prune" in ${repo}.`);
    }
  }
  if (!failed) fs.rmSync(marker);
}
