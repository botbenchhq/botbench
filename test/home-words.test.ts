import assert from "node:assert/strict";
import test from "node:test";
import { bannedIn } from "../e2e/voice.ts";
import type { Home, HomeItem, WorkItem } from "../web/src/api/client.ts";
import { acceptedLine, countedNames, endedLine, facts, failedLine, headline, hrefOf, lasted, need, ORDER_LINE, progressLine, subline, summarized, triesAgain, waitLine } from "../web/src/screens2/home/home-model.ts";
import { aboutLine, agentWord, changed, changedShort, kindWord, noneLine, olderLine, shownLine, STATES, stateWord } from "../web/src/screens2/work/work-model.ts";

// What Home and Work say in words, decided without a browser, from what /api/home and /api/work send. Where each item
// stands, why and in what order is the server's (test/api/home.test.ts): nothing here decides it.

const home = (needs: number, going: number, waiting = 0, lastDay = 0, total = 0) => ({ needsYou: { total: needs }, inProgress: { total: going }, waiting: { total: waiting }, completed: { lastDay }, total }) as unknown as Home;
const item = (over: Partial<HomeItem>): HomeItem => ({ kind: "task", id: 14, title: "Run other.sh", repo: "/Users/owner/code/repo-refine", agents: ["claude-code"], place: "needs-you", cause: "approval", since: "2026-11-23T10:00:00.000Z", updatedAt: "2026-11-23T10:00:00.000Z", status: "building", mode: "manual", ...over });
const NOW = Date.parse("2026-11-23T10:12:30.000Z");
const UTC = { locale: "en-GB", timeZone: "UTC" };

test("the headline states the situation in words, with the right number for one and for none", () => {
  assert.equal(headline(home(3, 2)), "3 things need you, 2 are in progress");
  assert.equal(headline(home(1, 1)), "1 thing needs you, 1 is in progress");
  assert.equal(headline(home(3, 0)), "3 things need you");
  assert.equal(headline(home(0, 2)), "Nothing needs you, 2 are in progress");
  assert.equal(headline(home(0, 0)), "Nothing needs you");
  assert.equal(subline(home(3, 2, 1, 2, 6)), "1 is waiting and goes on by itself. 2 completed in the last day.");
  assert.equal(subline(home(7, 18, 6, 14, 50)), "6 are waiting and go on by themselves. 14 completed in the last day. 50 in all.");
  assert.equal(subline(home(1, 0)), null);
});

test("each thing that needs the owner says what kind it is, what is so and its one action", () => {
  assert.deepEqual(need(item({ approval: { tool: "Bash", command: "sh other.sh" } })), { label: "Approval", lead: "Claude Code is paused until you answer", words: "Claude Code asks to run", code: "sh other.sh", action: "Answer" });
  assert.deepEqual([need(item({ agents: ["codex"], approval: { tool: "WebFetch", command: "https://example.com" } })).words, need(item({ approval: { tool: "AskUserQuestion", command: "{}" } })).words], ["Codex asks to use WebFetch", "Claude Code asks you a question"]);
  assert.deepEqual(need(item({ cause: "failure", failure: "failed", reason: "Claude Code finished without changing any file." })), { label: "Failed", lead: "It can be resumed", words: "Claude Code finished without changing any file.", code: null, action: "See what failed" });
  assert.deepEqual([need(item({ cause: "failure", failure: "stopped", reason: "It went silent." })).label, need(item({ kind: "run", status: "done", cause: "failure", failure: "stopped" })).action], ["Stopped", "See why it stopped"]);
  assert.deepEqual([need(item({ kind: "run", cause: "plan", taskCount: 4 })).words, need(item({ kind: "run", cause: "plan", taskCount: 1 })).action], ["4 tasks, nothing is built before you approve", "Read the plan"]);
  assert.equal(need(item({ kind: "run", cause: "result", readyCount: 1, taskCount: 3 })).words, "1 task of 3 ready for review");
  // A task's result is said in the server's own sentence about its evidence, and never called acceptable when that cannot be read.
  assert.equal(need(item({ cause: "result", evidence: { state: "stale", words: "The checks are out of date." } })).words, "The checks are out of date.");
  assert.equal(need(item({ cause: "result", evidence: null })).words, "Botbench cannot read its evidence now, so it cannot be accepted yet.");
  assert.equal(facts(item({})), "Task 14 · repo-refine · Manual");
  assert.equal(facts(item({ kind: "run", id: 9, mode: "full" })), "Run 9 · repo-refine · Fully autonomous");
  assert.equal(facts(item({ kind: "chat", repo: null, mode: null })), "Chat");
  assert.deepEqual([hrefOf({ kind: "task", id: 14 }), hrefOf({ kind: "run", id: 9 }), hrefOf({ kind: "chat", id: 31 })], ["#/tasks/14", "#/runs/9", "#/chats/31"]);
});

test("a wait is said in whole minutes, and a usage limit with the time it is tried again", () => {
  assert.equal(lasted("2026-11-23T10:00:00.000Z", NOW).words, "12 min");
  assert.equal(lasted("2026-11-23T10:12:00.000Z", NOW).words, "under 1 min");
  assert.equal(lasted("2026-11-23T09:08:00.000Z", NOW).words, "1 h 4 min");
  assert.equal(triesAgain("2026-11-23T14:30:00.000Z", NOW, UTC), "tries again at 14:30");
  assert.equal(triesAgain("2026-11-24T14:30:00.000Z", NOW, UTC), "tries again on 24 November at 14:30");
  assert.equal(triesAgain("2026-11-23T10:00:00.000Z", NOW, UTC), "trying again now");
  assert.equal(triesAgain(null, NOW, UTC), null);
  assert.equal(waitLine(item({ place: "waiting", cause: "usage-limit", retryAt: "2026-11-23T14:30:00.000Z" }), NOW, UTC), "Claude Code · tries again at 14:30");
  assert.equal(waitLine(item({ place: "waiting", cause: "dependency", waitingFor: { taskId: 19, title: "x" } }), NOW, UTC), "task 19 goes first");
  assert.equal(progressLine(item({ place: "in-progress", cause: null, status: "verifying", agents: ["codex"] })), "Checking · Codex · repo-refine");
  assert.equal(progressLine(item({ kind: "run", place: "in-progress", cause: null, status: "running", finishedCount: 2, taskCount: 5 })), "Working · 2 of 5 tasks finished · Claude Code · repo-refine");
});

test("completed work says who accepted it and what was opened; what ended otherwise is counted in words", () => {
  assert.equal(acceptedLine({ accepted: { by: "owner", pullRequests: [48] } }), "Accepted · pull request #48 opened");
  assert.equal(acceptedLine({ accepted: { by: "mode", pullRequests: [] } }), "Accepted without you");
  assert.equal(acceptedLine({ accepted: { by: "owner", pullRequests: [1, 2] } }), "Accepted · 2 pull requests opened");
  assert.equal(endedLine({ rejected: 1, cancelled: 1, stopped: 0, other: 0 }), "1 rejected and 1 cancelled are in Work");
  assert.equal(endedLine({ rejected: 2, cancelled: 2, stopped: 1, other: 1 }), "2 rejected, 2 cancelled, 1 stopped and 1 with nothing to review are in Work");
  assert.equal(endedLine({ rejected: 1, cancelled: 0, stopped: 0, other: 0 }), "1 rejected is in Work");
  assert.equal(endedLine({ rejected: 0, cancelled: 0, stopped: 0, other: 0 }), null);
  assert.deepEqual([failedLine(0), failedLine(1), failedLine(3)], [null, "1 failure with nothing to resume is in Work", "3 failures with nothing to resume are in Work"]);
});

test("a group is summarized only once the server sent fewer rows than it holds, and a summary names the most frequent first", () => {
  assert.equal(summarized({ total: 6, items: [1, 2, 3, 4, 5, 6] }), false);
  assert.equal(summarized({ total: 18, items: [1, 2, 3, 4, 5, 6] }), true);
  assert.deepEqual(countedNames([{ name: "a", count: 8 }, { name: "b", count: 6 }, { name: "c", count: 3 }, { name: "d", count: 1 }], 2, (name) => name.toUpperCase()), [{ count: 8, name: "A" }, { count: 6, name: "B" }, { count: 4, name: "in 2 more" }]);
  assert.deepEqual(countedNames([{ name: "a", count: 2 }], 2, (name) => name), [{ count: 2, name: "a" }]);
});

test("Work says a row's state in the product's own words, and a wait by what it waits for", () => {
  const row = (over: Record<string, unknown>): WorkItem => ({ kind: "task", id: 22, status: "building", waitingOnApproval: false, resuming: false, waitingFor: null, place: "in-progress", cause: null, agents: ["claude-code"], repo: "/code/docs-site", ...over }) as unknown as WorkItem;
  assert.equal(stateWord(row({})), "Working");
  assert.equal(stateWord(row({ waitingOnApproval: true, place: "needs-you", cause: "approval" })), "Needs input");
  assert.equal(stateWord(row({ status: "waiting_for_limit", place: "waiting", cause: "usage-limit" })), "Waiting on usage limit");
  assert.equal(stateWord(row({ waitingFor: { taskId: 3, title: "x" }, place: "waiting", cause: "dependency" })), "Waiting on dependency");
  assert.deepEqual(["awaiting_decision", "accepted", "rejected", "interrupted", "failed", "cancelled"].map((status) => stateWord(row({ status }))), ["Ready for review", "Accepted", "Rejected", "Stopped", "Failed", "Cancelled"]);
  assert.equal(stateWord(row({ kind: "run", status: "awaiting_plan_approval", attemptId: 1, decidedCount: 0 })), "Plan ready for review");
  // A run says what waits in it, not only that it is still working or done.
  const running = { kind: "run", status: "running", attemptId: 1, decidedCount: 0, place: "needs-you" };
  assert.deepEqual([stateWord(row({ ...running, cause: "result" })), stateWord(row({ ...running, status: "done", cause: "failure", failure: "stopped" })), stateWord(row({ ...running, cause: "failure", failure: "failed" })), stateWord(row({ ...running, waitingOnApproval: true, cause: "approval" }))], ["Ready for review", "Stopped", "Failed", "Needs input"]);
  assert.deepEqual([stateWord(row({ kind: "chat", place: "chat" })), stateWord(row({ kind: "chat", place: "needs-you", cause: "approval" }))], ["Chat", "Needs input"]);
  assert.deepEqual([kindWord({ kind: "task", id: 22 }), kindWord({ kind: "run", id: 9 }), kindWord({ kind: "chat", id: 31 })], ["Task 22", "Run 9", "Chat"]);
  assert.deepEqual([agentWord({ agents: ["codex"] }), agentWord({ agents: ["codex", "grok", "claude-code"] }), agentWord({ agents: [] })], ["Codex", "3 agents", "None"]);
  assert.deepEqual([changed("2026-11-23T10:12:00.000Z", NOW, UTC), changed("2026-11-23T10:00:00.000Z", NOW, UTC), changed("2026-11-21T17:40:00.000Z", NOW, UTC)], ["Now", "12 minutes ago", "21 November at 17:40"]);
  // The column's own short form of the same: the title keeps the room.
  assert.deepEqual([changedShort("2026-11-23T10:12:00.000Z", NOW, UTC), changedShort("2026-11-23T10:00:00.000Z", NOW, UTC), changedShort("2026-11-23T07:00:00.000Z", NOW, UTC), changedShort("2026-11-21T17:40:00.000Z", NOW, UTC)], ["Now", "12 min ago", "3 h ago", "21 November"]);
  assert.equal(aboutLine(63, false), "Every task, run and chat on this workbench. 63 in all, newest change first.");
  assert.equal(shownLine(14, 63), "14 of 63 shown");
  assert.equal(olderLine({ count: 49, oldest: "2026-11-03T08:05:00.000Z" }, UTC), "49 more, back to 3 November at 08:05");
  assert.deepEqual([noneLine({ all: 0 }, false, false), noneLine({ all: 4 }, true, false), noneLine({ all: 0 }, false, true)], ["No work yet. Each chat, run and task you start is listed here.", "Nothing matches. Clear the search or choose All and Any state to see everything.", "Nothing is hidden."]);
});

test("none of Home's or Work's own words is one the voice guide keeps off the screen", () => {
  const said = [
    ORDER_LINE, headline(home(3, 2)), subline(home(3, 2, 1, 2, 60))!, endedLine({ rejected: 1, cancelled: 1, stopped: 1, other: 1 })!, failedLine(2)!, aboutLine(3, true), aboutLine(3, false),
    ...STATES.map((state) => state.label),
    ...(["approval", "failure", "plan", "result"] as const).flatMap((cause) => Object.values(need(item({ cause, failure: "stopped", kind: cause === "plan" ? "run" : "task", evidence: null }))).filter((value): value is string => typeof value === "string")),
  ];
  assert.deepEqual(said.flatMap((text) => bannedIn(text).map((term) => `"${term}" in: ${text}`)), []);
});
