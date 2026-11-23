import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { workbenchKey } from "../../src/peers/key.ts";
import { startServer } from "../../src/server.ts";
import { pair, REPO, side } from "../support/peer-store.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The one live test of an agent's draft to a paired workbench (Peers P5, ADR 0004 decision 9): the real Claude Code,
// on the owner's login and the cheapest model, builds a task in a repository paired with another workbench, is told
// by Botbench how to draft a message, and its real reply holds a botbench-peer-message block that becomes a card for
// the owner. Nothing is sent: the card waits for a Send that this test never gives. The other workbench is a store of
// its own with its own key, paired by the store's steps, so no second process or network is needed. Kept out of the
// routine suite (npm run test:live); the routine tests replay test/recordings/peer-draft.json once the owner has
// recorded it with test/support/capture-peer-draft.ts.

const JSON_TYPE = { "content-type": "application/json" };

test("live: a real Claude Code reply with a botbench-peer-message block becomes a card holding its exact text, and nothing is sent", { timeout: 300_000 }, async (t) => {
  const dir = tempDir("botbench-live-draft-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Login service\n" });
  git(repo, "remote", "add", "origin", `https://${REPO}.git`);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: "haiku" } }, roles: { implementer: { driver: "claude-code" } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const bob = side(t);
  pair({ home, db: server.db, key: workbenchKey(home) }, bob);
  const base = `http://127.0.0.1:${server.port}`;
  const signedIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token: fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim() }) });
  const cookie = signedIn.headers.getSetCookie()[0]!.split(";")[0]!;
  const started = await fetch(`${base}/api/tasks`, { method: "POST", headers: { ...JSON_TYPE, cookie }, body: JSON.stringify({ repo, prompt: "Write PORT.md with one line saying which port the login service listens on. You do not know it: ask bob's workbench which port it uses, as Botbench describes below, and write 'unknown' for now." }) });
  assert.equal(started.status, 200, await started.clone().text());
  const deadline = Date.now() + 280_000;
  let cards: any[] = [];
  while (Date.now() < deadline) {
    cards = ((await (await fetch(`${base}/api/peers/cards`, { headers: { cookie } })).json()) as { cards: any[] }).cards;
    if (cards.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(cards.length, 1, "one card for the draft");
  assert.equal(cards[0].title, "Send this to bob?");
  assert.deepEqual(cards[0].choices, ["send", "dont_send"]);
  const drafted = server.db.prepare("SELECT body FROM peer_drafts WHERE outcome = 'card'").get();
  assert.equal(cards[0].text, drafted?.body, "the card holds the draft's exact text");
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM peer_messages WHERE direction = 'out' AND kind IN ('question', 'answer')").get()?.n, 0, "nothing was sent");
});
