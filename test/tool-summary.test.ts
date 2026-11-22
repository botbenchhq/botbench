import assert from "node:assert/strict";
import test from "node:test";
import { callLine, callReason, callTarget, duration, editChange, lineChanges, writtenText } from "../web/src/components/tool-summary.ts";

// The one-line summaries of tool activity (docs/product/voice.md): derived from the real name and arguments, never guessed.

const line = (name: string, input: unknown, state: Parameters<typeof callLine>[2]): string => {
  const l = callLine(name, input, state);
  return [l.verb ?? `[${l.tool}]`, l.object, l.note === "" ? "" : `· ${l.note}`].filter((part) => part !== "").join(" ");
};

test("a known tool is said with a plain verb that is true of its state, and its real object", () => {
  assert.equal(line("Bash", { command: "npm test", description: "Run the tests" }, "done"), "Ran npm test");
  assert.equal(line("Bash", { command: "npm test" }, "running"), "Running npm test");
  assert.equal(line("Bash", { command: "npm test" }, "waiting"), "Wants to run npm test");
  assert.equal(line("Bash", { command: "npm test" }, "refused"), "Did not run npm test");
  assert.equal(line("Bash", { command: "npm test" }, "failed"), "Ran npm test · failed");
  assert.equal(line("Read", { file_path: "/tmp/copy/src/auth.ts" }, "done"), "Read auth.ts");
  // A call that failed is not said to have done the thing. A command that failed did run.
  assert.equal(line("Read", { file_path: "/tmp/copy/src/auth.ts" }, "failed"), "Could not read auth.ts");
  assert.equal(line("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, "failed"), "Could not edit a.ts");
  assert.equal(line("Write", { file_path: "a.ts", content: "x" }, "failed"), "Could not write a.ts");
  assert.equal(line("Grep", { pattern: "x" }, "failed"), "Could not search for x");
  assert.equal(line("Edit", { file_path: "/tmp/copy/src/auth.ts", old_string: "a", new_string: "b" }, "done"), "Edited auth.ts");
  assert.equal(line("Write", { file_path: "hello.txt", content: "hi\n" }, "done"), "Wrote hello.txt");
  assert.equal(line("Grep", { pattern: "startRefreshTimer", path: "src" }, "done"), "Searched for startRefreshTimer");
  assert.equal(line("Glob", { pattern: "**/*.ts" }, "done"), "Looked for files matching **/*.ts");
  assert.equal(line("WebSearch", { query: "node sqlite" }, "running"), "Searching the web for node sqlite");
});

test("the line holds one line of a long command, cut with an ellipsis, and the whole of it stays available", () => {
  const command = `echo ${"x".repeat(200)}\nrm second-line`;
  const l = callLine("Bash", { command }, "done");
  assert.equal(l.object.length, 81);
  assert.ok(l.object.endsWith("…"));
  assert.ok(!l.object.includes("second-line"));
  assert.equal(l.whole, command);
});

test("a tool with no verb, or without the argument its verb is about, is shown by its own name and main argument, with its state in words", () => {
  assert.equal(line("TodoWrite", { todos: [] }, "done"), "[TodoWrite]");
  assert.equal(line("mcp__files__stat", { path: "/tmp/a" }, "failed"), "[mcp__files__stat] /tmp/a · failed");
  assert.equal(line("Bash", {}, "done"), "[Bash]");
  assert.equal(line("Read", { file_path: 7 }, "waiting"), "[Read] · waiting for your answer");
  assert.equal(line("Bash", "not an object", "refused"), "[Bash] · not run");
  // A call that neither returned nor is still going is never said to have run.
  assert.equal(line("Bash", { command: "npm test" }, "unfinished"), "[Bash] npm test · did not finish");
});

test("the target and the reason come from the arguments, or are absent", () => {
  assert.equal(callTarget({ command: "ls", path: "x" }), "ls");
  assert.equal(callTarget({ path: "x" }), "x");
  assert.equal(callTarget(null), "");
  assert.equal(callReason({ description: "  List files  " }), "List files");
  assert.equal(callReason({ description: "" }), null);
  assert.equal(callReason({}), null);
});

test("an edit's line counts are counted from its own two texts, and are left out when they cannot be", () => {
  assert.deepEqual(lineChanges("a\nb\nc", "a\nB\nc\nd"), [" a", "-b", "+B", " c", "+d"]);
  assert.deepEqual(editChange("Edit", { file_path: "f", old_string: "a\nb\nc", new_string: "a\nB\nc\nd" }), { lines: [" a", "-b", "+B", " c", "+d"], added: 2, removed: 1 });
  assert.deepEqual(editChange("Edit", { file_path: "f", old_string: "x", new_string: "" }), { lines: ["-x"], added: 0, removed: 1 });
  assert.equal(editChange("Edit", { file_path: "f", old_string: "x", new_string: "y", replace_all: true }), null);
  assert.equal(editChange("Edit", { file_path: "f", new_string: "y" }), null);
  assert.equal(editChange("Write", { file_path: "f", old_string: "x", new_string: "y" }), null);
  assert.equal(lineChanges(Array.from({ length: 401 }, (_, i) => String(i)).join("\n"), "x"), null);
  assert.deepEqual(writtenText("Write", { file_path: "f", content: "hi\nthere\n" }), { text: "hi\nthere\n", lines: 2 });
  assert.equal(writtenText("Write", { file_path: "f" }), null);
});

test("a duration comes from two stored times, or is not given", () => {
  assert.equal(duration("2026-11-22T10:00:00.000Z", "2026-11-22T10:00:04.400Z"), "4s");
  assert.equal(duration("2026-11-22T10:00:00.000Z", "2026-11-22T10:02:14.000Z"), "2m 14s");
  assert.equal(duration("2026-11-22T10:00:00.000Z", "2026-11-22T11:03:10.000Z"), "1h 3m");
  assert.equal(duration("not a time", "2026-11-22T10:00:00.000Z"), null);
  assert.equal(duration("2026-11-22T10:00:05.000Z", "2026-11-22T10:00:00.000Z"), null);
});
