import assert from "node:assert/strict";
import test from "node:test";
import type { DriverEvent, StoredEvent } from "../web/src/api/client.ts";
import { readStory } from "../web/src/components/transcript-story.ts";
import { filesTouched, narrative, reasonParts, stages, viewOf } from "../web/src/screens2/task/task-model.ts";

// The task screen's own reading of a task's stored events (web/src/screens2/task/task-model.ts): a narrative whose
// finished steps fold and whose running step stands open, the files the agent's own edits touched, and the stages.

let at = Date.parse("2026-11-23T14:00:00Z");
let next = 1;
const stored = (payload: DriverEvent, after = 1000): StoredEvent => ({ attemptId: 1, id: next++, turn: 1, ts: new Date((at += after)).toISOString(), type: payload.type, payload });
const call = (id: string, name: string, input: unknown): StoredEvent => stored({ type: "tool_call", id, name, input });
const result = (id: string, output = "", isError = false, after = 1000): StoredEvent => stored({ type: "tool_result", id, output, isError }, after);

test("the narrative folds the steps that are over under one line that counts them, and keeps the step that runs now open and apart", () => {
  const events = [
    stored({ type: "user_prompt", text: "Add a greeting" }),
    stored({ type: "text", text: "I will read the README first." }),
    call("a", "Read", { file_path: "/w/run-1/task-7/README.md" }),
    result("a", "# Sample"),
    call("b", "Edit", { file_path: "/w/run-1/task-7/README.md", old_string: "a", new_string: "b" }),
    result("b"),
    stored({ type: "text", text: "Running the tests now." }),
    call("c", "Bash", { command: "npm test" }),
  ];
  const parts = narrative(events, readStory(events, true));
  assert.deepEqual(parts.map((part) => part.kind), ["prompt", "said", "steps", "said", "step"]);
  const folded = parts[2] as Extract<(typeof parts)[number], { kind: "steps" }>;
  assert.equal(folded.summary, "Read 1 file, edited 1 file");
  assert.equal(folded.open, false);
  assert.deepEqual(folded.steps.map((step) => `${step.line.verb} ${step.line.object}`), ["Read README.md", "Edited README.md"]);
  assert.deepEqual([folded.steps[0]!.output, folded.steps[0]!.ms], ["# Sample", 1000]);
  const running = parts[4] as Extract<(typeof parts)[number], { kind: "step" }>;
  assert.deepEqual([running.step.state, running.step.line.verb, running.step.line.object, running.step.output], ["running", "Running", "npm test", null]);
});

test("once nothing is running, a step with no result did not finish: it is folded with the others, and its group stands open and says why", () => {
  const events = [stored({ type: "user_prompt", text: "Tidy" }), call("a", "Read", { file_path: "a.py" }), result("a"), call("b", "Bash", { command: "pytest" }), stored({ type: "turn_ended", reason: "interrupted", detail: "The process was stopped." })];
  const parts = narrative(events, readStory(events, false));
  assert.deepEqual(parts.map((part) => part.kind), ["prompt", "steps", "ended"]);
  const folded = parts[1] as Extract<(typeof parts)[number], { kind: "steps" }>;
  assert.equal(folded.open, true);
  assert.equal(folded.summary, "Read 1 file, 1 did not finish");
  assert.deepEqual([folded.steps[1]!.state, folded.steps[1]!.note], ["unfinished", "No result was recorded for it."]);
});

test("the files touched so far are the ones the agent's own edits that returned changed, named from the task's copy down; a failed edit and a shell command are not in it", () => {
  const events = [
    call("a", "Write", { file_path: "/w/run-1/task-7/test/readme.test.js", content: "x" }),
    result("a"),
    call("b", "Edit", { file_path: "/w/run-1/task-7/README.md", old_string: "a", new_string: "b" }),
    result("b"),
    call("c", "Edit", { file_path: "/w/run-1/task-7/test/readme.test.js", old_string: "x", new_string: "y" }),
    result("c"),
    call("d", "Edit", { file_path: "/w/run-1/task-7/gone.md", old_string: "a", new_string: "b" }),
    result("d", "no such file", true),
    call("e", "Bash", { command: "touch made.txt" }),
    result("e"),
    call("f", "Write", { file_path: "notes.md", content: "x" }),
  ];
  assert.deepEqual(filesTouched(events, readStory(events, true), 7), [{ path: "test/readme.test.js", did: "Written" }, { path: "README.md", did: "Edited" }]);
});

test("the stages name the review only for a run with a reviewer, and call the decision the owner's unless the run is fully autonomous", () => {
  const show = (status: string, reviewer: boolean, mode: string): string => stages({ status, reviewer: reviewer ? { agent: "codex", model: null } : null, mode } as Parameters<typeof stages>[0]).map((stage) => `${stage.name}:${stage.state}`).join(" ");
  assert.equal(show("building", false, "manual"), "Work:now Checks:later Your decision:later");
  assert.equal(show("verifying", true, "semi"), "Work:done Checks:now Review:later Your decision:later");
  assert.equal(show("reviewing", true, "full"), "Work:done Checks:done Review:now Decision:later");
  assert.equal(show("waiting_for_limit", false, "manual"), "Work:now Checks:later Your decision:later");
});

test("the screen shows the review once a task is ready for review or decided, the recovery when it ended with nothing to review, and the work otherwise", () => {
  const view = (status: string, decided = false): string => viewOf({ status, decision: decided ? {} : null } as Parameters<typeof viewOf>[0]);
  assert.deepEqual(["awaiting_decision", "accepted", "rejected"].map((s) => view(s, s !== "awaiting_decision")), ["review", "review", "review"]);
  assert.deepEqual(["failed", "interrupted", "cancelled", "drafted"].map((s) => view(s)), ["recovery", "recovery", "recovery", "recovery"]);
  assert.deepEqual(["queued", "building", "verifying", "reviewing", "waiting_for_limit"].map((s) => view(s)), ["work", "work", "work", "work", "work"]);
});

test("a reason that quotes the agent's last message is told as what happened and, apart, what the agent said", () => {
  assert.deepEqual(reasonParts("Claude Code finished without changing any file. Its last message: Nothing to tidy."), { what: "Claude Code finished without changing any file.", said: "Nothing to tidy." });
  assert.deepEqual(reasonParts("Claude Code finished without changing any file. It wrote no message."), { what: "Claude Code finished without changing any file. It wrote no message.", said: null });
});
