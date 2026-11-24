import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute } from "../web/src/app/route.ts";
import { composerAddress } from "../web/src/app/run-source.ts";

// The client's addresses, parsed as the shell parses them (web/src/app/route.ts), without a browser.

test("the address Make this a run opens, for a task and for a chat, is the composer on Plan a run with that source", () => {
  assert.deepEqual(parseRoute(composerAddress({ kind: "task", id: 12 })), { screen: "turn", start: "run", from: { kind: "task", id: 12 } });
  assert.deepEqual(parseRoute(composerAddress({ kind: "chat", id: 5 })), { screen: "turn", start: "run", from: { kind: "chat", id: 5 } });
  assert.deepEqual(parseRoute("#/turn?start=run&from=task-123456789012345"), { screen: "turn", start: "run", from: { kind: "task", id: 123456789012345 } });
});

test("a malformed Make this a run address opens no composer with a source: zero, leading zeros, an unknown kind, extra parts", () => {
  for (const at of [
    "#/turn?start=run&from=task-0",
    "#/turn?start=run&from=chat-0",
    "#/turn?start=run&from=task-012",
    "#/turn?start=run&from=chat-007",
    "#/turn?start=run&from=run-3",
    "#/turn?start=run&from=issue-3",
    "#/turn?start=run&from=Task-3",
    "#/turn?start=run&from=task-3&from=chat-4",
    "#/turn?start=run&from=task-3&proposal=1",
    "#/turn?start=run&from=task-3-4",
    "#/turn?start=run&from=task-3/",
    "#/turn?start=task&from=task-3",
    "#/turn?start=run&from=task-",
    "#/turn?start=run&from=task-1234567890123456",
  ]) {
    const route = parseRoute(at);
    assert.ok(!("from" in route), `${at} has no source: ${JSON.stringify(route)}`);
    assert.equal(route.screen, "none", at);
  }
});

test("the other addresses parse as before the parser moved out of the shell", () => {
  assert.deepEqual(parseRoute("#/turn"), { screen: "turn", start: null });
  assert.deepEqual(parseRoute("#/turn?start=run"), { screen: "turn", start: "run" });
  assert.deepEqual(parseRoute("#/turn?start=task"), { screen: "turn", start: "task" });
  assert.deepEqual(parseRoute("#/turn?start=run&proposal=4"), { screen: "turn", start: "run", proposal: 4 });
  assert.deepEqual(parseRoute("#/tasks/9?discard"), { screen: "task", id: 9, discard: true });
  assert.deepEqual(parseRoute("#/runs/3"), { screen: "run", id: 3 });
  assert.deepEqual(parseRoute("#/chats/5"), { screen: "chat", id: 5 });
  assert.deepEqual(parseRoute("#/settings/devices"), { screen: "settings", section: "devices" });
  assert.deepEqual(parseRoute("#/runs/new"), { screen: "redirect", to: "#/turn?start=run" });
  assert.deepEqual(parseRoute("#/runs/0"), { screen: "none", what: "/runs/0" });
});

test("Botbench opens on Home: the bare address and Home's own; Chat keeps its address, and Work takes a state from Home's links and nothing else", () => {
  for (const at of ["", "#", "#/", "#/home"]) assert.deepEqual(parseRoute(at), { screen: "home" }, at);
  assert.deepEqual(parseRoute("#/turn"), { screen: "turn", start: null });
  assert.deepEqual(parseRoute("#/work"), { screen: "work", state: null });
  for (const state of ["needs-you", "in-progress", "waiting", "completed", "failed", "ended"] as const) assert.deepEqual(parseRoute(`#/work?state=${state}`), { screen: "work", state });
  for (const at of ["#/work?state=any", "#/work?state=finished", "#/work?state=", "#/work?state=failed&kind=run", "#/work?q=x", "#/home/", "#/Home"]) assert.equal(parseRoute(at).screen, "none", at);
  // The sign-in address opened on a signed-in device goes to the first screen, which is Home.
  assert.deepEqual(parseRoute("#code=abc"), { screen: "redirect", to: "#/" });
});
