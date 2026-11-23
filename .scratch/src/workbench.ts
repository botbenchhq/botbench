import os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "./store/db.ts";

/*
 * The workbench: this installation's name (Peers, step P1). Two developers each run their own Botbench on one
 * repository, and every installation numbers its runs from 1, so a task's branch carries the workbench's name:
 * `botbench/<workbench>/run-N/task-M`. Two installations with different names can never make the same branch name.
 *
 * The name is the settings file's `workbench` when it sets one; otherwise the one kept in the data folder
 * (`workbench_names`, append-only): derived once from this Mac's host name at first start, and changed only when the
 * owner changes it in Settings. Every name this installation has had stays in that table, so a branch made before a
 * rename is still known as this installation's own, and a branch under any other name is never treated as its own.
 *
 * The name becomes part of a git ref, so it is held to a strict pattern.
 */

const WORKBENCH = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
export const WORKBENCH_RULE = 'A workbench name is 1 to 30 lowercase letters, digits and hyphens, and starts and ends with a letter or digit, such as "jons-mac".';

/** Why `name` cannot be a workbench name, or null. */
export function workbenchProblem(name: unknown): string | null {
  return typeof name === "string" && WORKBENCH.test(name) ? null : WORKBENCH_RULE;
}
export const isWorkbench = (name: unknown): name is string => workbenchProblem(name) === null;

/** A workbench name made from a host name: its first label, in lowercase, with anything but letters and digits made a hyphen. */
export function deriveWorkbench(host: string): string {
  const first = host.split(".")[0] ?? "";
  const reduced = first.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 30).replace(/-+$/, "");
  return isWorkbench(reduced) ? reduced : "workbench";
}

/** A task branch's parts. `workbench` is null for the two forms made before workbenches had names. */
export interface TaskBranch {
  prefix: "botbench" | "smelt";
  workbench: string | null;
  run: string;
  task: string;
}

/** A run's or task's part of a branch name, as a worktree's ids are made (src/worktrees.ts). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The parts of a Botbench task branch, or null for anything else. Three forms, and nothing else:
 * `botbench/<workbench>/<run>/<task>` (now), `botbench/<run>/<task>` (before workbenches had names) and
 * `smelt/<run>/<task>` (before the product was renamed).
 */
export function parseTaskBranch(branch: string): TaskBranch | null {
  if (typeof branch !== "string") return null;
  const parts = branch.split("/");
  const [first, ...rest] = parts;
  if (first === "smelt" || first === "botbench") {
    if (rest.length === 2 && rest.every((p) => SEGMENT.test(p))) return { prefix: first, workbench: null, run: rest[0]!, task: rest[1]! };
    if (first === "botbench" && rest.length === 3 && WORKBENCH.test(rest[0]!) && SEGMENT.test(rest[1]!) && SEGMENT.test(rest[2]!)) return { prefix: first, workbench: rest[0]!, run: rest[1]!, task: rest[2]! };
  }
  return null;
}

/**
 * The branch a rejected task's learning is committed on (engine/learnings.ts): `botbench-lesson/<workbench>/task-<id>`.
 * It sits outside `botbench/`, so it is never taken for a task branch: never decided on, discarded or pushed as one.
 */
export const LESSON_PREFIX = "botbench-lesson/";
export function lessonBranch(workbench: string, taskId: number): string {
  if (!isWorkbench(workbench)) throw new Error(`Invalid workbench name ${JSON.stringify(workbench)}: ${WORKBENCH_RULE}`);
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new Error(`Invalid task id ${JSON.stringify(taskId)}: a task's id is a whole number from 1.`);
  return `${LESSON_PREFIX}${workbench}/task-${taskId}`;
}
const LESSON = /^botbench-lesson\/([^/]+)\/task-[1-9][0-9]{0,15}$/;
/** Whether `branch` is a lesson branch by its name, and nothing else. */
export function isLessonBranch(branch: unknown): branch is string {
  const match = typeof branch === "string" ? LESSON.exec(branch) : null;
  return match !== null && isWorkbench(match[1]);
}

type Source = "host" | "owner" | "settings_file";
/** In a transaction of its own, or in the caller's when one is open. */
const atomically = <T>(db: DatabaseSync, fn: () => T): T => (db.isTransaction ? fn() : transaction(db, fn));

const latest = (db: DatabaseSync): string | null => {
  const row = db.prepare("SELECT name FROM workbench_names ORDER BY id DESC LIMIT 1").get();
  return row === undefined ? null : String(row.name);
};

/** This installation's workbench name now. At first start it is made from the host name and kept. */
export function workbenchName(db: DatabaseSync, host: () => string = os.hostname): string {
  return atomically(db, () => {
    const have = latest(db);
    if (have !== null) return have;
    const made = deriveWorkbench(host());
    db.prepare("INSERT INTO workbench_names (name, source, chosen_at) VALUES (?, 'host', ?)").run(made, now());
    return made;
  });
}

/** Make `name` the workbench name; new branches carry it, existing ones keep theirs. Throws when it is not a workbench name. */
export function chooseWorkbench(db: DatabaseSync, name: unknown, source: Exclude<Source, "host">): string {
  if (!isWorkbench(name)) throw new Error(WORKBENCH_RULE);
  atomically(db, () => {
    if (latest(db) !== name) db.prepare("INSERT INTO workbench_names (name, source, chosen_at) VALUES (?, ?, ?)").run(name, source, now());
  });
  return name;
}

/** Every name this installation has had, the current one among them. */
export function ownWorkbenches(db: DatabaseSync): Set<string> {
  workbenchName(db);
  return new Set(db.prepare("SELECT DISTINCT name FROM workbench_names").all().map((row) => String(row.name)));
}

/**
 * Whether `branch` is one of this installation's own task branches by its name: one of the two forms from before
 * workbenches had names, or the named form under a name this installation has had. Another workbench's branch is not.
 */
export function isOwnBranch(db: DatabaseSync, branch: string): boolean {
  const parsed = parseTaskBranch(branch);
  if (parsed === null) return false;
  return parsed.workbench === null || ownWorkbenches(db).has(parsed.workbench);
}

/** The refusal for a branch that is not this installation's own. */
export const notOwnWords = (branch: string): string => {
  const parsed = parseTaskBranch(branch);
  return parsed?.workbench != null ? `The branch ${branch} belongs to another workbench (${parsed.workbench}), not this one, so Botbench leaves it alone.` : `The branch ${branch} is not one of Botbench's task branches, so Botbench leaves it alone.`;
};
