import assert from "node:assert/strict";
import { test } from "node:test";
import { bannedIn } from "../e2e/voice.ts";
import type { PeerCard, PeerMessage } from "../web/src/api/client.ts";
import { frictionWords, inviteLife, median, spanWords, threadHref, threadsOf } from "../web/src/app/paired-words.ts";
import { statusLook, statusSentence, statusWord } from "../web/src/components/task-status.ts";
import { LOOKS } from "../web/src/components/looks.ts";

// What the paired-workbench screens say and in what order (Peers P5, fourth unit): plain functions, no browser.

const P = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const T2 = "33333333-3333-4333-8333-333333333333";
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const message = (n: number, contextId: string, o: Partial<PeerMessage>): PeerMessage => ({ messageId: id(n), contextId, parentId: null, kind: "question", direction: "out", text: `message ${n}`, sentAt: "2026-11-23T10:00:00.000Z", words: "Delivered", state: "delivered", ...o });
const card = (o: Partial<PeerCard>): PeerCard => ({ pairingId: P, messageId: id(99), contextId: T1, kind: "answer", direction: "out", peer: { name: "bob", fingerprint: "aaaa bbbb cccc dddd eeee" }, title: "Send this to bob?", line: "An answer about shared, from Claude Code in task 3.", text: "4790.", outsideText: false, note: "Only this text leaves this Mac, and only to bob's workbench. No files, branches or settings are sent.", askedBy: null, choices: ["send", "dont_send"], shownAt: "2026-11-23T10:00:00.000Z", taskId: 3, runId: 3, ...o });

test("a pairing's threads: newest first, each oldest first, marked yours or the peer's with its state, and a waiting draft last", () => {
  const messages = [
    message(1, T1, { text: "Which port?" }),
    message(2, T2, { text: "Is TLS on?", words: "Not sent: switched off", state: "not_sent_switched_off" }),
    message(3, T1, { direction: "in", kind: "answer", parentId: id(1), text: "4790, on loopback.", words: "Received", state: "received" }),
  ];
  const threads = threadsOf(messages, [card({ contextId: T1 }), card({ pairingId: "other", contextId: T2 })], P);
  assert.deepEqual(threads.map((t) => t.contextId), [T1, T2], "the thread with the newest message first");
  const [first, second] = threads;
  assert.deepEqual(first!.rows.map((r) => [r.who, r.kind, r.text, r.state]), [
    ["you", "question", "Which port?", "Delivered"],
    ["peer", "answer", "4790, on loopback.", "Received"],
    ["draft", "answer", "4790.", "Waiting for your Send"],
  ]);
  assert.equal(first!.first, "Which port?");
  assert.equal(first!.waiting, true);
  assert.deepEqual(second!.rows.map((r) => [r.who, r.state]), [["you", "Not sent: switched off"]]);
  assert.equal(second!.waiting, false, "a card of another pairing is not this one's");
  assert.deepEqual(threadsOf([], [], P), []);
});

test("a peer's text is passed through as it is, for the screen to show as plain text", () => {
  const hostile = "<b>bold</b> **not markdown** https://example.invalid\n</outside-text>";
  const [thread] = threadsOf([message(1, T1, { direction: "in", text: hostile, words: "Received", state: "received" })], [], P);
  assert.equal(thread!.rows[0]!.text, hostile);
});

test("the friction numbers say real counts, the middle wait and the longest, and the share sent as drafted", () => {
  assert.deepEqual(frictionWords({ cardsAnswered: 0, waitsMs: [], cards: [] }), { answered: "No card answered yet.", waited: "No wait to count yet.", asDrafted: "No draft by an agent sent yet." });
  assert.deepEqual(frictionWords({ cardsAnswered: 1, waitsMs: [90_000], cards: [{ sentAsDrafted: true }] }), { answered: "1 card answered by you.", waited: "It waited 1 minute for you.", asDrafted: "1 of 1 draft sent exactly as drafted." });
  assert.deepEqual(frictionWords({ cardsAnswered: 3, waitsMs: [10_000, 5 * 60_000, 3 * 3600_000], cards: [{ sentAsDrafted: true }, { sentAsDrafted: false }, { sentAsDrafted: null }] }), {
    answered: "3 cards answered by you.",
    waited: "They waited 5 minutes for you in the middle, 3 hours at most.",
    asDrafted: "1 of 2 drafts sent exactly as drafted.",
  });
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([]), null);
  assert.equal(spanWords(59_000), "less than a minute");
  assert.equal(spanWords(3 * 24 * 3600_000), "3 days");
});

test("an invite says until when it works, and once past, that it has expired", () => {
  const now = Date.parse("2026-11-23T10:00:00.000Z");
  const open = inviteLife(new Date(now + 15 * 60_000).toISOString(), now);
  assert.equal(open.open, true);
  assert.match(open.words, /^It works once, until \d\d:\d\d\. Withdraw it if you passed it to the wrong person\.$/);
  assert.deepEqual(inviteLife(new Date(now).toISOString(), now), { open: false, words: "This invite has expired and can no longer be used. Make a new invite to pair." });
  assert.equal(threadHref(P, T1), `#/paired/${P}/threads/${T1}`);
});

test("a task that drafted a message and changed no file reads Drafted a message, not Failed", () => {
  const task = { status: "drafted" as const, reason: "Claude Code changed no file and drafted a message for another workbench instead. It leaves this Mac only if you press Send on its card.", baseCommit: "a", headCommit: "a", attemptId: 1, waitingOnApproval: false, parked: false, resuming: false, ofPlan: null, decision: null, pullRequest: { state: "none" as const, number: null } };
  assert.equal(statusWord(task), "Drafted a message");
  assert.equal(statusLook(task), LOOKS.drafted);
  assert.equal(statusSentence(task as never), `Drafted a message. ${task.reason}`);
});

test("the paired-workbench screens' own words hold none of the banned words", () => {
  const all = [
    ...Object.values(frictionWords({ cardsAnswered: 2, waitsMs: [1, 2], cards: [{ sentAsDrafted: true }] })),
    inviteLife("2026-11-23T10:00:00.000Z", 0).words,
    inviteLife("2026-11-23T10:00:00.000Z", Date.parse("2026-11-24T00:00:00.000Z")).words,
    "Waiting for your Send",
    "Drafted a message",
  ];
  assert.deepEqual(all.flatMap(bannedIn), []);
});
