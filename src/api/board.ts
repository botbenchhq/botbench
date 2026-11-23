import fs from "node:fs";
import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { ListError, chatRow, isChat, listChats, renameChat } from "../engine/chats.ts";
import { ENDED_UNREVIEWED } from "../engine/decision.ts";
import { deliveryOf } from "../engine/delivery.ts";
import { getRun, runTasks, type Run } from "../engine/run.ts";
import { getTask, type Task } from "../engine/task.ts";
import { now } from "../store/db.ts";
import { taskBranches } from "../worktrees.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";
import { summary as runSummary } from "./runs.ts";
import { summary as taskSummary } from "./tasks.ts";

/*
 * The runs board (unit 16): what needs the owner, what is running, what finished, and the chats. Planned runs are on it
 * as runs, and so is each task started on its own, which is a run of one (`runs.kind = 'single'`) with no state but its
 * task's. A task of a planned run is on the board only as part of its run. Each chat is a row of its own group, named
 * by its first attempt (engine/chats.ts).
 *
 * Each row carries what its More menu is built from, read as things are now: the branch while git still has it, the
 * pull request while it is open, whether the run can still be cancelled and whether the task has something left to
 * discard. The owner may hide a row from the list and show it again (`hidden_rows`): that changes what the list shows
 * and nothing else; no run, task, chat, branch or copy is changed or deleted by it.
 */

type Group = "needs-you" | "running" | "finished" | "chats";
const ORDER: readonly Group[] = ["needs-you", "running", "finished", "chats"];
type Kind = "run" | "task" | "chat";
const KINDS: readonly Kind[] = ["run", "task", "chat"];

/** A planned run's group: it needs the owner while its plan waits for approval, its agent waits for an answer, or a task of it is ready for review. */
function runGroup(run: Record<string, unknown>): Group {
  if (run.status === "awaiting_plan_approval" || run.waitingOnApproval === true || (run.readyCount as number) > 0) return "needs-you";
  return run.status === "planning" || run.status === "running" ? "running" : "finished";
}

/** A stand-alone task's group, by the same rule. */
function taskGroup(task: Record<string, unknown>): Group {
  if (task.status === "awaiting_decision" || task.waitingOnApproval === true) return "needs-you";
  // A task waiting for a usage limit is still on its way: Botbench resumes it by itself.
  return task.status === "queued" || task.status === "building" || task.status === "verifying" || task.status === "reviewing" || task.status === "waiting_for_limit" ? "running" : "finished";
}

/** How many finished items, and chats, the board sends; the groups that need the owner or are at work are always sent whole. */
export const FINISHED_SHOWN = 100;

/** The run states a run can still be cancelled in, as its own screen offers it: planning, at the plan, or building. */
const CANCELLABLE = new Set<Run["status"]>(["planning", "awaiting_plan_approval", "running"]);

/**
 * The task branches of each repository, read once per board. A repository git cannot read now (moved or deleted) has
 * none Botbench can point to, so no row of it offers its branch.
 */
function branchReader(): (repo: string) => Promise<Set<string>> {
  const read = new Map<string, Promise<Set<string>>>();
  return (repo) => {
    if (!read.has(repo)) read.set(repo, taskBranches(repo).catch(() => new Set<string>()));
    return read.get(repo)!;
  };
}

/** A task's pull request while it is open on GitHub, as Botbench last read it; null otherwise. */
function openPullRequest(db: DatabaseSync, task: Task): { number: number; url: string } | null {
  const delivery = deliveryOf(db, task);
  return delivery.state === "opened" && delivery.prState === "OPEN" && delivery.number !== null && delivery.url !== null ? { number: delivery.number, url: delivery.url } : null;
}

/** What a stand-alone task's More menu offers besides Open and Hide. */
async function taskMenu(db: DatabaseSync, task: Task, branches: (repo: string) => Promise<Set<string>>): Promise<Record<string, unknown>> {
  const branch = task.branch !== null && (await branches(task.repo)).has(task.branch) ? task.branch : null;
  const copy = task.worktreePath !== null && fs.existsSync(task.worktreePath);
  return { branch, pullRequest: openPullRequest(db, task), discardable: ENDED_UNREVIEWED.has(task.status) && (copy || branch !== null) };
}

/** What a planned run's More menu offers besides Open and Hide: its branch and its pull request when it has exactly one. */
async function runMenu(db: DatabaseSync, run: Run, branches: (repo: string) => Promise<Set<string>>): Promise<Record<string, unknown>> {
  const tasks = runTasks(db, run.id);
  const have = await branches(run.repo);
  const named = tasks.flatMap((task) => (task.branch !== null && have.has(task.branch) ? [task.branch] : []));
  const open = tasks.flatMap((task) => openPullRequest(db, task) ?? []);
  return { branch: named.length === 1 ? named[0] : null, pullRequest: open.length === 1 ? open[0] : null, cancellable: CANCELLABLE.has(run.status) };
}

/** The rows the owner hid, as `kind id`. */
const hiddenRows = (db: DatabaseSync): Set<string> => new Set(db.prepare("SELECT kind, item_id FROM hidden_rows").all().map((row) => `${String(row.kind)} ${Number(row.item_id)}`));

export interface Board {
  groups: { name: Group; total: number; items: Record<string, unknown>[] }[];
  /** How many rows are hidden from the list. */
  hidden: number;
}

/**
 * Every group in order, the one that needs the owner first, each newest change first. Every run and every stand-alone
 * task is read, so nothing that needs the owner is ever left out; Finished and Chats send the newest `FINISHED_SHOWN`
 * and say how many there are in all. `total` is each group's real count. With `hidden`, the groups hold only the rows
 * the owner hid; without, only the others. Either way `hidden` counts the hidden rows.
 */
export async function board(db: DatabaseSync, o: { hidden?: boolean } = {}): Promise<Board> {
  const branches = branchReader();
  const items: { group: Group; item: Record<string, unknown> }[] = [];
  for (const row of db.prepare("SELECT id FROM runs WHERE kind = 'planned'").all()) {
    const run = getRun(db, Number(row.id))!;
    const item = { kind: "run", ...runSummary(db, run), ...(await runMenu(db, run, branches)) };
    items.push({ group: runGroup(item), item });
  }
  // A task of a planned run is shown with its run. Only a run of one, or a task from before runs were numbered, is its own row.
  for (const row of db.prepare("SELECT t.id FROM tasks t LEFT JOIN runs r ON r.id = t.run_id WHERE r.id IS NULL OR r.kind = 'single'").all()) {
    const task = getTask(db, Number(row.id))!;
    const { id, repo, prompt, status, reason, checks, waitingOnApproval, resuming, restartLine, waitingFor, createdAt, updatedAt } = taskSummary(db, task) as Record<string, unknown> & { prompt: string };
    const item = { kind: "task", id, repo, title: prompt.trim().split("\n")[0]!, status, reason, checks, waitingOnApproval, resuming, restartLine, waitingFor, createdAt, updatedAt, ...(await taskMenu(db, task, branches)) };
    items.push({ group: taskGroup(item), item });
  }
  for (const chat of listChats(db)) items.push({ group: "chats", item: { kind: "chat", ...chat } });
  const hidden = hiddenRows(db);
  const isHidden = (item: Record<string, unknown>): boolean => hidden.has(`${String(item.kind)} ${Number(item.id)}`);
  const shown = items.filter((entry) => isHidden(entry.item) === (o.hidden === true));
  shown.sort((a, b) => String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)));
  return {
    groups: ORDER.map((name) => {
      const all = shown.filter((entry) => entry.group === name).map((entry) => entry.item);
      return { name, total: all.length, items: name === "finished" || name === "chats" ? all.slice(0, FINISHED_SHOWN) : all };
    }),
    hidden: items.filter((entry) => isHidden(entry.item)).length,
  };
}

/** Whether `kind` `id` is a row of the list: a planned run, a task started on its own, or a recorded chat. */
function listed(db: DatabaseSync, kind: Kind, id: number): boolean {
  if (kind === "run") return db.prepare("SELECT 1 FROM runs WHERE id = ? AND kind = 'planned'").get(id) !== undefined;
  if (kind === "task") return db.prepare("SELECT 1 FROM tasks t LEFT JOIN runs r ON r.id = t.run_id WHERE t.id = ? AND (r.id IS NULL OR r.kind = 'single')").get(id) !== undefined;
  return isChat(db, id);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// voice: not on screen. It names the API's own fields for a caller whose request was malformed; the client never sends one.
const ROW_EXPECTED = 'expected { "kind": "run" | "task" | "chat", "id": number }';
const NOT_LISTED: Record<Kind, string> = { run: "There is no such run in the list.", task: "There is no such task in the list: a task of a planned run is listed with its run.", chat: "There is no such chat in the list." };

/**
 * Hide a row from the list, or show it again. Idempotent: hiding a hidden row, or showing a shown one, changes nothing.
 * Only `hidden_rows` is written: the run, task or chat itself, and its branch and copy, are not touched.
 */
async function setHidden(req: http.IncomingMessage, db: DatabaseSync, hide: boolean): Promise<{ kind: Kind; id: number; hidden: boolean }> {
  const body = await readJsonBody(req);
  if (!isObject(body) || !KINDS.includes(body.kind as Kind) || !(typeof body.id === "number" && Number.isSafeInteger(body.id) && body.id > 0)) throw new BodyError(400, ROW_EXPECTED);
  const kind = body.kind as Kind;
  const id = body.id;
  if (!listed(db, kind, id)) throw new ListError(404, NOT_LISTED[kind]);
  if (hide) db.prepare("INSERT OR IGNORE INTO hidden_rows (kind, item_id, hidden_at) VALUES (?, ?, ?)").run(kind, id, now());
  else db.prepare("DELETE FROM hidden_rows WHERE kind = ? AND item_id = ?").run(kind, id);
  return { kind, id, hidden: hide };
}

/**
 * The board's routes: the list (`?hidden=1` for the rows hidden from it), hiding and showing a row, and a chat as a
 * device opens it, with renaming it. Returns false when the request is for anything else. Called only for requests the
 * auth gate let through.
 */
export async function boardRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  const { pathname } = url;
  const method = req.method;
  const chat = /^\/api\/chats\/([1-9]\d{0,14})(\/rename)?$/.exec(pathname);
  try {
    if (method === "GET" && pathname === "/api/board") json(res, 200, await board(ctx.db, { hidden: url.searchParams.get("hidden") === "1" }));
    else if (method === "POST" && (pathname === "/api/board/hide" || pathname === "/api/board/show")) json(res, 200, await setHidden(req, ctx.db, pathname.endsWith("/hide")));
    else if (chat && method === "GET" && chat[2] === undefined) {
      const found = chatRow(ctx.db, Number(chat[1]));
      if (found === null) throw new ListError(404, NOT_LISTED.chat);
      json(res, 200, found);
    } else if (chat && method === "POST" && chat[2] === "/rename") {
      const body = await readJsonBody(req);
      json(res, 200, renameChat(ctx.db, Number(chat[1]), isObject(body) ? body.title : undefined));
    } else return false;
  } catch (err) {
    if (err instanceof BodyError || err instanceof ListError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
