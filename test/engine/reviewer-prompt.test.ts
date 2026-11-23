import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewerPrompt } from "../../src/engine/roles.ts";

const task = { title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b)"] };

test("a reviewer with no tools is told it has only what it is sent, and is never told to read files or run commands", () => {
  const prompt = reviewerPrompt({ task, diff: "diff --git a/calc.py b/calc.py\n", cut: { shown: 10, total: 20 }, tools: false });
  assert.match(prompt, /You have no tools: you cannot read files, run commands or reach the network\. Everything there is to review is in this message\./);
  assert.doesNotMatch(prompt, /run read-only commands|Read the rest from the files|working folder/);
  assert.match(prompt, /The diff is 20 characters long and was cut after the first 10\. Say in your findings that you saw only part of it\./);
  assert.match(prompt, /Verdict: looks right\nChecked:\n/);
});

test("the reviewer must say what it checked, even with no finding: the verdict line, then Checked: with two to five lines, then one Not checked: line", () => {
  for (const tools of [true, false]) {
    const prompt = reviewerPrompt({ task, diff: "x", cut: null, tools });
    assert.match(prompt, /Reply in exactly this form, and keep it short:\nVerdict: looks right\nChecked:\n- [^\n]+\n- [^\n]+\nNot checked: [^\n]+\nFindings:\n- /, "the form puts Checked lines and one Not checked line between the verdict and the findings");
    assert.match(prompt, /Always write the "Checked:" heading with two to five lines naming what you examined, then the one line "Not checked:", even when there is no finding\./);
  }
});

test("a reviewer with tools is told the path of the task's copy, that it changes none of the task's files, and whether it may search the web", () => {
  const prompt = reviewerPrompt({ task, diff: "x", cut: null, copy: "/data/worktrees/run-1/task-1", webSearch: true });
  assert.match(prompt, /The task's copy of the repository, at the task's branch, is the folder \/data\/worktrees\/run-1\/task-1; it may be your working folder or beside it\./);
  assert.match(prompt, /you cannot create, change or delete any file of the task's, and your commands reach no network, though you may use your own web search\./);
  assert.doesNotMatch(reviewerPrompt({ task, diff: "x", cut: null, copy: "/c" }), /web search/);
});

test("a reviewer with tools keeps being told where its read-only copy is", () => {
  const prompt = reviewerPrompt({ task, diff: "x", cut: { shown: 1, total: 2 } });
  assert.match(prompt, /You may read files and run read-only commands there/);
  assert.match(prompt, /Read the rest from the files if you need it/);
});
