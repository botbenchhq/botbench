import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { DB_FILE } from "../../src/store/db.ts";
import { workbenchKey } from "../../src/peers/key.ts";
import { INVITE_PREFIX, proveRequest, readInvite } from "../../src/peers/pair-wire.ts";
import { newPairingKey } from "../../src/peers/pairings.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// Two Botbench installations on this Mac (ADR 0004 decision 13): two real processes, each with its own data folder,
// owner port and peer listener on 127.0.0.1 at ports the system chose, and one temporary git repository with a bare
// remote both copies use. Nothing is faked: the pairing goes over real HTTP between the two processes, and the
// restarts are real stops and starts of a process with its store on disk.

const ENTRY = fileURLToPath(new URL("../support/peer-botbench.ts", import.meta.url));
const JSON_TYPE = { "content-type": "application/json" };

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  await once(probe, "close");
  return port;
}

interface Workbench {
  name: string;
  home: string;
  repo: string;
  peerAddress: string;
  /** Everything every start of this installation wrote, stdout and stderr. */
  output: () => string;
  start(inviteLifeMs?: number): Promise<void>;
  stop(): Promise<void>;
  api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }>;
}

async function workbench(t: { after(fn: () => unknown): void }, dir: string, name: string, repo: string): Promise<Workbench> {
  const home = path.join(dir, `${name}-home`);
  const [ownerPort, peerPort] = [await freePort(), await freePort()];
  const settings = path.join(dir, `${name}.local.json`);
  fs.writeFileSync(settings, JSON.stringify({ port: ownerPort, listen: ["127.0.0.1"], workbench: name, peers: { listen: { address: "127.0.0.1", port: peerPort } } }));
  let child: ChildProcess | null = null;
  let output = "";
  let cookie = "";
  t.after(() => void child?.kill("SIGKILL"));
  const w: Workbench = {
    name,
    home,
    repo,
    peerAddress: `127.0.0.1:${peerPort}`,
    output: () => output,
    async start(inviteLifeMs) {
      const proc = spawn(process.execPath, [ENTRY, JSON.stringify({ home, settings, ...(inviteLifeMs === undefined ? {} : { inviteLifeMs }) })], { stdio: ["ignore", "pipe", "pipe"] });
      child = proc;
      const exited = once(proc, "exit");
      proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
      let mine = "";
      await new Promise<void>((resolve, reject) => {
        proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          mine += chunk;
          if (mine.includes("ready ")) resolve();
        });
        void exited.then(() => reject(new Error(`${name} exited before it was ready: ${output}`)));
      });
      const signedIn = await fetch(`http://127.0.0.1:${ownerPort}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token: fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim() }) });
      assert.equal(signedIn.status, 200);
      cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    },
    async stop() {
      const proc = child;
      if (proc === null) return;
      child = null;
      const exited = once(proc, "exit");
      proc.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 0, `${name} stopped cleanly: ${output}`);
    },
    async api(method, route, body) {
      const res = await fetch(`http://127.0.0.1:${ownerPort}${route}`, { method, headers: { ...JSON_TYPE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() };
    },
  };
  return w;
}

async function until<T>(what: string, check: () => Promise<T | undefined | null | false>, ms = 45_000): Promise<T> {
  const began = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - began > ms) throw new Error(`Gave up waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const pairingsOf = async (w: Workbench): Promise<any[]> => (await w.api("GET", "/api/peers/pairings")).body.pairings;
const live = async (w: Workbench): Promise<any> => (await pairingsOf(w)).find((p) => p.state !== "ended");
const pairingOf = async (w: Workbench, id: string): Promise<any> => (await pairingsOf(w)).find((p) => p.id === id);
const logOf = async (w: Workbench): Promise<{ rule: string; command: string; detail: string }[]> => (await w.api("GET", "/api/action-log?limit=200")).body.entries;

test("two workbenches pair over their listeners, and every way it can go wrong or end is held", { timeout: 300_000 }, async (t) => {
  const dir = tempDir("botbench-two-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "shared.git");
  git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  const aliceRepo = path.join(dir, "alice-copy");
  initRepo(aliceRepo);
  git(aliceRepo, "remote", "add", "origin", remote);
  git(aliceRepo, "push", "--quiet", "origin", "main");
  const bobRepo = path.join(dir, "bob-copy");
  git(dir, "clone", "--quiet", remote, bobRepo);
  const otherRepo = path.join(dir, "other-copy");
  initRepo(otherRepo);
  git(otherRepo, "remote", "add", "origin", path.join(dir, "elsewhere.git"));

  const alice = await workbench(t, dir, "alice", aliceRepo);
  const bob = await workbench(t, dir, "bob", bobRepo);
  const invites: string[] = [];
  const makeInvite = async (): Promise<string> => {
    const made = await alice.api("POST", "/api/peers/invites", { repo: alice.repo });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.match(made.body.invite, /^botbench-invite-1\.[A-Za-z0-9_-]+$/, "one line, safe to paste");
    invites.push(made.body.invite);
    return made.body.invite;
  };
  const paste = (invite: string, repo = bob.repo) => bob.api("POST", "/api/peers/joins", { invite, repo });

  // ---- An expired invite: Botbench sweeps it on its own, and the joining side refuses it before sending anything.
  await alice.start(1500);
  await bob.start();
  const expiring = await makeInvite();
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await until("the expired invite to be swept", async () => (await logOf(alice)).some((e) => e.rule === "peer_invite" && e.command === "invite expired"), 70_000);
  const late = await paste(expiring);
  assert.equal(late.status, 410);
  assert.match(late.body.error, /^This invite expired at .*\. Ask alice for a new one\.$/);
  await alice.stop();
  await alice.start();

  // ---- The joining side checks its own copy is of the invite's repository.
  const wrongCopy = await paste(await makeInvite(), otherRepo);
  assert.equal(wrongCopy.status, 400);
  assert.match(wrongCopy.body.error, /^This invite is for .*shared\.git, and the copy you chose is of .*elsewhere\.git/);
  const unused = readInvite(invites.at(-1)!);
  assert.ok(!("problem" in unused));
  assert.equal((await alice.api("POST", `/api/peers/invites/${unused.id}/withdraw`, {})).status, 200);

  // ---- A withdrawn invite: pasted fine (bob cannot know), refused by alice when bob confirms.
  const withdrawn = await makeInvite();
  const open = (await alice.api("GET", "/api/peers/pairings")).body.invites.find((i: any) => readInvite(withdrawn) && i.id === (readInvite(withdrawn) as any).id);
  assert.equal((await alice.api("POST", `/api/peers/invites/${open.id}/withdraw`, {})).status, 200);
  const pastedWithdrawn = await paste(withdrawn);
  assert.equal(pastedWithdrawn.status, 200, JSON.stringify(pastedWithdrawn.body));
  const refusedWithdrawn = await bob.api("POST", `/api/peers/joins/${pastedWithdrawn.body.join.id}/confirm`, {});
  assert.equal(refusedWithdrawn.status, 409);
  assert.match(refusedWithdrawn.body.error, /^alice's workbench did not take the invite\. It may have expired, been withdrawn or been used already\./);
  assert.equal((await pairingsOf(bob)).length, 0);

  // ---- A retried pair request: the same request three times (a joining workbench whose answer was lost) gets the
  // same answer each time and makes one pairing; another pairing key on that used invite is refused.
  const retried = readInvite(await makeInvite());
  assert.ok(!("problem" in retried));
  const bobKey = workbenchKey(bob.home);
  const request = proveRequest({ inviteId: retried.id, pairingKey: newPairingKey(), key: bobKey.publicKey, name: "bob", address: bob.peerAddress, repository: retried.repository }, retried.secret);
  const answers = await Promise.all([0, 1, 2].map(() => fetch(`http://${alice.peerAddress}/peer/pair`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify(request) }).then((r) => r.text())));
  assert.equal(new Set(answers).size, 1, "the same answer");
  assert.ok(JSON.parse(answers[0]!).answer.pairingId);
  assert.equal((await pairingsOf(alice)).filter((p) => p.state !== "ended").length, 1, "one pairing");
  const otherKey = await fetch(`http://${alice.peerAddress}/peer/pair`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify(proveRequest({ ...request, pairingKey: newPairingKey() }, retried.secret)) });
  assert.equal(otherKey.status, 403);
  // Bob's own Botbench, pasting the used invite, gets the same refusal.
  const pastedUsed = await paste(invites.at(-1)!);
  const refusedUsed = await bob.api("POST", `/api/peers/joins/${pastedUsed.body.join.id}/confirm`, {});
  assert.equal(refusedUsed.status, 409);
  const fromRetry = await live(alice);
  assert.equal((await alice.api("POST", `/api/peers/pairings/${fromRetry.id}/refuse`, {})).status, 200);

  // ---- A wrong fingerprint: the invite says one key, and a listener answers with another. Bob makes no pairing.
  const real = await makeInvite();
  const fields = JSON.parse(Buffer.from(real.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));
  const forged = INVITE_PREFIX + Buffer.from(JSON.stringify({ ...fields, fingerprint: "0000 1111 2222 3333 4444" })).toString("base64url");
  invites.push(forged);
  const pastedForged = await paste(forged);
  assert.equal(pastedForged.body.join.fingerprint, "0000 1111 2222 3333 4444", "the owner sees the invite's fingerprint");
  const refusedForged = await bob.api("POST", `/api/peers/joins/${pastedForged.body.join.id}/confirm`, {});
  assert.equal(refusedForged.status, 409);
  const aliceFingerprint = (await alice.api("GET", "/api/peers/pairings")).body.fingerprint;
  assert.equal(refusedForged.body.error, `The workbench that answered at ${alice.peerAddress} is not the one in the invite: its fingerprint is ${aliceFingerprint}, and the invite's is 0000 1111 2222 3333 4444. Nothing was paired, and nothing more is sent to it.`);
  assert.equal((await pairingsOf(bob)).length, 0);
  const fromForged = await live(alice);
  assert.equal((await alice.api("POST", `/api/peers/pairings/${fromForged.id}/refuse`, {})).status, 200);

  // ---- The pairing itself: invite, paste, both owners confirm; alice's confirmation survives a restart of each side.
  const good = await makeInvite();
  const pasted = await paste(good);
  assert.equal(pasted.status, 200);
  const bobFingerprint = pasted.body.join.ownFingerprint;
  assert.deepEqual({ name: pasted.body.join.name, fingerprint: pasted.body.join.fingerprint, repository: pasted.body.join.repository }, { name: "alice", fingerprint: aliceFingerprint, repository: remote });
  const joined = await bob.api("POST", `/api/peers/joins/${pasted.body.join.id}/confirm`, {});
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.pairing.state, "waiting_for_peer");
  assert.equal(joined.body.pairing.words, "Waiting for alice to confirm");
  const id = joined.body.pairing.id;
  const atAlice = await pairingOf(alice, id);
  assert.equal(atAlice.state, "waiting_for_owner");
  assert.equal(atAlice.peer.fingerprint, bobFingerprint, "alice sees bob's fingerprint as bob's screen shows it");
  assert.equal(joined.body.pairing.peer.fingerprint, aliceFingerprint);
  // Bob is stopped before alice's owner confirms, and alice is restarted with her confirmation not yet delivered.
  await bob.stop();
  const confirmed = await alice.api("POST", `/api/peers/pairings/${id}/confirm`, {});
  assert.equal(confirmed.body.pairing.state, "in_force");
  assert.equal(confirmed.body.pairing.words, "Paired. Sending your confirmation to bob's workbench");
  await alice.stop();
  await alice.start();
  await bob.start();
  await until("bob to hold alice's confirmation", async () => (await pairingOf(bob, id))?.state === "in_force");
  await until("alice to see it acknowledged", async () => (await pairingOf(alice, id))?.words === "Paired");
  await until("each side's settings notice to be taken", async () => (await logOf(alice)).some((e) => e.command === "settings notice received") && (await logOf(bob)).some((e) => e.command === "settings notice received"));
  // A retried confirm press on the joining side makes nothing new.
  assert.equal((await bob.api("POST", `/api/peers/joins/${pasted.body.join.id}/confirm`, {})).status, 404);

  // ---- End pairing from alice's side, with bob listening: the notice arrives and bob ends too.
  const endedByAlice = await alice.api("POST", `/api/peers/pairings/${id}/end`, {});
  assert.equal(endedByAlice.body.pairing.state, "ended", "at once on this side");
  await until("bob to record the end notice", async () => (await pairingOf(bob, id))?.state === "ended");
  assert.ok((await logOf(bob)).some((e) => e.rule === "peer_pairing" && e.command === "ended by the peer's notice"));

  // ---- End pairing from bob's side with the notice lost: alice is stopped, so her next send gets bob's signed refusal.
  const second = await paste(await makeInvite());
  const secondJoined = await bob.api("POST", `/api/peers/joins/${second.body.join.id}/confirm`, {});
  const secondId = secondJoined.body.pairing.id;
  assert.notEqual(secondId, id, "a new invite makes a new pairing, with a new id");
  await bob.stop();
  assert.equal((await alice.api("POST", `/api/peers/pairings/${secondId}/confirm`, {})).status, 200);
  await alice.stop();
  await bob.start();
  const endedByBob = await bob.api("POST", `/api/peers/pairings/${secondId}/end`, {});
  assert.equal(endedByBob.body.pairing.state, "ended");
  await until("bob's one try at the end notice", async () => bob.output().includes("The end notice to alice's workbench"));
  await alice.start();
  await until("alice to record the end from bob's signed refusal", async () => (await pairingOf(alice, secondId))?.state === "ended");
  assert.ok((await logOf(alice)).some((e) => e.rule === "peer_pairing" && e.command === "ended by the peer's refusal"));
  // The first pairing stays ended: it never restarts.
  assert.equal((await pairingOf(alice, id)).state, "ended");
  assert.equal((await pairingOf(bob, id)).state, "ended");

  await alice.stop();
  await bob.stop();

  // ---- What the stores hold, read once both processes have stopped.
  const aliceDb = new DatabaseSync(path.join(alice.home, DB_FILE), { readOnly: true });
  t.after(() => aliceDb.close());
  const bobDb = new DatabaseSync(path.join(bob.home, DB_FILE), { readOnly: true });
  t.after(() => bobDb.close());
  assert.equal(aliceDb.prepare("SELECT how FROM peer_pairing_ends WHERE pairing_id = ?").get(secondId)?.how, "pairing_ended_refusal");
  assert.equal(bobDb.prepare("SELECT how FROM peer_pairing_ends WHERE pairing_id = ?").get(id)?.how, "end_notice");
  assert.equal(aliceDb.prepare("SELECT count(*) AS n FROM peer_messages WHERE pairing_id = ? AND direction = 'out' AND kind = 'pair_confirmation'").get(id)!.n, 1, "one confirmation, retried as the same message");
  assert.equal(aliceDb.prepare("SELECT 1 FROM peer_invites WHERE secret IS NOT NULL").all().length, 0, "no secret kept");
  const steps = aliceDb.prepare("SELECT command FROM action_log WHERE rule IN ('peer_invite', 'peer_pairing') ORDER BY id").all().map((r) => r.command);
  for (const step of ["invite made", "invite expired", "invite withdrawn", "pair request accepted", "fingerprint refused", "confirmed by you", "confirmation acknowledged", "ended by you", "ended by the peer's refusal"]) assert.ok(steps.includes(step), step);
  const bobSteps = bobDb.prepare("SELECT command FROM action_log WHERE rule = 'peer_pairing' ORDER BY id").all().map((r) => r.command);
  for (const step of ["join refused", "joined", "confirmed by the peer", "ended by the peer's notice", "ended by you"]) assert.ok(bobSteps.includes(step), step);
  // No invite and no secret in any file of either store, or in anything either process wrote.
  const secrets = invites.flatMap((text) => [text, text.slice(INVITE_PREFIX.length, INVITE_PREFIX.length + 40), JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), "base64url").toString("utf8")).secret]);
  for (const w of [alice, bob]) {
    for (const file of fs.readdirSync(w.home)) {
      const full = path.join(w.home, file);
      if (!fs.statSync(full).isFile()) continue;
      const bytes = fs.readFileSync(full);
      for (const secret of secrets) {
        assert.ok(!bytes.toString("latin1").includes(secret), `${w.name}'s ${file} holds no invite`);
      }
      for (const text of invites) {
        const raw = Buffer.from(JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), "base64url").toString("utf8")).secret, "base64url");
        assert.equal(bytes.indexOf(raw), -1, `${w.name}'s ${file} holds no secret's bytes`);
      }
    }
    for (const secret of secrets) assert.ok(!w.output().includes(secret), `${w.name} wrote no invite to its output`);
  }
});
