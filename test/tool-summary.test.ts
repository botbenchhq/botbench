import assert from "node:assert/strict";
import test from "node:test";
import { approvalWords, callLine, callReason, callTarget, confinedWords, duration, editChange, lineChanges, ranFor, stepGroupOpen, stepsSummary, writtenText } from "../web/src/components/tool-summary.ts";
import { bannedIn } from "../e2e/voice.ts";

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

test("a step group's line counts what its calls did, by kind, in the same past-tense verbs as the rows, from the calls themselves", () => {
  const done = (name: string): { name: string; state: "done" } => ({ name, state: "done" });
  assert.equal(stepsSummary([done("Read"), done("Read"), done("Read")]), "Read 3 files");
  assert.equal(stepsSummary([done("Bash"), done("Edit"), done("Bash"), done("Write")]), "Ran 2 commands, edited 1 file, wrote 1 file");
  assert.equal(stepsSummary([done("Grep"), done("Glob"), done("WebFetch"), done("WebSearch")]), "Searched 1 time, looked for files 1 time, fetched 1 page, searched the web 1 time");
  // A tool with no verb is counted by its own name.
  assert.equal(stepsSummary([done("TodoWrite"), done("TodoWrite"), done("Read")]), "Used TodoWrite 2 times, read 1 file");
  // Only what ran and returned is counted as done; the rest is said as it is, never folded into a count.
  assert.equal(
    stepsSummary([done("Read"), { name: "Bash", state: "failed" }, { name: "Bash", state: "refused" }, { name: "Read", state: "unfinished" }, { name: "Bash", state: "running" }, { name: "Bash", state: "waiting" }]),
    "Read 1 file, 1 not run, 1 did not finish",
  );
  assert.equal(stepsSummary([{ name: "Bash", state: "running" }, { name: "Bash", state: "running" }, { name: "Bash", state: "waiting" }]), "");
});

test("what the sandbox kept a call from is said in plain words, from what its result reports, and nothing is said when it reports nothing", () => {
  assert.equal(confinedWords(undefined), null);
  assert.equal(confinedWords({ hosts: [], files: false }), null);
  const network = confinedWords({ hosts: ["example.com:443"], files: false })!;
  assert.equal(network.note, "kept from the network");
  assert.deepEqual(network.sentences, ["Its output says a connection to example.com:443 was not allowed. The agent's commands reach only the hosts allowed for this repository in Botbench's settings file, and none when no host is."]);
  const file = confinedWords({ hosts: [], files: true })!;
  assert.equal(file.note, "kept from a file");
  assert.deepEqual(file.sentences, ["Its output says it was not allowed to open a file. The agent cannot read your sign-ins, your keys or Botbench's own files."]);
  const both = confinedWords({ hosts: ["a.example.com:443", "b.example.com:80"], files: true })!;
  assert.equal(both.note, "kept from a file and the network");
  assert.equal(both.sentences.length, 2);
  assert.match(both.sentences[1]!, /a\.example\.com:443, b\.example\.com:80/);
  for (const words of [network, file, both]) for (const sentence of [words.note, ...words.sentences]) assert.deepEqual(bannedIn(sentence), [], sentence);
});

test("a step's time is how long it ran: from when it was allowed when it was asked about, else from the call, to its result; never the wait for the owner", () => {
  const calledAt = "2026-11-22T10:00:00.000Z";
  // Asked, the owner answered after 4 minutes, it ran for 1.5 s.
  assert.equal(ranFor({ calledAt, asked: true, allowedAt: "2026-11-22T10:04:00.000Z", returnedAt: "2026-11-22T10:04:01.500Z" }), 1500);
  // Not asked: from the call.
  assert.equal(ranFor({ calledAt, asked: false, returnedAt: "2026-11-22T10:00:02.000Z" }), 2000);
  // Asked, but when it was allowed is not known: no time rather than one that holds the wait.
  assert.equal(ranFor({ calledAt, asked: true, returnedAt: "2026-11-22T10:04:01.500Z" }), null);
  // No result yet, or times out of order: no time.
  assert.equal(ranFor({ calledAt, asked: false }), null);
  assert.equal(ranFor({ calledAt, asked: true, allowedAt: "2026-11-22T10:05:00.000Z", returnedAt: "2026-11-22T10:04:00.000Z" }), null);
});

test("a step group is open while its reply is arriving, closes to its line once the reply has finished, stays open on trouble, and keeps what the reader chose", () => {
  const done = ["done", "done", "done"] as const;
  // The tool calls are seen as they happen.
  assert.equal(stepGroupOpen({ touched: null, live: true, states: [...done, "running"] }), true);
  assert.equal(stepGroupOpen({ touched: null, live: true, states: done }), true);
  // Once the reply has finished, a group of calls that all went well folds to its one line.
  assert.equal(stepGroupOpen({ touched: null, live: false, states: done }), false);
  // A call that failed, was not run, did not finish or waits for an answer keeps the group open.
  for (const trouble of ["failed", "refused", "unfinished", "waiting"] as const) assert.equal(stepGroupOpen({ touched: null, live: false, states: [...done, trouble] }), true, trouble);
  // What the reader opened or closed by hand stays so, whatever happens after.
  assert.equal(stepGroupOpen({ touched: true, live: false, states: done }), true);
  assert.equal(stepGroupOpen({ touched: false, live: true, states: [...done, "failed"] }), false);
});

test("an approval for a tool that is not a shell command reads as the tool's name and main argument in words, with its raw arguments kept for one tap away", () => {
  // Screenshot 038 of the self-review: the card showed {"delaySeconds":1200,…} as its command.
  assert.deepEqual(approvalWords("WebFetch", JSON.stringify({ url: "https://example.com/a", prompt: "read" })), { line: "Wants to fetch https://example.com/a", raw: '{\n  "url": "https://example.com/a",\n  "prompt": "read"\n}' });
  assert.deepEqual(approvalWords("Write", JSON.stringify({ file_path: "/w/src/a.ts", content: "x" })), { line: "Wants to write a.ts", raw: '{\n  "file_path": "/w/src/a.ts",\n  "content": "x"\n}' });
  // A tool with no verb: its own name, and its main argument when it has one.
  assert.equal(approvalWords("ScheduleWakeup", JSON.stringify({ delaySeconds: 1200, reason: "fallback" })).line, "ScheduleWakeup");
  assert.equal(approvalWords("Skill", JSON.stringify({ command: "review" })).line, "Skill: review");
  // A shell command is its command, as before; text that is not the JSON of an object is shown as it is.
  assert.deepEqual(approvalWords("Bash", "npm test"), { line: null, raw: "npm test" });
  assert.deepEqual(approvalWords("Odd", "not json"), { line: null, raw: "not json" });
});
