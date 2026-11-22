import { spawn } from "node:child_process";
import fs from "node:fs";
import { createBroker } from "../../src/approvals/broker.ts";
import { createTask, moveTask } from "../../src/engine/task.ts";
import { openStore } from "../../src/store/db.ts";
import { createWorktree } from "../../src/worktrees.ts";
import { write } from "./repo.ts";

/*
 * A Smelt that stops without warning while a task waits for the owner, for the tests of what the next
 * start finds. Run as its own process, it opens the real store under `home`, puts a task at `building`
 * in a real worktree with an attempt, asks the real broker for each of `commands`, and then exits where
 * it stands: nothing is closed, the approvals are left pending and the broker's socket file is left behind.
 * No driver is started. Reads one JSON object as its argument and prints the ids it made.
 */

interface Order {
  home: string;
  repo: string;
  /** The session the attempt would resume from; left out, the attempt has none. */
  cursor?: string;
  commands: string[];
  /** Leave a real process group behind, recorded as the attempt's, as a CLI that outlived its Smelt would be. */
  survivor?: boolean;
  /** Record the attempt as made an hour before it was, so a process group under its number began after it. */
  attemptMadeEarlier?: boolean;
}

export interface Left {
  taskId: number;
  attemptId: number;
  approvalIds: number[];
  worktree: string;
  branch: string;
  /** The process group left running, when one was asked for. */
  pgid: number | null;
}

const order = JSON.parse(process.argv[2]!) as Order;
const db = openStore(order.home);
const broker = createBroker({ db, home: order.home, onChange: () => {} });
await broker.listen();

const task = createTask(db, { repo: order.repo, prompt: "Run the command `sh make-marker.sh` with your Bash tool, exactly once." });
const worktree = await createWorktree({ repo: order.repo, home: order.home, run: "run-0000aaaa", task: `task-${task.id}` });
let pgid: number | null = null;
if (order.survivor) {
  const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  child.unref();
  pgid = child.pid!;
}
const at = new Date(Date.now() - (order.attemptMadeEarlier ? 3_600_000 : 0)).toISOString();
const attemptId = Number(
  db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', 'haiku', ?, 'running', ?, ?, ?)").run(order.cursor ?? null, pgid, at, at).lastInsertRowid,
);
moveTask(db, task.id, "building", { worktree, attemptId });
// What the agent had written before it asked.
write(worktree.path, "partial.txt", "written before the stop\n");

const admission = broker.admit({ taskId: task.id, role: "implementer", worktree: worktree.path });
admission.bind(attemptId);
order.commands.forEach((command, i) => void broker.request({ taskId: task.id, attemptId, role: "implementer", tool: "Bash", command, cwd: ".", reason: "The agent's own words", toolCallId: `toolu_before_${i}` }));
const left: Left = { taskId: task.id, attemptId, approvalIds: broker.pending().map((a) => a.id), worktree: worktree.path, branch: worktree.branch, pgid };
fs.writeSync(1, JSON.stringify(left));
// Gone where it stands, as a killed process is.
process.kill(process.pid, "SIGKILL");
