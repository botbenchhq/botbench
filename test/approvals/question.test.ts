import assert from "node:assert/strict";
import { test } from "node:test";
import { answerProblem, AUTONOMOUS_ANSWER, MAX_ANSWER, parseStoredQuestion, readQuestion, storedQuestion, type Question } from "../../src/approvals/question.ts";
import { claudeArgs, controlAnswer } from "../../src/drivers/claude-code.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { approvalMessage } from "../../src/push.ts";

// The question an agent puts to the owner (src/approvals/question.ts), read and answered: pure functions only. The
// input is in the shape Anthropic's Agent SDK guide gives for AskUserQuestion; the owner's capture
// (test/support/capture-question.ts) records it from the real CLI.

const asked = (over: Record<string, unknown> = {}, options: unknown = [{ label: "Hello", description: "The long one" }, { label: "Hi", description: "The short one" }]) => ({
  questions: [{ question: "Which greeting should I use?", header: "Greeting", options, multiSelect: false, ...over }],
});

test("one question with two to four choices is read as its card shows it: the question, its header, and each choice's label and line", () => {
  assert.deepEqual(readQuestion(asked()), { text: "Which greeting should I use?", header: "Greeting", choices: [{ label: "Hello", description: "The long one" }, { label: "Hi", description: "The short one" }] });
  const four = readQuestion(asked({}, [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D", description: "" }]));
  assert.ok(!("problem" in four));
  assert.deepEqual(four.choices.map((c) => [c.label, c.description]), [["A", ""], ["B", ""], ["C", ""], ["D", ""]], "a choice with no line has an empty one");
  // A header and multiSelect may be left out; a preview, which Botbench never asks for, is not kept.
  const bare = readQuestion({ questions: [{ question: "Q?", options: [{ label: "A", preview: "<b>x</b>" }, { label: "B" }] }] });
  assert.deepEqual(bare, { text: "Q?", header: "", choices: [{ label: "A", description: "" }, { label: "B", description: "" }] });
});

test("a question Botbench cannot show as it is gets a plain reason for the agent and no card: no question text, too few or too many choices, wrong types, more than one question", () => {
  const cases: [string, unknown][] = [
    ["not an object", "Which?"],
    ["no list of questions", { question: "Which?" }],
    ["no question", { questions: [] }],
    ["two questions", { questions: [asked().questions[0], asked().questions[0]] }],
    ["the question not an object", { questions: ["Which?"] }],
    ["no question text", asked({ question: "  " })],
    ["question text a number", asked({ question: 7 })],
    ["question text too long", asked({ question: "x".repeat(2001) })],
    ["header not text", asked({ header: 3 })],
    ["multiSelect not true or false", asked({ multiSelect: "yes" })],
    ["several choices allowed, which the card's one choice cannot answer", asked({ multiSelect: true })],
    ["no list of choices", asked({ options: "Hello, Hi" })],
    ["one choice", asked({}, [{ label: "Hello" }])],
    ["five choices", asked({}, [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }])],
    ["a choice with no label", asked({}, [{ label: "A" }, { description: "B" }])],
    ["a label that is not text", asked({}, [{ label: "A" }, { label: 2 }])],
    ["a description that is not text", asked({}, [{ label: "A" }, { label: "B", description: ["x"] }])],
    ["two choices with the same label", asked({}, [{ label: "A" }, { label: "A" }])],
    ["a label too long", asked({}, [{ label: "A" }, { label: "x".repeat(201) }])],
  ];
  for (const [name, input] of cases) {
    const read = readQuestion(input);
    assert.ok("problem" in read, name);
    assert.match(read.problem, /^Botbench could not show this question to the owner: .+ Nothing was asked\. Ask one question at a time, with two to four choices/, name);
  }
  assert.match((readQuestion(asked({}, [{ label: "Hello" }])) as { problem: string }).problem, /it has 1 choice\./);
  assert.match((readQuestion({ questions: [{}, {}] }) as { problem: string }).problem, /it holds 2 questions, and Botbench asks one at a time\./);
});

test("an answer is the owner's own text, with something in it, and at most as long as a note", () => {
  assert.equal(answerProblem("Hi"), null);
  assert.equal(answerProblem("  my own words, with spaces kept  "), null);
  assert.equal(answerProblem("x".repeat(MAX_ANSWER)), null);
  assert.match(answerProblem("x".repeat(MAX_ANSWER + 1))!, /at most 2000 characters/);
  assert.match(answerProblem("   ")!, /Write an answer/);
  assert.match(answerProblem(3)!, /Write an answer/);
});

test("a question is stored and read back as it was shown; anything else stored reads as no question", () => {
  const q = readQuestion(asked()) as Question;
  assert.deepEqual(parseStoredQuestion(storedQuestion(q)), q);
  assert.equal(parseStoredQuestion(null), null);
  assert.equal(parseStoredQuestion("not json"), null);
  assert.equal(parseStoredQuestion(JSON.stringify({ text: "Q", header: "", choices: [{ label: 1 }] })), null);
});

const request = (name: string, input: unknown): Extract<DriverEvent, { type: "permission_request" }> => ({ type: "permission_request", id: "req-1", toolCallId: "toolu_1", name, input, reason: null });

test("the owner's answer goes back to Claude Code as an allow whose updatedInput is the original input with the answers keyed by the question's text", () => {
  const input = asked();
  const answered = controlAnswer(request("AskUserQuestion", input), { decision: "allow", answers: { "Which greeting should I use?": "Hi" } });
  assert.deepEqual(answered, { reply: { behavior: "allow", updatedInput: { ...input, answers: { "Which greeting should I use?": "Hi" } } }, decision: "answered", note: "Hi" });
  // The owner's own words go as they are, whatever they hold: they are text for the agent, never run.
  const own = controlAnswer(request("AskUserQuestion", input), { decision: "allow", answers: { "Which greeting should I use?": "  $(rm -rf ~) or *hello*  " } });
  assert.deepEqual((own.reply.updatedInput as { answers: unknown }).answers, { "Which greeting should I use?": "  $(rm -rf ~) or *hello*  " });
});

test("an allow of a question with no answer is a refusal, and a refusal of a question tells the agent the reason alone", () => {
  const input = asked();
  assert.deepEqual(controlAnswer(request("AskUserQuestion", input), { decision: "allow" }), { reply: { behavior: "deny", message: "Botbench had no answer from the owner to give." }, decision: "denied", note: "Botbench had no answer from the owner to give." });
  assert.deepEqual(controlAnswer(request("AskUserQuestion", input), { decision: "decline", refused: AUTONOMOUS_ANSWER }).reply, { behavior: "deny", message: AUTONOMOUS_ANSWER });
  // Any other tool's refusal still says that nothing was run, and answers are never added to its input.
  assert.match(String(controlAnswer(request("Bash", { command: "ls" }), { decision: "decline", refused: "No." }).reply.message), /^Botbench's permission check denied this request without asking the owner: No\. Nothing was run\.$/);
  assert.deepEqual(controlAnswer(request("Bash", { command: "ls" }), { decision: "allow", answers: { x: "y" } }), { reply: { behavior: "allow", updatedInput: { command: "ls" } }, decision: "allowed", note: null });
});

test("the fully autonomous note tells the agent to use its best judgement and say which choice it made", () => {
  assert.match(AUTONOMOUS_ANSWER, /fully autonomous/);
  assert.match(AUTONOMOUS_ANSWER, /Use your best judgement/);
  assert.match(AUTONOMOUS_ANSWER, /say in your final reply which option you chose/);
});

test("a gated read-only attempt (a planner) has the question tool; an ungated one (a reviewer) does not", () => {
  const confinement = { cwd: "/tmp/plan", dataDir: "/tmp/home", allowedHosts: [] };
  const gated = claudeArgs({ readOnly: true, gated: true, confinement });
  assert.equal(gated[gated.indexOf("--tools") + 1], "Read,Glob,Grep,Bash,AskUserQuestion");
  const ungated = claudeArgs({ readOnly: true, confinement });
  assert.equal(ungated[ungated.indexOf("--tools") + 1], "Read,Glob,Grep,Bash");
});

test("a question's notification is titled 'A task has a question' and opens its task, or its run for a planner; any other request's is 'An approval is waiting'", () => {
  const q = readQuestion(asked()) as Question;
  assert.deepEqual(approvalMessage({ taskId: 4, runId: null, question: q }), { title: "A task has a question", path: "/#/tasks/4" });
  assert.deepEqual(approvalMessage({ taskId: null, runId: 2, question: q }), { title: "A task has a question", path: "/#/runs/2" });
  assert.deepEqual(approvalMessage({ taskId: 4, runId: null, question: null }), { title: "An approval is waiting", path: "/#/tasks/4" });
});
