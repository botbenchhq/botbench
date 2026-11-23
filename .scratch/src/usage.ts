import type { DatabaseSync } from "node:sqlite";
import type { BillingKind } from "./drivers/contract.ts";

/*
 * Usage by agent, model and run (unit 22), read from what is already stored: the `usage` event the driver writes at the
 * end of each turn (tokens only: the driver never stores a dollar amount, so none can be shown), the attempt it belongs
 * to (which agent and model), and the run and tasks that attempt worked for. No ledger of its own.
 */

export interface Totals {
  turns: number;
  /** Everything sent to the model: new input plus cached input read and written. */
  inputTokens: number;
  outputTokens: number;
}
export interface ModelUsage extends Totals {
  /** The model the attempt reported or was asked for; null when it recorded none. */
  model: string | null;
}
export interface AgentUsage extends Totals {
  driver: string;
  /** What kind of sign-in the agent has now: it decides whether money is involved at all. Never a dollar amount. */
  billing: BillingKind;
  models: ModelUsage[];
}
export interface Scope extends Totals {
  agents: AgentUsage[];
}
export interface TaskUsage extends Totals {
  id: number;
  title: string;
}
export interface RunUsage extends Totals {
  id: number;
  /** A planned run, or the run of one that a task started on its own is. */
  kind: "planned" | "single";
  title: string;
  createdAt: string;
  /** The planner's own turns; a run's totals are these plus the sum of its tasks. */
  planning: Totals;
  tasks: TaskUsage[];
}
export interface UsageReport {
  /** The start of the week window: seven days before now, inclusive. */
  since: string;
  week: Scope;
  allTime: Scope;
  runs: { total: number; items: RunUsage[] };
}

/** How many runs the report lists. `runs.total` is how many there are in all. */
export const RUNS_SHOWN = 50;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const ZERO = (): Totals => ({ turns: 0, inputTokens: 0, outputTokens: 0 });
const add = (to: Totals, from: Totals): void => {
  to.turns += from.turns;
  to.inputTokens += from.inputTokens;
  to.outputTokens += from.outputTokens;
};

const IN = "coalesce(json_extract(e.payload, '$.inputTokens'), 0) + coalesce(json_extract(e.payload, '$.cacheReadTokens'), 0) + coalesce(json_extract(e.payload, '$.cacheWriteTokens'), 0)";
const OUT = "coalesce(json_extract(e.payload, '$.outputTokens'), 0)";

function scope(db: DatabaseSync, since: string | null, drivers: readonly string[], billing: Readonly<Record<string, BillingKind>>): Scope {
  const rows = db
    .prepare(`SELECT a.driver AS driver, a.model AS model, count(*) AS turns, sum(${IN}) AS input, sum(${OUT}) AS output FROM events e JOIN attempts a ON a.id = e.attempt_id WHERE e.type = 'usage' AND (? IS NULL OR e.ts >= ?) GROUP BY a.driver, a.model ORDER BY a.driver, a.model IS NULL, a.model`)
    .all(since, since);
  const agents = new Map<string, AgentUsage>();
  const agent = (driver: string): AgentUsage => {
    let found = agents.get(driver);
    if (!found) agents.set(driver, (found = { driver, billing: billing[driver] ?? "unknown", ...ZERO(), models: [] }));
    return found;
  };
  // Every agent Botbench has is listed, with zero turns when it did none; one that appears only in the history is listed too.
  for (const driver of drivers) agent(driver);
  for (const row of db.prepare("SELECT DISTINCT driver FROM attempts").all()) agent(String(row.driver));
  const all = ZERO();
  for (const row of rows) {
    const model: ModelUsage = { model: row.model === null ? null : String(row.model), turns: Number(row.turns), inputTokens: Number(row.input), outputTokens: Number(row.output) };
    const owner = agent(String(row.driver));
    owner.models.push(model);
    add(owner, model);
    add(all, model);
  }
  return { ...all, agents: [...agents.values()].sort((a, b) => a.driver.localeCompare(b.driver)) };
}

const firstLine = (text: string | null): string => {
  const line = (text ?? "").trim().split("\n")[0]!.replace(/^#+\s*/, "").trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

/**
 * What each run and task used. A task's attempts are the one it has now and every one its history names ("attempt N"),
 * because a task that is driven again gets a new attempt; a run's planner is read the same way ("planner attempt N").
 */
function runs(db: DatabaseSync): { total: number; items: RunUsage[] } {
  const used = new Map<number, Totals>();
  for (const row of db.prepare(`SELECT e.attempt_id AS id, count(*) AS turns, sum(${IN}) AS input, sum(${OUT}) AS output FROM events e WHERE e.type = 'usage' GROUP BY e.attempt_id`).all()) {
    used.set(Number(row.id), { turns: Number(row.turns), inputTokens: Number(row.input), outputTokens: Number(row.output) });
  }
  const sumOf = (attempts: Set<number>): Totals => {
    const total = ZERO();
    for (const id of attempts) {
      const one = used.get(id);
      if (one) add(total, one);
    }
    return total;
  };
  const fromHistory = (rows: Record<string, unknown>[], pattern: RegExp, into: Set<number>): void => {
    for (const row of rows) for (const part of String(row.detail).split("; ")) {
      const match = pattern.exec(part);
      if (match) into.add(Number(match[1]));
    }
  };
  const taskRows = db.prepare("SELECT t.id AS id, t.attempt_id AS attempt, coalesce(p.title, t.prompt) AS title FROM tasks t LEFT JOIN plan_tasks p ON p.task_id = t.id WHERE t.run_id = ? ORDER BY t.id");
  const taskHistory = db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND detail LIKE '%attempt %'");
  const runHistory = db.prepare("SELECT detail FROM run_events WHERE run_id = ? AND detail LIKE 'planner attempt %'");

  const items: RunUsage[] = [];
  let total = 0;
  for (const run of db.prepare("SELECT id, kind, attempt_id AS attempt, prompt, spec_text, created_at FROM runs ORDER BY id DESC").all()) {
    const id = Number(run.id);
    const planner = new Set<number>(run.attempt === null ? [] : [Number(run.attempt)]);
    fromHistory(runHistory.all(id), /^planner attempt (\d+)$/, planner);
    const planning = sumOf(planner);
    const tasks: TaskUsage[] = [];
    for (const task of taskRows.all(id)) {
      const attempts = new Set<number>(task.attempt === null ? [] : [Number(task.attempt)]);
      fromHistory(taskHistory.all(Number(task.id)), /^attempt (\d+)$/, attempts);
      tasks.push({ id: Number(task.id), title: firstLine(String(task.title)), ...sumOf(attempts) });
    }
    const run_total: Totals = { ...planning };
    for (const task of tasks) add(run_total, task);
    if (run_total.turns === 0) continue;
    total += 1;
    if (items.length < RUNS_SHOWN) items.push({ id, kind: run.kind === "single" ? "single" : "planned", title: firstLine((run.prompt ?? run.spec_text) as string | null), createdAt: String(run.created_at), ...run_total, planning, tasks: tasks.filter((task) => task.turns > 0) });
  }
  return { total, items };
}

/**
 * The report. `drivers` are the agents Botbench has; `billing` is each one's sign-in kind from its own probe, and an
 * agent missing from it is unknown. `now` is a parameter so the week's edge can be tested.
 */
export function usageReport(db: DatabaseSync, o: { now: number; drivers: readonly string[]; billing: Readonly<Record<string, BillingKind>> }): UsageReport {
  const since = new Date(o.now - WEEK_MS).toISOString();
  return { since, week: scope(db, since, o.drivers, o.billing), allTime: scope(db, null, o.drivers, o.billing), runs: runs(db) };
}
