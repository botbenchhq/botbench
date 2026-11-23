import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createBroker } from "../../src/approvals/broker.ts";
import { createRuns, getRun, storePlan, createRun } from "../../src/engine/run.ts";
import { createTasks, getTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { sourceHead } from "../../src/worktrees.ts";
import { buildReplayDriver, type AttemptScript } from "./replay-build.ts";
import { loadPlanRecording, planReplayDriver } from "./replay-plan.ts";
import { write } from "./repo.ts";

/*
 * A Botbench that is killed without warning while it is at work, for the tests of what the next start does
 * (test/engine/recover.test.ts). Run as its own process, it opens the real store under `home` and runs the real engine:
 * the real broker on its socket, the real task line with the repository's real setup and check commands, run confined
 * in real process groups, and the run engine. The agent's turns are the sessions captured from the real Claude Code
 * (test/support/replay-build.ts and replay-plan.ts). When the work reaches the point the order names, the process kills
 * itself where it stands: nothing is closed, every command it started is left running, and no row is tidied.
 *
 * With `existing`, the home already holds the data a killed Botbench left: this start recovers it first, as any start
 * does, and is itself killed at the named point of what it re-drives.
 *
 * Reads one JSON object as its argument and prints what it made as one JSON object.
 */

export interface Order {
  home: string;
  repo: string;
  /** The home already holds a Botbench's data; nothing new is started, the start's own recovery is what runs. */
  existing?: boolean;
  /** New work: one task on its own with this prompt, or a planned run with these task titles, approved at once. */
  task?: string;
  run?: string[];
  /** A further run left waiting for the owner's approval of its plan of these titles. */
  waitingRun?: string[];
  /** A run started from this prompt and left planning: the planner's turn is held and never released. */
  planning?: string;
  setup?: string[];
  checks?: string[];
  /** The recorded turns of this process's attempts, in the order they are started. */
  script?: AttemptScript[];
  /** Which of this process's attempts (from 0) is held, and where: the process is killed while it is held. */
  hold?: number;
  /** Which turn of the held attempt (from 0) is held; its first when left out. */
  holdTurn?: number;
  holdAt?: "prompt" | "session";
  /** A note the owner sends to the task at work while its first turn is held, before anything else is released. */
  note?: string;
  /** Where the process is killed: while the held attempt's turn is under way, or once a setup or check command that writes `begun.txt` has begun. */
  stopAt: "turn" | "setup" | "checks" | "planning";
  /** The task whose command is awaited for `setup` and `checks`; the newest one when left out. */
  taskId?: number;
  /** Leave a real process group behind, recorded as the held attempt's, as a CLI that outlived its Botbench would be. */
  survivor?: boolean;
  /** A file the agent wrote in its copy before the stop, relative to the copy. */
  wrote?: string;
}

export interface Left {
  runIds: number[];
  taskIds: number[];
  /** The held attempt, when the process was killed during a turn. */
  attemptId: number | null;
  /** The worktree of the task at work, when it had one. */
  worktree: string | null;
  /** The process group left running as the held attempt's CLI, when one was asked for. */
  survivor: number | null;
}

const order = JSON.parse(process.argv[2]!) as Order;
const db = openStore(order.home);
const broker = createBroker({ db, home: order.home, onChange: () => {} });
await broker.listen();
const repoCommands = (): { setup: { command: string; limitMs: number }[]; checks: { command: string; limitMs: number }[] } => ({
  setup: (order.setup ?? []).map((command) => ({ command, limitMs: 60_000 })),
  checks: (order.checks ?? []).map((command) => ({ command, limitMs: 60_000 })),
});
const planner = order.stopAt !== "planning" ? null : planReplayDriver(loadPlanRecording(), [0], () => new Promise<void>(() => {}));
// A later turn of the held attempt is held as well as its first, so the note can be sent while the first is under way.
const later = order.hold !== undefined && (order.holdTurn ?? 0) > 0;
const driver = buildReplayDriver(order.script ?? [], { hold: order.hold === undefined || (later && order.note === undefined) ? [] : [order.hold], holdTurns: later ? [[order.hold!, order.holdTurn!]] : [], holdAt: order.holdAt ?? "prompt" });
const tasks = createTasks({ db, home: order.home, driver, broker, model: "haiku", repoCommands, onEvent: () => {}, onTaskChange: () => {} });
const runs = createRuns({ db, home: order.home, driver: planner ?? driver, broker, line: tasks, onEvent: () => {}, onRunChange: () => {}, onTaskChange: () => {} });

const left: Left = { runIds: [], taskIds: [], attemptId: null, worktree: null, survivor: null };
const base = await sourceHead(order.repo);
const plan = (titles: string[]) => titles.map((title) => ({ title, criteria: [`${title} is done`] }));
if (order.waitingRun) {
  const waiting = createRun(db, { repo: order.repo, prompt: "left waiting for approval", baseCommit: base });
  storePlan(db, waiting.id, plan(order.waitingRun));
  left.runIds.push(waiting.id);
}
if (order.task !== undefined) left.taskIds.push((await tasks.start(order.repo, order.task, "haiku")).id);
if (order.run) {
  const run = createRun(db, { repo: order.repo, prompt: "a planned run", baseCommit: base });
  const stored = storePlan(db, run.id, plan(order.run));
  left.runIds.push(run.id);
  left.taskIds.push(...runs.approve(run.id, stored.planVersion).tasks.map((task) => task.id));
}
if (order.planning !== undefined) left.runIds.push((await runs.start({ repo: order.repo, prompt: order.planning })).id);

const until = async (what: string, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

if (order.stopAt === "turn") {
  if (order.note !== undefined) {
    // The owner's note reaches the task while its builder's first turn is under way, as a POST to the task would.
    await driver.held(order.hold ?? 0);
    tasks.sendNote(left.taskIds.at(-1)!, order.note);
    if (later) driver.release(order.hold!);
  }
  await driver.held(order.hold ?? 0, order.holdTurn ?? 0);
  const attempt = db.prepare("SELECT id FROM attempts ORDER BY id DESC LIMIT 1").get()!;
  left.attemptId = Number(attempt.id);
  const task = getTask(db, Number(db.prepare("SELECT id FROM tasks WHERE attempt_id = ?").get(left.attemptId)!.id))!;
  left.worktree = task.worktreePath;
  if (order.wrote !== undefined) write(task.worktreePath!, order.wrote, "written by the agent before the stop\n");
  if (order.survivor) {
    // A CLI's process group that outlives its Botbench: started for the attempt and recorded on it, as the driver does.
    const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
    child.unref();
    left.survivor = child.pid!;
    db.prepare("UPDATE attempts SET pgid = ? WHERE id = ?").run(left.survivor, left.attemptId);
  }
} else if (order.stopAt === "planning") {
  const id = left.runIds.at(-1) ?? Number(db.prepare("SELECT id FROM runs ORDER BY id DESC LIMIT 1").get()!.id);
  if (left.runIds.length === 0) left.runIds.push(id);
  await until("the planner's turn", () => getRun(db, id)?.attemptId !== null && planner!.prompts.length > 0);
} else {
  const id = order.taskId ?? left.taskIds.at(-1)!;
  await until(`a ${order.stopAt} command to begin`, () => {
    const task = getTask(db, id);
    return task?.worktreePath != null && fs.existsSync(path.join(task.worktreePath, "begun.txt"));
  });
  left.worktree = getTask(db, id)!.worktreePath;
}
if (left.taskIds.length === 0) left.taskIds.push(...db.prepare("SELECT id FROM tasks ORDER BY id").all().map((row) => Number(row.id)));
fs.writeSync(1, JSON.stringify(left));
// Gone where it stands, as a killed process is.
process.kill(process.pid, "SIGKILL");
