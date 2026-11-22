import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { getRun } from "../engine/run.ts";
import { getTask } from "../engine/task.ts";
import { json, type RouteContext } from "./router.ts";
import { summary as runSummary } from "./runs.ts";
import { summary as taskSummary } from "./tasks.ts";

/*
 * The runs board (unit 16): what needs the owner, what is running, what finished. Planned runs are on it as runs, and
 * so is each task started on its own, which is a run of one (`runs.kind = 'single'`) with no state but its task's. A
 * task of a planned run is on the board only as part of its run.
 */

type Group = "needs-you" | "running" | "finished";
const ORDER: readonly Group[] = ["needs-you", "running", "finished"];

/** A planned run's group: it needs the owner while its plan waits for approval, its agent waits for an answer, or a task of it is ready for review. */
function runGroup(run: Record<string, unknown>): Group {
  if (run.status === "awaiting_plan_approval" || run.waitingOnApproval === true || (run.readyCount as number) > 0) return "needs-you";
  return run.status === "planning" || run.status === "running" ? "running" : "finished";
}

/** A stand-alone task's group, by the same rule. */
function taskGroup(task: Record<string, unknown>): Group {
  if (task.status === "awaiting_decision" || task.waitingOnApproval === true) return "needs-you";
  return task.status === "queued" || task.status === "building" || task.status === "verifying" || task.status === "reviewing" ? "running" : "finished";
}

/** How many finished items the board sends; the groups that need the owner or are at work are always sent whole. */
export const FINISHED_SHOWN = 100;

/**
 * Every group in order, the one that needs the owner first, each newest change first. Every run and every stand-alone
 * task is read, so nothing that needs the owner is ever left out; Finished sends the newest `FINISHED_SHOWN` and says how
 * many there are in all. `total` is each group's real count.
 */
export function board(db: DatabaseSync): { name: Group; total: number; items: Record<string, unknown>[] }[] {
  const items: { group: Group; item: Record<string, unknown> }[] = [];
  for (const row of db.prepare("SELECT id FROM runs WHERE kind = 'planned'").all()) {
    const item = { kind: "run", ...runSummary(db, getRun(db, Number(row.id))!) };
    items.push({ group: runGroup(item), item });
  }
  // A task of a planned run is shown with its run. Only a run of one, or a task from before runs were numbered, is its own row.
  for (const row of db.prepare("SELECT t.id FROM tasks t LEFT JOIN runs r ON r.id = t.run_id WHERE r.id IS NULL OR r.kind = 'single'").all()) {
    const { id, repo, prompt, status, reason, checks, waitingOnApproval, resuming, createdAt, updatedAt } = taskSummary(db, getTask(db, Number(row.id))!) as Record<string, unknown> & { prompt: string };
    const item = { kind: "task", id, repo, title: prompt.trim().split("\n")[0]!, status, reason, checks, waitingOnApproval, resuming, createdAt, updatedAt };
    items.push({ group: taskGroup(item), item });
  }
  items.sort((a, b) => String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)));
  return ORDER.map((name) => {
    const all = items.filter((entry) => entry.group === name).map((entry) => entry.item);
    return { name, total: all.length, items: name === "finished" ? all.slice(0, FINISHED_SHOWN) : all };
  });
}

/** The board's one route. Returns false when the request is for anything else. Called only for requests the auth gate let through. */
export function boardRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): boolean {
  if (req.method !== "GET" || url.pathname !== "/api/board") return false;
  json(res, 200, { groups: board(ctx.db) });
  return true;
}
