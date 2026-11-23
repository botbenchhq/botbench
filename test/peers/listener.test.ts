import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { openStore } from "../../src/store/db.ts";
import { newId, signEnvelope, verifyEnvelope, type Envelope } from "../../src/peers/envelope.ts";
import { workbenchKey, type WorkbenchKey } from "../../src/peers/key.ts";
import { NOT_TAKEN, PAIR_REQUESTS_PER_INVITE, PAIR_REQUESTS_PER_MINUTE } from "../../src/peers/listener.ts";
import { proveRequest, readInvite, readPairAnswer, type Invite, type WirePairRequest } from "../../src/peers/pair-wire.ts";
import { newPairingKey } from "../../src/peers/pairings.ts";
import { startServer } from "../../src/server.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The peer listener of one real Botbench (in this process), over real HTTP on loopback with an ephemeral port, with
// the real store. The other workbench is played by this test with its own real key and store, sending the bytes a
// joining Botbench sends; the two-installation test (two-workbenches.test.ts) runs both sides as processes.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Alice {
  base: string;
  peer: string;
  cookie: string;
  home: string;
  repo: string;
  db: DatabaseSync;
}

async function alice(t: T, inviteLifeMs?: number): Promise<Alice> {
  const dir = tempDir("botbench-listener-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "remote.git");
  git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  const repo = path.join(dir, "alice-repo");
  initRepo(repo);
  git(repo, "remote", "add", "origin", remote);
  const home = path.join(dir, "home");
  const server = await startServer({ config: { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, workbench: "alice", peers: { listen: { address: "127.0.0.1", port: 0 } } }, home, signInDelayMs: 1, ...(inviteLifeMs === undefined ? {} : { peerInviteLifeMs: inviteLifeMs }) });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const signedIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token: fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim() }) });
  assert.equal(signedIn.status, 200);
  return { base, peer: `http://${server.peerAddress}`, cookie: signedIn.headers.get("set-cookie")!.split(";")[0]!, home, repo, db: server.db };
}

async function owner(a: Alice, method: string, route: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${a.base}${route}`, { method, headers: { ...JSON_TYPE, cookie: a.cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function invite(a: Alice): Promise<{ id: string; text: string; invite: Invite }> {
  const made = await owner(a, "POST", "/api/peers/invites", { repo: a.repo });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const read = readInvite(made.body.invite);
  assert.ok(!("problem" in read));
  return { id: made.body.id, text: made.body.invite, invite: read };
}

async function post(url: string, body: unknown, headers: Record<string, string> = JSON_TYPE): Promise<{ status: number; text: string; body: any; setCookie: string | null }> {
  const res = await fetch(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body: parsed, setCookie: res.headers.get("set-cookie") };
}

/** The other workbench, with its own real key and store. */
function bob(t: T): { key: WorkbenchKey; request: (i: Invite, pairingKey?: string) => WirePairRequest } {
  const home = tempDir("botbench-listener-bob-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = openStore(home);
  t.after(() => db.close());
  const key = workbenchKey(home);
  return { key, request: (i, pairingKey = newPairingKey()) => proveRequest({ inviteId: i.id, pairingKey, key: key.publicKey, name: "bob", address: "127.0.0.1:9", repository: i.repository }, i.secret) };
}

const sign = (key: WorkbenchKey, e: Partial<Envelope> & Pick<Envelope, "pairingId" | "kind" | "recipientKey" | "repository">) =>
  signEnvelope({ messageId: newId(), contextId: null, parentId: null, senderKey: key.publicKey, sequence: 1, time: new Date().toISOString(), body: "", ...e }, key);

const rows = (a: Alice, sql: string, ...args: (string | number)[]) => a.db.prepare(sql).all(...args);

test("the peer listener has its four routes and nothing else: no owner route through it, no peer route through the owner's port", async (t) => {
  const a = await alice(t);
  for (const [method, route] of [["GET", "/api/peers/pairings"], ["GET", "/health"], ["POST", "/api/sign-in"], ["GET", "/"], ["GET", "/index.html"], ["POST", "/peer/other"], ["GET", "/peer/message"], ["PUT", "/peer/pair"], ["POST", "/peer/pair/"], ["POST", "/peer/message?x=1"], ["POST", "//peer/message"]] as const) {
    const res = await fetch(`${a.peer}${route}`, { method, headers: { ...JSON_TYPE, cookie: a.cookie }, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(res.status, 404, `${method} ${route} on the peer port`);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  // The owner's session and login token count for nothing on the peer port: the answer is the stranger's refusal.
  const token = fs.readFileSync(path.join(a.home, LOGIN_TOKEN_FILE), "utf8").trim();
  const withSession = await post(`${a.peer}/peer/message`, { envelope: {}, signature: "" }, { ...JSON_TYPE, cookie: a.cookie, authorization: `Bearer ${token}` });
  assert.equal(withSession.status, 403);
  assert.deepEqual(withSession.body, NOT_TAKEN);
  for (const route of ["pair", "message", "settings", "end"]) {
    const res = await fetch(`${a.base}/peer/${route}`, { method: "POST", headers: { ...JSON_TYPE, cookie: a.cookie }, body: "{}" });
    assert.equal(res.status, 404, `/peer/${route} on the owner's port`);
  }
});

test("a request is JSON of at most 64 KB from no browser page, and malformed input is refused, never thrown", async (t) => {
  const a = await alice(t);
  const big = await post(`${a.peer}/peer/message`, JSON.stringify({ pad: "x".repeat(64 * 1024) }));
  assert.equal(big.status, 413);
  const exactly = JSON.stringify({ envelope: {}, signature: "x".repeat(64 * 1024 - 30) });
  assert.equal(Buffer.byteLength(exactly) <= 64 * 1024, true);
  assert.equal((await post(`${a.peer}/peer/message`, exactly)).status, 403, "64 KB is read and refused for what it is");
  assert.equal((await post(`${a.peer}/peer/message`, "{not json")).status, 400);
  assert.equal((await post(`${a.peer}/peer/message`, "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(`${a.peer}/peer/message`, { envelope: {}, signature: "" }, { ...JSON_TYPE, origin: "http://evil.example" })).status, 403);
  for (const body of ["null", "[]", "1", '"x"', "{}", '{"envelope":null,"signature":null}', '{"envelope":{"pairingId":1},"signature":[]}', JSON.stringify({ envelope: Object.fromEntries("pairingId kind messageId contextId parentId repository senderKey recipientKey sequence time body".split(" ").map((k) => [k, "\uD800"])), signature: "a" })]) {
    for (const route of ["pair", "message", "settings", "end"]) {
      const res = await post(`${a.peer}/peer/${route}`, body);
      assert.equal(res.status, 403, `${route} ${body}`);
      assert.deepEqual(res.body, NOT_TAKEN);
    }
  }
  // Still answering after all of it.
  assert.equal((await post(`${a.peer}/peer/end`, "{}")).status, 403);
});

test("a sender that sends nothing, or stops halfway through its headers, is cut off at the listener's time limit", async (t) => {
  const a = await alice(t);
  const { port } = new URL(a.peer);
  const socket = net.connect(Number(port), "127.0.0.1");
  await once(socket, "connect");
  let answer = "";
  socket.setEncoding("utf8").on("data", (chunk: string) => (answer += chunk));
  socket.write("POST /peer/pair HTTP/1.1\r\nHost: x\r\n");
  const began = Date.now();
  await once(socket, "close");
  assert.match(answer, /^HTTP\/1\.1 408/);
  const waited = Date.now() - began;
  assert.ok(waited < 9000, `cut off after ${waited} ms`);
});

test("callers with no pairing, the wrong key or no proof get one and the same refusal, and the log keeps one row a minute with the count", async (t) => {
  const a = await alice(t);
  const b = bob(t);
  const i = await invite(a);
  // A real pairing, so that a known pairing id signed with the wrong key can be tried too.
  const paired = await post(`${a.peer}/peer/pair`, b.request(i.invite));
  assert.equal(paired.status, 200, paired.text);
  const pairingId = paired.body.answer.pairingId as string;
  const aliceKey = paired.body.answer.inviterKey as string;
  const eve = bob(t);
  const tries = [
    { envelope: {}, signature: "" },
    sign(b.key, { pairingId: newId(), kind: "end_notice", recipientKey: aliceKey, repository: i.invite.repository }),
    sign(eve.key, { pairingId, kind: "end_notice", recipientKey: aliceKey, repository: i.invite.repository }),
    { ...sign(b.key, { pairingId, kind: "end_notice", recipientKey: aliceKey, repository: i.invite.repository }), signature: "A".repeat(86) },
  ];
  const answers = await Promise.all(tries.map((body) => post(`${a.peer}/peer/end`, body)));
  for (const answer of answers) {
    assert.equal(answer.status, 403);
    assert.equal(answer.text, answers[0]!.text, "the same bytes whatever the reason");
  }
  assert.equal(rows(a, "SELECT 1 FROM peer_pairing_ends").length, 0, "nothing ended");
  const refused = rows(a, "SELECT * FROM action_log WHERE rule = 'peer_refused'");
  assert.equal(refused.length, 1, "one row in the minute");
  assert.equal(refused[0]!.asked_by, "owner");
  assert.match(String(refused[0]!.detail), /^Refused a request from a caller at .* with no pairing here/);
});

test("pair requests: a wrong HMAC, an unknown, withdrawn or used invite, and a replay after the end all get the same refusal; a retry gets the same answer and one pairing", async (t) => {
  const a = await alice(t);
  const b = bob(t);
  const i = await invite(a);
  const request = b.request(i.invite);
  const refusals: string[] = [];
  refusals.push((await post(`${a.peer}/peer/pair`, { ...request, hmac: b.request({ ...i.invite, secret: Buffer.alloc(32, 7) }, request.pairingKey).hmac })).text);
  refusals.push((await post(`${a.peer}/peer/pair`, b.request({ ...i.invite, id: newId() }))).text);
  const first = await post(`${a.peer}/peer/pair`, request);
  assert.equal(first.status, 200, first.text);
  for (let n = 0; n < 2; n++) {
    const again = await post(`${a.peer}/peer/pair`, request);
    assert.equal(again.text, first.text, "the same answer, byte for byte");
  }
  assert.equal(rows(a, "SELECT 1 FROM peer_pairings").length, 1, "one pairing");
  assert.ok(readPairAnswer(first.body, request), "signed by the key it names, for this request");
  // Another pairing key on the used invite.
  refusals.push((await post(`${a.peer}/peer/pair`, b.request(i.invite))).text);
  // A withdrawn invite.
  const other = await invite(a);
  assert.equal((await owner(a, "POST", `/api/peers/invites/${other.id}/withdraw`, {})).status, 200);
  refusals.push((await post(`${a.peer}/peer/pair`, b.request(other.invite))).text);
  // The pairing ends; the same request again gets no answer for it.
  assert.equal((await owner(a, "POST", `/api/peers/pairings/${first.body.answer.pairingId}/refuse`, {})).status, 200);
  refusals.push((await post(`${a.peer}/peer/pair`, request)).text);
  assert.equal(refusals.length, 5);
  for (const text of refusals) assert.equal(text, JSON.stringify(NOT_TAKEN));
  // The invite's secret is in no column once used or withdrawn.
  assert.equal(rows(a, "SELECT 1 FROM peer_invites WHERE secret IS NOT NULL").length, 0);
  const log = rows(a, "SELECT rule, command, asked_by FROM action_log WHERE rule LIKE 'peer_%' ORDER BY id").map((r) => `${r.rule} ${r.command} ${r.asked_by}`);
  assert.deepEqual(log.filter((l) => !l.startsWith("peer_refused")), [
    "peer_invite invite made owner",
    "peer_pairing pair request accepted peer",
    "peer_protocol pair answer sent peer",
    "peer_protocol pair answer sent again peer",
    "peer_protocol pair answer sent again peer",
    "peer_invite invite made owner",
    "peer_invite invite withdrawn owner",
    "peer_pairing fingerprint refused owner",
    "peer_protocol end notice sent owner",
  ]);
  for (const row of rows(a, "SELECT command, detail FROM action_log")) {
    assert.ok(!String(row.detail).includes(i.invite.secret.toString("base64url")) && !String(row.detail).includes(i.text), "no secret, no invite text in the log");
  }
});

test("pair requests are bounded per invite and per caller", async (t) => {
  const a = await alice(t);
  const b = bob(t);
  const i = await invite(a);
  const wrong = { ...i.invite, secret: Buffer.alloc(32, 1) };
  for (let n = 0; n < PAIR_REQUESTS_PER_INVITE; n++) assert.equal((await post(`${a.peer}/peer/pair`, b.request(wrong))).status, 403);
  assert.equal((await post(`${a.peer}/peer/pair`, b.request(i.invite))).status, 429, "past the bound even with the right secret");
  assert.equal(rows(a, "SELECT 1 FROM peer_pairings").length, 0);
  for (let n = PAIR_REQUESTS_PER_INVITE + 1; n < PAIR_REQUESTS_PER_MINUTE; n++) await post(`${a.peer}/peer/pair`, b.request({ ...i.invite, id: newId() }));
  assert.equal((await post(`${a.peer}/peer/pair`, b.request({ ...i.invite, id: newId() }))).status, 429, "past the bound per caller");
});

test("an expired invite is swept with its secret erased and its row in the log, and is refused like any other", async (t) => {
  const a = await alice(t, 300);
  const b = bob(t);
  const i = await invite(a);
  await new Promise((resolve) => setTimeout(resolve, 400));
  // The sweep runs every minute and at start; reading the pairings runs it too.
  assert.equal((await owner(a, "GET", "/api/peers/pairings")).body.invites.length, 0);
  assert.equal(rows(a, "SELECT state FROM peer_invites WHERE id = ? AND secret IS NULL", i.id)[0]?.state, "expired");
  assert.equal(rows(a, "SELECT 1 FROM action_log WHERE rule = 'peer_invite' AND command = 'invite expired'").length, 1);
  const refused = await post(`${a.peer}/peer/pair`, b.request(i.invite));
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, NOT_TAKEN);
});

test("in force, a question or an answer gets a signed refusal for now, an envelope on another kind's route too, and nothing is stored", async (t) => {
  const a = await alice(t);
  const b = bob(t);
  const i = await invite(a);
  const paired = await post(`${a.peer}/peer/pair`, b.request(i.invite));
  const { pairingId, inviterKey } = paired.body.answer as { pairingId: string; inviterKey: string };
  assert.equal((await owner(a, "POST", `/api/peers/pairings/${pairingId}/confirm`, {})).status, 200);
  const base = { pairingId, recipientKey: inviterKey, repository: i.invite.repository };
  const sends = [
    ["message", sign(b.key, { ...base, kind: "question", contextId: newId(), body: "Which port?" })],
    ["message", sign(b.key, { ...base, kind: "end_notice" })],
    ["end", sign(b.key, { ...base, kind: "settings_notice", body: "question:on,answer:on" })],
    ["settings", sign(b.key, { ...base, kind: "pair_confirmation" })],
  ] as const;
  for (const [route, envelope] of sends) {
    const res = await post(`${a.peer}/peer/${route}`, envelope);
    assert.equal(res.status, 409, `${envelope.envelope.kind} on ${route}`);
    assert.equal(res.body.response.envelope.body, "kind_not_taken");
    assert.equal(res.body.response.envelope.parentId, envelope.envelope.messageId);
    assert.ok(verifyEnvelope(res.body.response.envelope, res.body.response.signature, inviterKey), "signed with alice's key");
  }
  assert.equal(rows(a, "SELECT 1 FROM peer_messages WHERE direction = 'in'").length, 0);
  assert.equal(rows(a, "SELECT 1 FROM peer_pairing_ends").length, 0);
});

test("after End pairing, a later message for the pairing gets a refusal naming the end, signed with this side's key", async (t) => {
  const a = await alice(t);
  const b = bob(t);
  const i = await invite(a);
  const paired = await post(`${a.peer}/peer/pair`, b.request(i.invite));
  const { pairingId, inviterKey } = paired.body.answer as { pairingId: string; inviterKey: string };
  assert.equal((await owner(a, "POST", `/api/peers/pairings/${pairingId}/confirm`, {})).status, 200);
  const ended = await owner(a, "POST", `/api/peers/pairings/${pairingId}/end`, {});
  assert.equal(ended.body.pairing.state, "ended");
  assert.equal((await owner(a, "POST", `/api/peers/pairings/${pairingId}/end`, {})).status, 409, "an ended pairing ends once");
  const later = sign(b.key, { pairingId, recipientKey: inviterKey, repository: i.invite.repository, kind: "settings_notice", body: "question:on,answer:on" });
  const res = await post(`${a.peer}/peer/settings`, later);
  assert.equal(res.status, 409);
  assert.equal(res.body.response.envelope.body, "pairing_ended");
  assert.equal(res.body.response.envelope.pairingId, pairingId);
  assert.equal(res.body.response.envelope.parentId, later.envelope.messageId);
  assert.ok(verifyEnvelope(res.body.response.envelope, res.body.response.signature, inviterKey));
  // Confirming or refusing an ended pairing changes nothing.
  assert.equal((await owner(a, "POST", `/api/peers/pairings/${pairingId}/confirm`, {})).status, 409);
});

test("a pair request is answered only for the address it came from, and ids of no invite do not use up a real invite's count", async (t) => {
  const a = await alice(t);
  const b = bob(t);
  const i = await invite(a);
  const elsewhere = proveRequest({ ...b.request(i.invite), address: "10.0.0.5:4780" }, i.invite.secret);
  assert.deepEqual((await post(`${a.peer}/peer/pair`, elsewhere)).body, NOT_TAKEN, "it would point alice at another service");
  for (let n = 0; n < PAIR_REQUESTS_PER_INVITE + 2; n++) assert.equal((await post(`${a.peer}/peer/pair`, b.request({ ...i.invite, id: newId() }))).status, 403);
  assert.equal((await post(`${a.peer}/peer/pair`, b.request(i.invite))).status, 200);
});

test("replayed protocol traffic changes nothing twice, and a notice signed for another pairing changes nothing", async (t) => {
  const a = await alice(t);
  const b = bob(t);
  const i = await invite(a);
  const paired = await post(`${a.peer}/peer/pair`, b.request(i.invite));
  const { pairingId, inviterKey } = paired.body.answer as { pairingId: string; inviterKey: string };
  assert.equal((await owner(a, "POST", `/api/peers/pairings/${pairingId}/confirm`, {})).status, 200);
  const base = { pairingId, recipientKey: inviterKey, repository: i.invite.repository };
  const notice = sign(b.key, { ...base, kind: "settings_notice", body: "question:off,answer:on" });
  const first = await post(`${a.peer}/peer/settings`, notice);
  assert.equal(first.status, 200, first.text);
  assert.equal((await post(`${a.peer}/peer/settings`, notice)).text, first.text, "the same acknowledgement");
  assert.equal(rows(a, "SELECT 1 FROM peer_messages WHERE direction = 'in' AND kind = 'settings_notice'").length, 1);
  assert.equal(rows(a, "SELECT 1 FROM peer_kind_settings WHERE side = 'peer' AND set_by = 'peer_notice'").length, 2, "applied once");
  // An end notice for another pairing id, though signed by bob's key, is refused: a key counts only with its pairing.
  assert.deepEqual((await post(`${a.peer}/peer/end`, sign(b.key, { ...base, pairingId: newId(), kind: "end_notice", sequence: 2 }))).body, NOT_TAKEN);
  const end = sign(b.key, { ...base, kind: "end_notice", sequence: 2 });
  assert.equal((await post(`${a.peer}/peer/end`, end)).status, 200);
  const again = await post(`${a.peer}/peer/end`, end);
  assert.equal(again.status, 409);
  assert.equal(again.body.response.envelope.body, "pairing_ended");
  assert.equal(rows(a, "SELECT 1 FROM peer_pairing_ends").length, 1, "one end");
  assert.equal(rows(a, "SELECT 1 FROM action_log WHERE command = 'ended by the peer''s notice'").length, 1);
});
