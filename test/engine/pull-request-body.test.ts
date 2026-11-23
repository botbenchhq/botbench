import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { acceptByMode, decideTask } from "../../src/engine/decision.ts";
import { messageIssue } from "../../src/engine/claim-branch.ts";
import { MAX_BODY_FINDINGS, MAX_CREDIT_CHARS, MAX_CREDITS, pullRequestText } from "../../src/engine/delivery.ts";
import { insertRefinement, loopRecord, outcomeLine } from "../../src/engine/refine.ts";
import { approvePlan, createRun, storePlan } from "../../src/engine/run.ts";
import { getTask, moveTask, type Task } from "../../src/engine/task.ts";
import { now, openStore } from "../../src/store/db.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { initRepo, tempDir, write } from "../support/repo.ts";

// The Review section of a pull request's body, read from a real store: a real SQLite database, a real temporary
// repository and copy, and the decision made by the real decideTask and acceptByMode. The reviews and rounds of fixes
// are stored as the engine stores them (the same columns as runReview and insertRefinement), with texts written for
// each case; refine.test.ts drives the loop that writes them from recorded sessions.

type T = { after(fn: () => unknown): void };

interface Rig {
  db: DatabaseSync;
  task: Task;
  /** Take the task to its review and store a finished review of it, in round order. */
  review(verdict: "looks_right" | "concerns", text: string): void;
  /** Take the task back to its builder and store a finished round of fixes after the latest review. */
  fixed(reply: string): void;
  /** Make the task Ready for review, as the engine does once the loop ends. */
  ready(): void;
}

async function rig(t: T, o: { reviewer: boolean; mode?: "manual" | "full"; prompt?: string; said?: readonly string[] }): Promise<Rig> {
  const dir = tempDir("botbench-pr-body-test-");
  const home = path.join(dir, "home");
  const db = openStore(home);
  const repo = path.join(dir, "repo");
  const base = initRepo(repo);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = createRun(db, { repo, prompt: o.prompt ?? "Add a function", baseCommit: base, reviewer: o.reviewer ? { agent: "codex", model: "gpt-6-luna" } : null, mode: o.mode ?? "manual", maxRefineRounds: 2, delivery: "pull_request" });
  const planned = storePlan(db, run.id, [{ title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b)"] }]);
  const task = approvePlan(db, run.id, planned.planVersion).tasks[0]!;
  const worktree = await createWorktree({ repo, home, run: `run-${run.id}`, task: `task-${task.id}` });
  // The builder's session and its replies, stored as a driver stores them (one row per event, its JSON as the payload).
  const at = now();
  const attemptId = Number(db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', NULL, NULL, 'ended', NULL, ?, ?)").run(at, at).lastInsertRowid);
  for (const text of o.said ?? []) db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, 'text', ?)").run(attemptId, at, JSON.stringify({ type: "text", text }));
  moveTask(db, task.id, "building", { worktree, attemptId });
  write(worktree.path, "calc.py", "def add(a, b):\n    return a + b\n");
  const committed = await commitWork({ path: worktree.path, message: `Botbench task ${task.id}` });
  assert.ok(committed.committed);
  const head = committed.commit;
  let round = 0;
  const checked = (): void => {
    moveTask(db, task.id, "verifying", { headCommit: head });
    moveTask(db, task.id, o.reviewer ? "reviewing" : "awaiting_decision", { checks: "passed" });
  };
  checked();
  return {
    db,
    task,
    ready() {
      if (getTask(db, task.id)!.status !== "awaiting_decision") moveTask(db, task.id, "awaiting_decision");
    },
    review(verdict, text) {
      if (getTask(db, task.id)!.status === "building") checked();
      round += 1;
      db.prepare("INSERT INTO reviews (task_id, round, agent, model, attempt_id, outcome, verdict, text, problem, head_commit, diff_chars, diff_cut, started_at, ended_at, duration_ms) VALUES (?, ?, 'codex', 'gpt-6-luna', NULL, 'reviewed', ?, ?, NULL, ?, 100, 0, ?, ?, 1200)").run(task.id, round, verdict, text, head, now(), now());
    },
    fixed(reply) {
      moveTask(db, task.id, "building", { note: `round ${round} of fixes` });
      insertRefinement(db, { taskId: task.id, round, attemptId: null, outcome: "finished", changed: true, reply, problem: null, fromCommit: head, headCommit: head, startedAt: now() });
    },
  };
}

/** The body's Review section, from its heading to the next section. */
const reviewOf = (body: string): string => /## Review\n[\s\S]*?(?=\n## |\nTask \d+ · )/.exec(body)![0];
/** What is left of a body with every fenced block taken out: the only text Botbench wrote itself. */
const unfenced = (body: string): string => body.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "");
const body = (r: Rig): string => pullRequestText(r.db, getTask(r.db, r.task.id)!).body;

test("a run with no reviewer: the Review section says no review was run, and nothing else", async (t) => {
  const r = await rig(t, { reviewer: false });
  r.ready();
  await decideTask(r.db,{ taskId: r.task.id, decision: "accept", note: "Fine as it is" });
  assert.equal(reviewOf(body(r)), "## Review\n\nNo review was run.\n");
});

test("satisfied in one round: the outcome line is the task screen's, the counts, the last review's findings, and no builder's reasons when there are none", async (t) => {
  const r = await rig(t, { reviewer: true });
  r.review("concerns", "Verdict: concerns\nFindings:\n- calc.py:2: returns a - b");
  r.fixed("I fixed it.\n\nAddressed:\n- calc.py:2: now returns a + b\n\nNot addressed, and why:\n- none");
  r.review("looks_right", "Verdict: looks right\nChecked:\n- calc.py: add returns a + b\n- the criterion\nNot checked: nothing left out\nFindings:\n- none");
  r.ready();
  await decideTask(r.db,{ taskId: r.task.id, decision: "accept" });
  const section = reviewOf(body(r));
  const line = outcomeLine(loopRecord(r.db, r.task.id, "codex"));
  assert.equal(line, "Codex raised 1 concern. Claude Code addressed 1. Codex is satisfied.");
  assert.ok(section.includes(`\`\`\`text\n${line}\n\`\`\``), "the line the task screen shows, fenced");
  assert.ok(section.includes("Codex reviewed this task: a model's opinion, not a check. Its model:\n\n```text\ngpt-6-luna\n```"));
  assert.ok(section.includes("2 reviews and 1 round of fixes."));
  assert.ok(section.includes("Findings of review 2, the last: none listed."));
  assert.ok(section.includes("### Checked, as review 2, the last says\n\n```text\n- calc.py: add returns a + b\n- the criterion\n```"), "the last review's Checked lines, fenced");
  assert.doesNotMatch(section, /returns a - b/, "only the last review's findings");
  assert.doesNotMatch(section, /Not addressed/);
  assert.ok(section.trimEnd().endsWith("Accepted by the owner."));
});

test("unresolved after two rounds, with the owner's note: the last review's findings capped at 10, the builder's reasons from the last round, and the note, all fenced", async (t) => {
  const r = await rig(t, { reviewer: true });
  r.review("concerns", "Verdict: concerns\nFindings:\n- first review's finding");
  r.fixed("Addressed:\n- first\n\nNot addressed, and why:\n- round one's reason");
  r.review("concerns", "Verdict: concerns\nFindings:\n- second review's finding");
  r.fixed("Addressed:\n- second\n\nNot addressed, and why:\n- calc.py:9: the style rule is the repository's own\n- tests: none exist to extend");
  const twelve = Array.from({ length: MAX_BODY_FINDINGS + 2 }, (_, i) => `- finding ${i + 1}`).join("\n");
  r.review("concerns", `Verdict: concerns\nFindings:\n${twelve}`);
  r.ready();
  await decideTask(r.db,{ taskId: r.task.id, decision: "accept", note: "The style point is ours, merge it" });
  const section = reviewOf(body(r));
  assert.match(section, /Still disagree after 2 rounds: needs your judgment\./);
  assert.ok(section.includes("3 reviews and 2 rounds of fixes."));
  assert.ok(section.includes("### Findings of review 3, the last\n\n```text\n- finding 1\n"));
  assert.ok(section.includes("- finding 10\n```"));
  assert.doesNotMatch(section, /finding 11|finding 12|first review's|second review's/);
  assert.ok(section.includes("2 more findings were left out."));
  assert.ok(section.includes("The reviewer gave no account of what it checked in review 3, the last."), "a review with no Checked lines carries the plain note");
  assert.ok(section.includes("### Not addressed, and why\n\nClaude Code's words, from the last round of fixes:\n\n```text\n- calc.py:9: the style rule is the repository's own\n- tests: none exist to extend\n```"));
  assert.doesNotMatch(section, /round one's reason/);
  assert.ok(section.includes("Accepted by the owner, with this note:\n\n```text\nThe style point is ours, merge it\n```"));
  assert.doesNotMatch(unfenced(section), /style point|finding \d|calc\.py|gpt-6-luna/, "what a model or the owner wrote is fenced");
});

test("accepted by the mode: the section says so, with the recorded reasons, fenced", async (t) => {
  const r = await rig(t, { reviewer: true, mode: "full" });
  r.review("looks_right", "Verdict: looks right\nChecked:\n- calc.py: add returns a + b\n- the criterion\nNot checked: nothing left out\nFindings:\n- none");
  const reasons = "Accepted without you, as this run is fully autonomous: every check passed, the review is satisfied, and nothing an agent asked for was refused.";
  r.ready();
  await acceptByMode(r.db, r.task.id, reasons);
  const section = reviewOf(body(r));
  assert.ok(section.includes("```text\nCodex found nothing to fix.\n```"));
  assert.ok(section.includes("1 review and 0 rounds of fixes."));
  assert.ok(section.includes("Findings of the review: none listed."));
  assert.ok(section.includes(`Accepted without the owner (fully autonomous):\n\n\`\`\`text\n${reasons}\n\`\`\``));
  assert.doesNotMatch(section, /Accepted by the owner/);
});

test("reviewer and builder text with a mention, a closing keyword and a closing fence stays inside its fence", async (t) => {
  const r = await rig(t, { reviewer: true });
  const hostile = "@someone Fixes #1\n```\n@someone Fixes #1 outside?\n````";
  r.review("concerns", `Verdict: concerns\nFindings:\n- calc.py:1: @someone Fixes #1 \`\`\`\n- \`\`\`\`\n- ${hostile.split("\n").join(" ")}`);
  r.fixed(`Addressed:\n- x\n\nNot addressed, and why:\n- @someone Fixes #1 \`\`\`\`\``);
  r.review("concerns", `Verdict: concerns\nChecked:\n- calc.py: @someone Fixes #1 \`\`\`\`\nNot checked: nothing\nFindings:\n- calc.py:1: @someone Fixes #1 \`\`\`\n- \`\`\`\`\`\`\nfree text after: ${hostile}`);
  r.ready();
  await decideTask(r.db,{ taskId: r.task.id, decision: "accept", note: "@someone Fixes #1 ```" });
  const text = body(r);
  assert.ok(text.includes("@someone Fixes #1"), "the text is in the body, as data");
  const outside = unfenced(text);
  assert.doesNotMatch(outside, /@someone/);
  assert.doesNotMatch(outside, /Fixes #1/);
  assert.doesNotMatch(outside, /```/, "every fence that opens closes, and no fence is left over");
  // Every fence is longer than any backtick run inside it, so nothing inside can close it.
  for (const block of text.matchAll(/^(`{3,})text\n([\s\S]*?)\n\1$/gm)) {
    const longest = Math.max(0, ...[...block[2]!.matchAll(/`+/g)].map((m) => m[0].length));
    assert.ok(block[1]!.length > longest, `a fence of ${block[1]!.length} around a run of ${longest}`);
  }
});

// The closing line and the reference credits. The closing line is the only one Botbench writes, built from an integer
// it stored or parsed from the owner's run message; the credits are the builder's lines, fenced under Botbench's heading.

/** Every closing reference in a text, as GitHub would read one. */
const closings = (text: string): string[] => text.match(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b:?\s+[\w.-]*\/?[\w.-]*#\d+/gi) ?? [];
const accepted = async (r: Rig): Promise<string> => {
  r.ready();
  await decideTask(r.db, { taskId: r.task.id, decision: "accept" });
  return body(r);
};

test("the issue number of a run message: one issue, none, two, one of another repository, and text that only names it elsewhere", () => {
  assert.equal(messageIssue("Issue #136 on jon-lange/botbench"), 136);
  assert.equal(messageIssue("#136"), 136);
  assert.equal(messageIssue("Fix #7, as #7 asks"), 7, "one issue named twice is still one");
  assert.equal(messageIssue("Add a function"), null);
  assert.equal(messageIssue(null), null);
  assert.equal(messageIssue("Fix #1 and #2"), null);
  assert.equal(messageIssue("As cli/cli#5 does"), null, "an issue of another repository is not this one's");
  assert.equal(messageIssue("See https://example.com/page#5 and &#35;"), null);
});

test("a message that names one issue: the body's first line closes it, once, and the Issue section does not repeat it", async (t) => {
  const r = await rig(t, { reviewer: false, prompt: "Issue #136 on jon-lange/botbench" });
  const text = await accepted(r);
  assert.equal(text.split("\n")[0], "Closes #136");
  assert.deepEqual(closings(text), ["Closes #136"]);
  assert.ok(text.includes("## Issue\n\nThe owner's message for the run names this issue, which the first line closes."));
});

test("a message that names no issue, two issues, or another repository's issue: no closing line and no Issue section", async (t) => {
  for (const prompt of ["Add a function", "Fix #1 and #2", "Do what cli/cli#5 does"]) {
    const r = await rig(t, { reviewer: false, prompt });
    const text = await accepted(r);
    assert.ok(text.startsWith("Built on "), prompt);
    assert.deepEqual(closings(unfenced(text)), [], prompt);
    assert.doesNotMatch(text, /## Issue/, prompt);
  }
});

test("the builder's reference credits: under Botbench's heading, fenced, once each, capped in number and length", async (t) => {
  const many = Array.from({ length: MAX_CREDITS + 3 }, (_, i) => `approach from paperclip src/part${i + 1}.ts`).join("\n");
  const r = await rig(t, {
    reviewer: false,
    said: [
      "Done. The wait is the approach from Paperclip server/src/services/issues.ts: read the time the agent says.",
      "Also (approach from paperclip `packages/adapters/parse.ts`). Again, approach from Paperclip server/src/services/issues.ts.",
      "The approach from the start of it was plain.",
      `approach from long ${"a/".repeat(200)}x.ts`,
      many,
    ],
  });
  const text = await accepted(r);
  const section = /## Reference credits\n[\s\S]*?(?=\n## |\nTask \d+ · )/.exec(text)![0];
  assert.ok(section.startsWith("## Reference credits\n\nWhere the builder says an approach came from, in its own words:\n\n```text\n"));
  const lines = /```text\n([\s\S]*?)\n```/.exec(section)![1]!.split("\n");
  assert.deepEqual(lines.slice(0, 2), ["approach from Paperclip server/src/services/issues.ts", "approach from paperclip packages/adapters/parse.ts"]);
  assert.ok(lines[2]!.startsWith("approach from long a/a/"));
  assert.equal(lines[2]!.length, MAX_CREDIT_CHARS);
  assert.equal(lines.length, MAX_CREDITS);
  assert.ok(section.includes("6 more credits were left out."), "16 different credits, 10 listed");
  assert.doesNotMatch(section, /the start of it/);
  assert.doesNotMatch(unfenced(section), /paperclip/i);
});

test("a round of fixes in a new session keeps the build session's credits, oldest first", async (t) => {
  const r = await rig(t, { reviewer: true, said: ["Built it: approach from paperclip build/first.ts"] });
  r.review("concerns", "Verdict: concerns\nFindings:\n- calc.py:1: x");
  const at = now();
  const fresh = Number(r.db.prepare("INSERT INTO attempts (driver, model, resume_cursor, status, pgid, created_at, updated_at) VALUES ('claude-code', NULL, NULL, 'ended', NULL, ?, ?)").run(at, at).lastInsertRowid);
  r.db.prepare("INSERT INTO events (attempt_id, turn, ts, type, payload) VALUES (?, 1, ?, 'text', ?)").run(fresh, at, JSON.stringify({ type: "text", text: "Fixed: approach from paperclip fix/second.ts" }));
  moveTask(r.db, r.task.id, "building", { attemptId: fresh, note: "round 1 of fixes, in a new session" });
  insertRefinement(r.db, { taskId: r.task.id, round: 1, attemptId: fresh, outcome: "finished", changed: true, reply: "Addressed:\n- x\n\nNot addressed, and why:\n- none", problem: null, fromCommit: getTask(r.db, r.task.id)!.headCommit!, headCommit: getTask(r.db, r.task.id)!.headCommit!, startedAt: at });
  assert.equal(getTask(r.db, r.task.id)!.attemptId, fresh, "the task now points at the new session");
  r.review("looks_right", "Verdict: looks right\nChecked:\n- calc.py\nFindings:\n- none");
  const text = await accepted(r);
  assert.ok(text.includes("```text\napproach from paperclip build/first.ts\napproach from paperclip fix/second.ts\n```"));
});

test("no credits from the builder: no Reference credits section", async (t) => {
  const r = await rig(t, { reviewer: false, said: ["I added add(a, b) in calc.py."] });
  assert.doesNotMatch(await accepted(r), /Reference credits/);
});

test("builder text with a closing keyword, a mention and a fence stays fenced and makes no closing line; the message's issue alone does", async (t) => {
  for (const prompt of ["Add a function", "Fix #12"]) {
    const r = await rig(t, { reviewer: true, prompt, said: ["Closes #9 ```` approach from @someone `x/y.ts` fixes #9"] });
    r.review("concerns", "Verdict: concerns\nFindings:\n- Closes #9");
    r.fixed("Addressed:\n- x\n\nNot addressed, and why:\n- Closes #9 @someone ````");
    const text = await accepted(r);
    assert.ok(text.includes("Closes #9") && text.includes("approach from @someone x/y.ts"), "the builder's words are in the body, as data");
    const outside = unfenced(text);
    assert.deepEqual(closings(outside), prompt === "Fix #12" ? ["Closes #12"] : [], prompt);
    assert.ok(prompt === "Fix #12" ? text.startsWith("Closes #12\n\nBuilt on ") : text.startsWith("Built on "), prompt);
    assert.doesNotMatch(outside, /@someone|```|#9/);
    for (const block of text.matchAll(/^(`{3,})text\n([\s\S]*?)\n\1$/gm)) {
      const longest = Math.max(0, ...[...block[2]!.matchAll(/`+/g)].map((m) => m[0].length));
      assert.ok(block[1]!.length > longest);
    }
  }
});
