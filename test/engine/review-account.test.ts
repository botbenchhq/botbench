import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { reviewOf } from "../../src/api/tasks.ts";
import { GROK } from "../../src/drivers/grok.ts";
import { autoAccept } from "../../src/engine/modes.ts";
import { outcomeLine, parseChecked, reviewOutcome, type LoopReview } from "../../src/engine/refine.ts";
import { runReview } from "../../src/engine/review.ts";
import { openStore, now } from "../../src/store/db.ts";
import { chatReplayDriver } from "../support/replay-chat.ts";
import { initRepo, ownerCommit, tempDir, write } from "../support/repo.ts";

/*
 * A review must say what it checked. The bare-verdict review is Grok 1.0.92's own, recorded in
 * test/recordings/grok-review.json before the prompt asked for Checked lines, and replayed here unchanged.
 */

const recorded = (): string => {
  const recording = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "recordings", "grok-review.json"), "utf8")) as { sessions: { review: { lines: string[] } } };
  return recording.sessions.review.lines.map((line) => JSON.parse(line) as { type: string; data?: string }).filter((e) => e.type === "text").map((e) => e.data).join("");
};

test("a bare-verdict review, Grok's recorded one, is stored exactly as given, carries the plain note, and is not satisfied, so a fully autonomous accept does not go ahead", async (t) => {
  const root = tempDir("botbench-review-account-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const baseCommit = initRepo(repo);
  write(repo, "calc.py", "def add(a, b):\n    return a - b\n");
  const headCommit = ownerCommit(repo, "add calc.py");
  const db = openStore(home);
  t.after(() => db.close());
  const at = now();
  const taskId = Number(db.prepare("INSERT INTO tasks (repo_path, prompt, status, created_at, updated_at) VALUES (?, 'Add a function that adds two numbers', 'reviewing', ?, ?)").run(repo, at, at).lastInsertRowid);

  const review = await runReview({
    db, driver: chatReplayDriver(GROK, "review"), model: null, taskId,
    task: { title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b), which returns the sum of a and b"] },
    worktree: repo, baseCommit, headCommit, confinement: { dataDir: home, allowedHosts: [] },
  });

  const given = recorded();
  assert.match(given, /^Verdict: concerns\nFindings:\n/, "the recording is the bare-verdict review this test is about");
  assert.doesNotMatch(given, /checked/i);
  assert.equal(review.outcome, "reviewed");
  assert.equal(review.text, given, "stored exactly as the reviewer gave it");
  assert.equal(review.verdict, "concerns");
  assert.deepEqual(parseChecked(review.text), []);

  const shown = reviewOf(db, taskId) as { reviews: { text: string; checked: string[]; accountNote: string | null }[] };
  assert.equal(shown.reviews[0]!.text, given);
  assert.deepEqual(shown.reviews[0]!.checked, []);
  assert.equal(shown.reviews[0]!.accountNote, "The reviewer gave no account of what it checked.");

  const outcome = reviewOutcome({ agent: GROK, builder: "claude-code", reviews: [review], refinements: [], cap: 0 });
  assert.notEqual(outcome, "satisfied");
  assert.equal(autoAccept({ checks: "passed", review: outcome, refusals: [] }).accept, false);
});

const lookingRight = (text: string): LoopReview => ({ outcome: "reviewed", verdict: "looks_right", text });
const loop = (review: LoopReview) => ({ agent: "codex", builder: "claude-code", reviews: [review], refinements: [], cap: 2 });

test("a looks-right verdict with no Checked lines is not satisfied: the mode does not accept, and both say why in plain words", () => {
  for (const text of ["Verdict: looks right\nFindings:\n- none", "Verdict: looks right\nChecked:\n- none\nNot checked: nothing left out\nFindings:\n- none"]) {
    const outcome = reviewOutcome(loop(lookingRight(text)));
    assert.equal(outcome, "unaccounted", text);
    assert.equal(outcomeLine(loop(lookingRight(text))), "Codex said it looks right but gave no account of what it checked: needs your judgment.");
    assert.deepEqual(autoAccept({ checks: "passed", review: outcome, refusals: [] }), { accept: false, why: "It needs your review: The reviewer gave no account of what it checked." });
  }
});

test("a looks-right verdict with Checked lines is still satisfied, and the mode accepts it", () => {
  const text = "Verdict: looks right\nChecked:\n- calc.py: add returns a + b\n- **the criterion**: add(a, b) is defined\nNot checked: nothing left out\nFindings:\n- none";
  assert.deepEqual(parseChecked(text), ["calc.py: add returns a + b", "**the criterion**: add(a, b) is defined"]);
  const outcome = reviewOutcome(loop(lookingRight(text)));
  assert.equal(outcome, "satisfied");
  assert.equal(outcomeLine(loop(lookingRight(text))), "Codex found nothing to fix.");
  assert.equal(autoAccept({ checks: "passed", review: outcome, refusals: [] }).accept, true);
});
