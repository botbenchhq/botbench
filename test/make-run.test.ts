import assert from "node:assert/strict";
import test from "node:test";
import * as server from "../src/engine/run-source.ts";
import { composerOpening, handOff, makeRun, MAX_RUN_NOTE, NOTE_EMPTY, noteTooLong, offersRun, sourceLabel, takeHandOff, type HandOff, type HandOffStorage } from "../web/src/app/run-source.ts";
import { parseRoute } from "../web/src/app/route.ts";

// "Make this a run" from a task's or a chat's screen to the composer, decided by plain functions (web/src/app/run-source.ts),
// without a browser: the address and what is handed over, the composer's opening state, and the hand-off itself.

const REPO = "/Users/owner/code/api";
const NOTE = "Now add a farewell file next to the greeting.";

test("Make this a run gives the composer's address and what it is handed, for a task ready for review, accepted or rejected, and for a chat", () => {
  for (const status of ["awaiting_decision", "accepted", "rejected"] as const) {
    // Only these offer it on the task's screen.
    assert.equal(offersRun(status), true, status);
    const made = makeRun({ kind: "task", id: 12, repo: REPO }, NOTE);
    assert.deepEqual(made, { address: "#/turn?start=run&from=task-12", handOff: { source: { kind: "task", id: 12 }, note: NOTE, repo: REPO } }, status);
    // A chat's repository is never a task's: a task's run opens in the task's own repository.
    assert.deepEqual(makeRun({ kind: "task", id: 12, repo: REPO }, NOTE, "/Users/owner/code/web"), made);
  }
  assert.equal(offersRun("building"), false);
  assert.deepEqual(makeRun({ kind: "chat", id: 5 }, NOTE, REPO), { address: "#/turn?start=run&from=chat-5", handOff: { source: { kind: "chat", id: 5 }, note: NOTE, repo: REPO } });
  assert.deepEqual(makeRun({ kind: "chat", id: 5 }, NOTE), { address: "#/turn?start=run&from=chat-5", handOff: { source: { kind: "chat", id: 5 }, note: NOTE, repo: null } });
  // The address it gives is one the shell opens on Plan a run with that source.
  const made = makeRun({ kind: "chat", id: 5 }, NOTE);
  assert.ok("address" in made);
  assert.deepEqual(parseRoute(made.address), { screen: "turn", start: "run", from: { kind: "chat", id: 5 } });
});

test("an empty, whitespace-only or over-long note is refused with the server's plain reason, and nothing is handed over", () => {
  const task = { kind: "task", id: 12, repo: REPO } as const;
  assert.deepEqual(makeRun(task, ""), { refused: NOTE_EMPTY });
  assert.deepEqual(makeRun(task, " \n\t  "), { refused: NOTE_EMPTY });
  assert.deepEqual(makeRun({ kind: "chat", id: 5 }, "   "), { refused: NOTE_EMPTY });
  const over = "x".repeat(MAX_RUN_NOTE + 1);
  assert.deepEqual(makeRun(task, over), { refused: noteTooLong(MAX_RUN_NOTE + 1) });
  assert.ok("address" in makeRun(task, "x".repeat(MAX_RUN_NOTE)), "exactly at the limit is a note");
  // The same words the server refuses with on Send.
  for (const note of ["", " \n\t  ", over]) assert.equal((makeRun(task, note) as { refused: string }).refused, server.noteProblem(note));
  assert.equal(NOTE_EMPTY, "The note is empty. Say in it what the run should do.");
});

test("the composer opens on Plan a run with the note, the task's repository or the chat's, and the line saying where it came from", () => {
  const fromTask: HandOff = { source: { kind: "task", id: 12 }, note: NOTE, repo: REPO };
  assert.deepEqual(composerOpening({ kind: "task", id: 12 }, fromTask), { kind: "run", prompt: NOTE, repo: REPO, source: { ref: { kind: "task", id: 12 }, label: "From task 12", repo: REPO } });

  const fromChat: HandOff = { source: { kind: "chat", id: 5 }, note: NOTE, repo: "/Users/owner/code/web" };
  // A chat has no repository of its own: the one handed over opens, and the run is not held to it.
  assert.deepEqual(composerOpening({ kind: "chat", id: 5 }, fromChat), { kind: "run", prompt: NOTE, repo: "/Users/owner/code/web", source: { ref: { kind: "chat", id: 5 }, label: "From a chat", repo: null } });
  assert.deepEqual(composerOpening({ kind: "chat", id: 5 }, { ...fromChat, repo: null }), { kind: "run", prompt: NOTE, repo: null, source: { ref: { kind: "chat", id: 5 }, label: "From a chat", repo: null } });

  // No hand-off (the address opened again, or typed): a plain composer, and no error.
  assert.equal(composerOpening({ kind: "task", id: 12 }, null), null);
  assert.equal(composerOpening({ kind: "chat", id: 5 }, null), null);
  // A hand-off for another source is not this one's.
  assert.equal(composerOpening({ kind: "task", id: 13 }, fromTask), null);
  assert.equal(composerOpening({ kind: "chat", id: 12 }, fromTask), null);
  assert.equal(composerOpening(null, fromTask), null);
  // The line is the server's own.
  assert.equal(sourceLabel({ kind: "task", id: 12 }), server.sourceLabel({ kind: "task", id: 12 }));
  assert.equal(sourceLabel({ kind: "chat", id: 5 }), server.sourceLabel({ kind: "chat", id: 5 }));
});

test("the note handed to the composer is taken exactly once, with storage refused; a second read gets nothing", () => {
  // Outside a browser there is no `window`: reaching the tab's storage throws, as it does where a browser refuses it.
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
  const given: HandOff = { source: { kind: "task", id: 12 }, note: NOTE, repo: REPO };
  handOff(given);
  assert.deepEqual(takeHandOff(), given);
  assert.equal(takeHandOff(), null);
  assert.equal(composerOpening({ kind: "task", id: 12 }, takeHandOff()), null, "opened again, the composer is a plain one");

  // Where the runtime has Web Storage (Node 25 on; the browser always), the same holds with storage that works, and the
  // note is in the tab's storage, so it outlives a reload, until it is taken.
  const tab = (globalThis as { sessionStorage?: HandOffStorage }).sessionStorage;
  if (tab !== undefined) {
    const storage = (): HandOffStorage => tab;
    handOff(given, storage);
    assert.notEqual(tab.getItem("botbench.runNote"), null);
    assert.deepEqual(takeHandOff(storage), given);
    assert.equal(tab.getItem("botbench.runNote"), null);
    assert.equal(takeHandOff(storage), null);

    // An older note left in the tab's storage (its newer write refused) never wins over the newer one held in this
    // page, and is removed with it.
    handOff(given);
    tab.setItem("botbench.runNote", JSON.stringify({ source: { kind: "task", id: 12 }, note: "An older note.", repo: REPO }));
    assert.deepEqual(takeHandOff(storage), given);
    assert.equal(tab.getItem("botbench.runNote"), null);
    assert.equal(takeHandOff(storage), null);
  }
});
