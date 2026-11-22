import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewerPrompt } from "../../src/engine/roles.ts";

const task = { title: "Add a function that adds two numbers", criteria: ["calc.py defines add(a, b)"] };

test("a reviewer with no tools is told it has only what it is sent, and is never told to read files or run commands", () => {
  const prompt = reviewerPrompt({ task, diff: "diff --git a/calc.py b/calc.py\n", cut: { shown: 10, total: 20 }, tools: false });
  assert.match(prompt, /You have no tools: you cannot read files, run commands or reach the network\. Everything there is to review is in this message\./);
  assert.doesNotMatch(prompt, /run read-only commands|Read the rest from the files|working folder/);
  assert.match(prompt, /The diff is 20 characters long and was cut after the first 10\. Say in your findings that you saw only part of it\./);
  assert.match(prompt, /Verdict: looks right\nFindings:/);
});

test("a reviewer with tools keeps being told where its read-only copy is", () => {
  const prompt = reviewerPrompt({ task, diff: "x", cut: { shown: 1, total: 2 } });
  assert.match(prompt, /You may read files and run read-only commands there/);
  assert.match(prompt, /Read the rest from the files if you need it/);
});
