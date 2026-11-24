import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute } from "../web/src/app/route.ts";
import type { EvidenceState, StoredEvent } from "../web/src/api/client.ts";
import { activityLine, diffRows, offered } from "../web/src/screens2/review/review-model.ts";

// The rebuilt review screen (ADR 0012): what it works out for itself, which is little. Which Accept there is comes
// from the server's state of the evidence alone; the diff's line numbers come from git's own hunk headers.

const evidence = (state: EvidenceState["state"], canRunAgain = false): EvidenceState => ({ state, checks: state === "none" ? "none" : "passed", checkedCommit: null, headCommit: null, files: [], ignored: [], ignoredMore: 0, ignoredWords: null, words: "", canRunAgain, review: null });

test("the rebuilt review screen is the task's own address with ?new=1, and the old screen keeps the plain address", () => {
  assert.deepEqual(parseRoute("#/tasks/12"), { screen: "task", id: 12, discard: false, rebuilt: false });
  assert.deepEqual(parseRoute("#/tasks/12?new=1"), { screen: "task", id: 12, discard: false, rebuilt: true });
  assert.deepEqual(parseRoute("#/tasks/12?discard"), { screen: "task", id: 12, discard: true, rebuilt: false });
  assert.deepEqual(parseRoute("#/tasks/12?new=2"), { screen: "none", what: "/tasks/12?new=2" });
});

test("the actions offered are the ones the server's evidence state allows, and none when it could not be read", () => {
  assert.deepEqual(offered(evidence("current")), { accept: "accept", runAgain: false });
  assert.deepEqual(offered(evidence("none")), { accept: "unverified", runAgain: false });
  // Out of date: no Accept in any wording; Run checks again only when the server says there is something to run on.
  assert.deepEqual(offered(evidence("stale", true)), { accept: null, runAgain: true });
  assert.deepEqual(offered(evidence("stale", false)), { accept: null, runAgain: false });
  assert.deepEqual(offered(evidence("differs", true)), { accept: null, runAgain: false });
  assert.deepEqual(offered(null), { accept: null, runAgain: false });
});

test("a diff's rows carry the line numbers of git's hunk headers, and its file headers are left out", () => {
  const diff = ["diff --git a/calc.py b/calc.py", "index 1111111..2222222 100644", "--- a/calc.py", "+++ b/calc.py", "@@ -1,2 +1,2 @@", " def add(a, b):", "-    return a - b", "+    return a + b", "\\ No newline at end of file", ""].join("\n");
  assert.deepEqual(diffRows(diff), [
    { kind: "hunk", number: null, text: "@@ -1,2 +1,2 @@" },
    { kind: "context", number: 1, text: "def add(a, b):" },
    { kind: "removed", number: 2, text: "    return a - b" },
    { kind: "added", number: 2, text: "    return a + b" },
    { kind: "note", number: null, text: "\\ No newline at end of file" },
  ]);
  // A new file: every line is added and numbered from 1; a removed line that starts with "--" is still a removed line.
  const added = ["diff --git a/a.txt b/a.txt", "new file mode 100644", "--- /dev/null", "+++ b/a.txt", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n");
  assert.deepEqual(diffRows(added).map((row) => `${row.kind} ${row.number}`), ["hunk null", "added 1", "added 2"]);
  const dashes = ["--- a/a.md", "+++ b/a.md", "@@ -3 +3 @@", "--- old rule", "+++ new rule"].join("\n");
  assert.deepEqual(diffRows(dashes).slice(1), [{ kind: "removed", number: 3, text: "-- old rule" }, { kind: "added", number: 3, text: "++ new rule" }]);
  assert.deepEqual(diffRows(""), []);
});

test("the activity line counts what is stored: the agent's steps and the time from the first event to the last", () => {
  const event = (id: number, ts: string, payload: StoredEvent["payload"]): StoredEvent => ({ attemptId: 1, id, turn: 1, ts, type: payload.type, payload });
  const events = [
    event(1, "2026-11-23T10:00:00.000Z", { type: "user_prompt", text: "Fix it" }),
    event(2, "2026-11-23T10:00:05.000Z", { type: "tool_call", id: "a", name: "Read", input: {} }),
    event(3, "2026-11-23T10:00:06.000Z", { type: "tool_result", id: "a", output: "", isError: false }),
    event(4, "2026-11-23T10:00:30.000Z", { type: "tool_call", id: "b", name: "Edit", input: {} }),
    event(5, "2026-11-23T10:00:42.000Z", { type: "turn_ended", reason: "completed", detail: null }),
  ];
  assert.deepEqual(activityLine(events), { steps: 2, ms: 42_000 });
  assert.deepEqual(activityLine([]), { steps: 0, ms: 0 });
});
