import assert from "node:assert/strict";
import { test } from "node:test";
import { commandOf, DEFAULT_COMMAND_LIMIT_MS, MAX_COMMAND_LIMIT_MS, oldestCommand, pausedUntil, runningCommands, runningWords } from "../../src/engine/command-limit.ts";
import { loadRecording } from "../support/replay.ts";

// The rule both the silence limit and the task screen read (src/engine/command-limit.ts): which tool calls are commands,
// the limit each runs under, and which are still running at the end of a stored transcript. The calls are the real
// Claude Code session recorded in test/recordings/redrive-other-request.json.

const recorded = loadRecording("redrive-other-request.json").attempts[1]!;
const at = (i: number): string => new Date(Date.UTC(2026, 10, 23, 12, 0, i)).toISOString();
/** The recorded events as the store gives them, one second apart. */
const stored = recorded.map((payload, i) => ({ type: payload.type, ts: at(i), payload }));

test("a shell command's limit is the timeout it names, cut to Claude Code's ten minutes; with none, Claude Code's two minutes for Bash, and ten for another agent's command", () => {
  const call = recorded.find((event) => event.type === "tool_call")!;
  if (call.type !== "tool_call") return;
  assert.equal(commandOf(call, 0)!.limitMs, DEFAULT_COMMAND_LIMIT_MS);
  assert.equal(commandOf({ ...call, input: { ...(call.input as object), timeout: 300_000 } }, 0)!.limitMs, 300_000);
  assert.equal(commandOf({ ...call, input: { ...(call.input as object), timeout: 3_600_000 } }, 0)!.limitMs, MAX_COMMAND_LIMIT_MS);
  assert.equal(commandOf({ id: "item-1", name: "shell", input: { command: "npm test" } }, 0)!.limitMs, MAX_COMMAND_LIMIT_MS);
  // Not a command: a file tool, or a call with no command line.
  assert.equal(commandOf({ id: "r", name: "Read", input: { file_path: "a.ts" } }, 0), null);
  assert.equal(commandOf({ id: "n", name: "Bash", input: null }, 0), null);
});

test("the clock pauses until the latest own limit of the commands running, and the owner is told of the longest-running one", () => {
  const a = { id: "a", command: "npm test", startedAt: 1_000, limitMs: 120_000 };
  const b = { id: "b", command: "sleep 1", startedAt: 5_000, limitMs: 600_000 };
  assert.equal(pausedUntil([]), 0);
  assert.equal(pausedUntil([a, b]), 605_000);
  assert.equal(oldestCommand([b, a]), a);
  assert.equal(oldestCommand([]), null);
});

test("from a stored transcript: the command is running between its call and its result, through the request and its answer, and not after; a refused one is not running", () => {
  const result = stored.findIndex((event) => event.type === "tool_result");
  const resolved = stored.findIndex((event) => event.type === "permission_resolved");
  const running = runningCommands(stored.slice(0, result));
  assert.deepEqual(running.map((c) => [c.command, c.startedAt, c.limitMs]), [["sh other.sh", Date.parse(at(2)), DEFAULT_COMMAND_LIMIT_MS]]);
  assert.deepEqual(runningCommands(stored.slice(0, result + 1)), []);
  assert.deepEqual(runningCommands(stored), []);
  // Declined: the call never runs, though the CLI's own result has not come yet.
  const declined = stored.slice(0, resolved + 1).map((event, i) => (i === resolved ? { ...event, payload: { ...event.payload, decision: "declined" } } : event));
  assert.deepEqual(runningCommands(declined), []);
  // A new prompt starts afresh: nothing of an earlier turn is running in it.
  assert.deepEqual(runningCommands([...stored.slice(0, result), { type: "user_prompt", ts: at(20), payload: { type: "user_prompt", text: "go on" } }]), []);
});

test("the task screen's words: which command runs, how long so far, and whether it is within its own limit", () => {
  const command = { id: "a", command: "npm test\n  --watch=false", startedAt: 0, limitMs: 120_000 };
  const ms = (n: number): string => `${Math.round(n / 1000)}s`;
  assert.deepEqual(runningWords("Claude Code", command, 42_000, ms), { line: "Claude Code is running npm test.", time: "42s so far, within its own time limit of 2 minutes." });
  assert.equal(runningWords("Claude Code", command, 130_000, ms).time, "130s so far, past its own time limit of 2 minutes.");
});
