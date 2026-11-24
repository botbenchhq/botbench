import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { CLAUDE_CODE } from "../drivers/claude-code.ts";
import { listChats } from "../engine/chats.ts";
import { taskDecision } from "../engine/decision.ts";
import { deliveryOf } from "../engine/delivery.ts";
import { currentBuilder } from "../engine/handoff.ts";
import { byNeed, placeChat, placeRun, placeTask, type Cause, type Place, type Placed } from "../engine/queue.ts";
import { getRun, runTasks, type Run } from "../engine/run.ts";
import { getTask, resumeNote, type Task } from "../engine/task.ts";
import { branchReader, hiddenRows, runMenu, taskMenu, KINDS, type Kind } from "./board.ts";
import { BodyError, json, type RouteContext } from "./router.ts";
import { summary as runSummary } from "./runs.ts";
import { evidenceStateOf, summary as taskSummary } from "./tasks.ts";

/*
 * Home and Work, as the server says them (the rule is engine/queue.ts; nothing of it is worked out by a client).
 *
 *   GET /api/home         the queue: everything that needs the owner, whole and in order, then what is in progress,
 *                         what waits (with what for) and what was completed, each counted truly and cut to a few rows
 *                         with the counts a summary needs
 *   GET /api/home/count   how many things need the owner, for the navigation's mark
 *   GET /api/work         the inventory, newest change first: `q` (words in a title), `kind`, `state`, `hidden=1`,
 *                         `limit` and `cursor`. Every value is checked; a wrong one is refused, never guessed at.
 *
 * What is listed is what the old board lists: each planned run, each task started on its own, each chat. A task of a
 * planned run is part of its run. A row the owner hid from the list is left out of Work and of Home's lower groups,
 * but never out of Needs you: what waits for the owner is always shown.
 */

/** One listed row with where it stands, before anything is cut or filtered. `row` is the row as /api/board sends it, without its menu. */
interface Entry extends Placed {
  kind: Kind;
  id: number;
  title: string;
  repo: string | null;
  /** The agents at work on it: a task's builder, a run's builder, a chat's agents in the order they first answered. */
  agents: string[];
  /** When what it stands at began: the request, for an approval; else the last move of the task (the oldest one of a run) that put it there, or of the run itself. */
  since: string;
  updatedAt: string;
  hidden: boolean;
  /** Who decides on it (engine/modes.ts); null for a chat. */
  mode: string | null;
  row: Record<string, unknown>;
  run?: Run;
  task?: Task;
  /** The tasks of a planned run. */
  tasks?: Task[];
  /** The oldest request of it that waits for the owner's answer, when one does. */
  asks: Asks | null;
  /** For a failure to recover: whether the task that can be resumed stopped or failed, and why, in its own stored words. */
  failure: { how: "stopped" | "failed"; reason: string | null } | null;
  /** For a wait on a usage limit: when Botbench tries again, when that is stored. */
  retryAt: string | null;
}

interface Asks {
  tool: string;
  command: string;
  since: string;
  /** The agent that asks: the one whose session the request came from. */
  agent: string;
}

/** The oldest request that waits for the owner's answer among those `where` selects: what it asks, and since when. */
function waitingApproval(db: DatabaseSync, where: string, ...values: number[]): Asks | null {
  const row = db.prepare(`SELECT a.tool, a.command, a.created_at, s.driver FROM approvals a JOIN attempts s ON s.id = a.attempt_id WHERE a.status = 'pending' AND a.stored_decision IS NULL AND (${where}) ORDER BY a.id LIMIT 1`).get(...values);
  return row === undefined ? null : { tool: String(row.tool), command: String(row.command), since: String(row.created_at), agent: String(row.driver) };
}
const taskApproval = (db: DatabaseSync, taskId: number) => waitingApproval(db, "a.task_id = ?", taskId);
const runApproval = (db: DatabaseSync, runId: number) => waitingApproval(db, "a.run_id = ? OR a.task_id IN (SELECT id FROM tasks WHERE run_id = ?)", runId, runId);
const chatApproval = (db: DatabaseSync, chatId: number) => waitingApproval(db, "a.chat = 1 AND a.attempt_id IN (SELECT attempt_id FROM chat_members WHERE chat_id = ?)", chatId);

/** Whether a task stopped or failed and the owner can resume it. Only a stopped or a failed task is asked: the answer reads its copy on disk. */
const resumable = (db: DatabaseSync, task: Task): boolean => (task.status === "interrupted" || task.status === "failed") && resumeNote(db, task) !== null;
const failureOf = (task: Task): Entry["failure"] => ({ how: task.status === "interrupted" ? "stopped" : "failed", reason: task.reason });
const byChange = (a: Task, b: Task): number => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id;

const oldest = (times: string[], otherwise: string): string => (times.length === 0 ? otherwise : times.reduce((a, b) => (a < b ? a : b)));
const AT_WORK = new Set(["queued", "building", "verifying", "reviewing"]);

/** Every listed row, each with where it stands. */
function entries(db: DatabaseSync): Entry[] {
  const hidden = hiddenRows(db);
  const found: Entry[] = [];
  for (const { id } of db.prepare("SELECT id FROM runs WHERE kind = 'planned'").all()) {
    const run = getRun(db, Number(id))!;
    const row = { kind: "run", ...(runSummary(db, run) as Record<string, unknown> & { title: string; waitingOnApproval: boolean }) };
    const tasks = runTasks(db, run.id);
    // The oldest of each comes first: it is the one the run's wait is counted from and the one its row speaks of.
    const toResume = tasks.filter((task) => resumable(db, task)).sort(byChange);
    const ready = tasks.filter((task) => task.status === "awaiting_decision").sort(byChange);
    const limited = tasks.filter((task) => task.status === "waiting_for_limit").sort(byChange);
    const placed = placeRun({ status: run.status, waitingOnApproval: row.waitingOnApproval, resumable: toResume.length, ready: ready.length, accepted: tasks.filter((task) => task.status === "accepted").length, atWork: tasks.filter((task) => AT_WORK.has(task.status)).length, limited: limited.length });
    const asks = placed.cause === "approval" ? runApproval(db, run.id) : null;
    const since =
      placed.cause === "approval" ? (asks?.since ?? run.updatedAt)
      : placed.cause === "failure" ? toResume[0]!.updatedAt
      : placed.cause === "result" ? (ready[0]?.updatedAt ?? run.updatedAt)
      : placed.cause === "usage-limit" ? limited[0]!.updatedAt
      : run.updatedAt;
    // Who is at work on it: the agent that asks, the one whose limit it waits for, else the one that builds its tasks.
    const agent = asks?.agent ?? (placed.cause === "usage-limit" ? currentBuilder(db, limited[0]!, CLAUDE_CODE).agent : (run.buildAgent ?? CLAUDE_CODE));
    const retryAt = placed.cause === "usage-limit" ? oldest(limited.flatMap((task) => task.retryAt ?? []), "") || null : null;
    found.push({ kind: "run", id: run.id, title: row.title, repo: run.repo, agents: [agent], since, updatedAt: run.updatedAt, hidden: hidden.has(`run ${run.id}`), mode: run.mode, row, run, tasks, asks, failure: placed.cause === "failure" ? failureOf(toResume[0]!) : null, retryAt, ...placed });
  }
  // A task of a planned run is shown with its run. Only a run of one, or a task from before runs were numbered, is its own row.
  for (const { id: taskId } of db.prepare("SELECT t.id FROM tasks t LEFT JOIN runs r ON r.id = t.run_id WHERE r.id IS NULL OR r.kind = 'single'").all()) {
    const task = getTask(db, Number(taskId))!;
    const { id, repo, prompt, status, reason, checks, waitingOnApproval, resuming, restartLine, waitingFor, mode, createdAt, updatedAt } = taskSummary(db, task) as Record<string, unknown> & { prompt: string; waitingOnApproval: boolean; mode: string };
    const title = prompt.trim().split("\n")[0]!;
    const row = { kind: "task", id, repo, title, status, reason, checks, waitingOnApproval, resuming, restartLine, waitingFor, createdAt, updatedAt };
    const placed = placeTask({ status: task.status, waitingOnApproval, resumable: resumable(db, task), behindAnother: waitingFor !== null });
    const asks = placed.cause === "approval" ? taskApproval(db, task.id) : null;
    found.push({ kind: "task", id: task.id, title, repo: task.repo, agents: [asks?.agent ?? currentBuilder(db, task, CLAUDE_CODE).agent], since: asks?.since ?? task.updatedAt, updatedAt: task.updatedAt, hidden: hidden.has(`task ${task.id}`), mode, row, task, asks, failure: placed.cause === "failure" ? failureOf(task) : null, retryAt: placed.cause === "usage-limit" ? task.retryAt : null, ...placed });
  }
  for (const chat of listChats(db)) {
    const asks = chatApproval(db, chat.id);
    found.push({ kind: "chat", id: chat.id, title: chat.title, repo: null, agents: asks === null ? chat.agents : [asks.agent], since: asks?.since ?? chat.updatedAt, updatedAt: chat.updatedAt, hidden: hidden.has(`chat ${chat.id}`), mode: null, row: { kind: "chat", ...chat }, asks, failure: null, retryAt: null, ...placeChat({ waitingOnApproval: asks !== null }) });
  }
  return found;
}

/** A task's pull request number once Botbench opened or found one for it; null otherwise. */
const pullRequestOf = (db: DatabaseSync, task: Task): number | null => ((delivery) => (delivery.state === "opened" ? delivery.number : null))(deliveryOf(db, task));

/**
 * One row of Home. Every row says what it is, where it stands and since when; the rest is what its own line needs:
 *   `approval`    for an approval: the tool and the command or target the agent asks to use
 *   `failure`     for a failure to recover: whether the task that can be resumed "stopped" or "failed"; `reason` is why,
 *                 in the task's own stored words
 *   `taskCount`   for a run: how many tasks its plan holds; `finishedCount`, `readyCount` as on the board
 *   `evidence`    for a task that is ready for review: the state of its evidence and the server's sentence about it
 *                 (engine/evidence.ts); null when it cannot be read, and for a run (each of its tasks has its own)
 *   `retryAt`     for a wait on a usage limit: when Botbench tries again, when that is stored
 *   `waitingFor`  for a wait on another task: that task
 *   `accepted`    for completed work: who accepted it ("owner", or "mode" for a fully autonomous run), and the pull
 *                 requests Botbench opened for it, by number
 */
async function homeItem(ctx: Pick<RouteContext, "db" | "config">, entry: Entry): Promise<Record<string, unknown>> {
  const { db } = ctx;
  const { kind, id, title, repo, agents, place, cause, since, updatedAt, mode, row, task, run, tasks, asks, failure, retryAt } = entry;
  const item: Record<string, unknown> = { kind, id, title, repo, agents, place, cause, since, updatedAt, status: kind === "chat" ? null : row.status, mode };
  if (cause === "approval") item.approval = asks === null ? null : { tool: asks.tool, command: asks.command };
  if (cause === "failure") Object.assign(item, { failure: failure?.how ?? "failed", reason: failure?.reason ?? null });
  if (cause === "usage-limit") item.retryAt = retryAt;
  if (run !== undefined && tasks !== undefined) {
    Object.assign(item, { taskCount: row.taskCount, finishedCount: row.finishedCount, readyCount: row.readyCount });
    if (place === "completed") {
      const accepted = tasks.filter((one) => one.status === "accepted");
      item.accepted = { by: accepted.every((one) => taskDecision(db, one.id)?.decidedBy === "mode") ? "mode" : "owner", pullRequests: accepted.flatMap((one) => pullRequestOf(db, one) ?? []) };
    }
  }
  if (task !== undefined) {
    if (cause === "result") {
      const { evidenceState } = await evidenceStateOf(ctx, task);
      Object.assign(item, { checks: task.checks, evidence: evidenceState === null ? null : { state: evidenceState.state, words: evidenceState.words } });
    }
    if (cause === "dependency") item.waitingFor = row.waitingFor;
    if (place === "completed") item.accepted = { by: taskDecision(db, id)?.decidedBy === "mode" ? "mode" : "owner", pullRequests: [pullRequestOf(db, task)].flatMap((n) => n ?? []) };
  }
  return item;
}

/** How many rows of each lower group Home is sent; each group's `total` is its real count. */
export const HOME_SHOWN = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `values` counted by what `of` names for each, the most frequent first, then by name. */
function tally<T>(values: readonly T[], of: (value: T) => string | null): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = of(value);
    if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** How many things need the owner: the listed rows that do, hidden or not, and the cards about a paired workbench's messages. */
function needing(ctx: Pick<RouteContext, "peerLink">, all: readonly Entry[]): { rows: Entry[]; messages: number } {
  return { rows: all.filter((entry) => entry.place === "needs-you").sort(byNeed), messages: ctx.peerLink.cards().length };
}

/**
 * Home. `needsYou.items` is everything that waits for the owner, in the stated order (engine/queue.ts), never cut;
 * `needsYou.messages` counts the cards about a paired workbench's messages, which a device reads from /api/peers/cards,
 * and `needsYou.total` counts both. `inProgress` (the longest at work first), `waiting` (the longest wait first) and
 * `completed` (the newest first) send their first `HOME_SHOWN` rows and what a summary of the whole group says:
 * how many per agent and repository, how many per cause with the earliest time a usage limit is tried again, and of
 * the completed how many were accepted without the owner, how many pull requests were opened and how many were
 * completed in the last 24 hours. `ended` and `failed` count what ended any other way: it is in Work, not on Home.
 */
export async function home(ctx: Pick<RouteContext, "db" | "config" | "peerLink">, now = Date.now()): Promise<Record<string, unknown>> {
  const all = entries(ctx.db);
  const shown = all.filter((entry) => !entry.hidden);
  const needs = needing(ctx, all);
  const of = (place: Place): Entry[] => shown.filter((entry) => entry.place === place);
  const longest = (a: Entry, b: Entry): number => a.since.localeCompare(b.since) || a.id - b.id;
  const inProgress = of("in-progress").sort(longest);
  const waiting = of("waiting").sort(longest);
  const completed = of("completed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
  const items = (rows: Entry[]): Promise<Record<string, unknown>[]> => Promise.all(rows.map((entry) => homeItem(ctx, entry)));
  // The summary of the completed is over all of them, so each is read; only the first few are sent as rows.
  const done = await items(completed);
  const accepted = done.map((item) => item.accepted as { by: string; pullRequests: number[] });
  const waits = await items(waiting);
  const ended = of("ended");
  const endedAs = (entry: Entry): string => {
    const status = String(entry.row.status);
    return status === "rejected" || status === "cancelled" ? status : status === "interrupted" ? "stopped" : entry.kind === "run" && status === "done" && Number(entry.row.decidedCount) > 0 ? "rejected" : "other";
  };
  return {
    needsYou: { total: needs.rows.length + needs.messages, messages: needs.messages, items: await items(needs.rows) },
    inProgress: { total: inProgress.length, items: await items(inProgress.slice(0, HOME_SHOWN)), agents: tally(inProgress, (entry) => entry.agents[0] ?? null), repos: tally(inProgress, (entry) => entry.repo) },
    waiting: {
      total: waiting.length,
      items: waits.slice(0, HOME_SHOWN),
      causes: tally(waiting, (entry) => entry.cause).map(({ name, count }) => ({ cause: name as Cause, count, retryAt: name === "usage-limit" ? oldest(waits.flatMap((item) => (item.cause === name && typeof item.retryAt === "string" ? [item.retryAt] : [])), "") || null : null })),
    },
    completed: {
      total: completed.length,
      items: done.slice(0, HOME_SHOWN),
      lastDay: completed.filter((entry) => now - Date.parse(entry.updatedAt) < DAY_MS).length,
      withoutYou: accepted.filter((one) => one.by === "mode").length,
      pullRequests: accepted.reduce((sum, one) => sum + one.pullRequests.length, 0),
    },
    ended: Object.fromEntries(["rejected", "cancelled", "stopped", "other"].map((name) => [name, ended.filter((entry) => endedAs(entry) === name).length])),
    failed: of("failed").length,
    // Every listed run, task and chat that is not hidden, whatever its state.
    total: shown.length,
  };
}

const STATES = ["any", "needs-you", "in-progress", "waiting", "completed", "failed", "ended"] as const;
type State = (typeof STATES)[number];
const KIND_FILTERS = ["all", ...KINDS] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

/** The most rows one request for Work is sent, and how many when it does not say. */
export const WORK_LIMIT_MAX = 200;
export const WORK_LIMIT = 50;
/** The longest search Work takes, in characters. */
export const WORK_QUERY_MAX = 200;

export interface WorkQuery {
  q: string;
  kind: KindFilter;
  state: State;
  hidden: boolean;
  limit: number;
  /** The row the page starts after, as the last answer named it; null for the first page. */
  after: { updatedAt: string; kind: Kind; id: number } | null;
}

// voice: not on screen. These name the API's own fields and values for a caller whose request was malformed; the client never sends one.
const refuse = (what: string): never => {
  throw new BodyError(400, what);
};

/** Where a page ends, as the next request sends it back: the last row's time of change, kind and number. Opaque to a client. */
const cursorOf = (entry: Pick<Entry, "updatedAt" | "kind" | "id">): string => Buffer.from(JSON.stringify([entry.updatedAt, entry.kind, entry.id])).toString("base64url");

function readCursor(text: string): NonNullable<WorkQuery["after"]> {
  const bad = "cursor: expected the `next` value of an earlier answer, unchanged";
  if (text.length > 200 || !/^[A-Za-z0-9_-]+$/.test(text)) return refuse(bad);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return refuse(bad);
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return refuse(bad);
  const [updatedAt, kind, id] = parsed as unknown[];
  if (typeof updatedAt !== "string" || updatedAt.length > 40 || !KINDS.includes(kind as Kind) || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return refuse(bad);
  return { updatedAt, kind: kind as Kind, id };
}

/** What a request for Work asks, each value checked; a value that is not one of those the route takes is refused with what it takes. */
export function workQuery(params: URLSearchParams): WorkQuery {
  const one = (name: string): string | null => (params.getAll(name).length > 1 ? refuse(`${name}: given more than once`) : params.get(name));
  const q = (one("q") ?? "").trim();
  if ([...q].length > WORK_QUERY_MAX) refuse(`q: at most ${WORK_QUERY_MAX} characters`);
  const kind = one("kind") ?? "all";
  if (!KIND_FILTERS.includes(kind as KindFilter)) refuse(`kind: expected one of ${KIND_FILTERS.join(", ")}`);
  const state = one("state") ?? "any";
  if (!STATES.includes(state as State)) refuse(`state: expected one of ${STATES.join(", ")}`);
  const hidden = one("hidden");
  if (hidden !== null && hidden !== "1" && hidden !== "0") refuse("hidden: expected 1 or 0");
  const limit = one("limit");
  if (limit !== null && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > WORK_LIMIT_MAX)) refuse(`limit: expected a whole number from 1 to ${WORK_LIMIT_MAX}`);
  const cursor = one("cursor");
  return { q, kind: kind as KindFilter, state: state as State, hidden: hidden === "1", limit: limit === null ? WORK_LIMIT : Number(limit), after: cursor === null ? null : readCursor(cursor) };
}

/** Newest change first; rows changed at the same instant by kind, then the higher number first, so the order is total and a page boundary is exact. */
const newestFirst = (a: Pick<Entry, "updatedAt" | "kind" | "id">, b: Pick<Entry, "updatedAt" | "kind" | "id">): number => b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || b.id - a.id;

/** Whether a row is in a state filter. A chat nobody waits on is in none but "any". */
const inState = (entry: Entry, state: State): boolean => state === "any" || entry.place === state;

/**
 * Work: the rows that match, newest change first, one page of them. Each row is the row /api/board sends, with its
 * menu, and with `place`, `cause`, `agents` and, for a failure to recover, `failure` ("stopped" or "failed"). `total` counts every match; `next` is the cursor of the following page,
 * null on the last; `older` says how many matches follow this page and when the oldest of them last changed.
 * `counts.kind` counts the matches of the search and the state for each kind, and `counts.state` those of the search
 * and the kind for each state, so each filter says what choosing it would show. `all` is how many rows there are with
 * no filter at all, and `hidden` how many the owner hid.
 */
export async function work(db: DatabaseSync, query: WorkQuery): Promise<Record<string, unknown>> {
  const all = entries(db);
  const listed = all.filter((entry) => entry.hidden === query.hidden);
  const words = query.q.toLowerCase();
  const searched = words === "" ? listed : listed.filter((entry) => entry.title.toLowerCase().includes(words));
  const ofKind = (kind: KindFilter): Entry[] => (kind === "all" ? searched : searched.filter((entry) => entry.kind === kind));
  const stated = searched.filter((entry) => inState(entry, query.state));
  const matches = ofKind(query.kind).filter((entry) => inState(entry, query.state)).sort(newestFirst);
  const after = query.after;
  const rest = after === null ? matches : matches.filter((entry) => newestFirst(after, entry) < 0);
  const page = rest.slice(0, query.limit);
  const left = rest.length - page.length;
  const branches = branchReader();
  const items = await Promise.all(page.map(async (entry) => ({ ...entry.row, ...(entry.task !== undefined ? await taskMenu(db, entry.task, branches) : entry.run !== undefined ? await runMenu(db, entry.run, branches) : {}), place: entry.place, cause: entry.cause, failure: entry.failure?.how ?? null, agents: entry.agents })));
  return {
    items,
    total: matches.length,
    next: left > 0 ? cursorOf(page.at(-1)!) : null,
    older: left > 0 ? { count: left, oldest: rest.at(-1)!.updatedAt } : null,
    counts: {
      kind: Object.fromEntries(KIND_FILTERS.map((kind) => [kind, (kind === "all" ? stated : stated.filter((entry) => entry.kind === kind)).length])),
      state: Object.fromEntries(STATES.map((state) => [state, ofKind(query.kind).filter((entry) => inState(entry, state)).length])),
    },
    all: listed.length,
    hidden: all.filter((entry) => entry.hidden).length,
  };
}

/** Home's and Work's routes. Returns false when the request is for anything else. Called only for requests the auth gate let through. */
export async function workRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  if (req.method !== "GET") return false;
  try {
    if (url.pathname === "/api/home") json(res, 200, await home(ctx));
    else if (url.pathname === "/api/home/count") json(res, 200, { needsYou: ((needs) => needs.rows.length + needs.messages)(needing(ctx, entries(ctx.db))) });
    else if (url.pathname === "/api/work") json(res, 200, await work(ctx.db, workQuery(url.searchParams)));
    else return false;
  } catch (err) {
    if (err instanceof BodyError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
