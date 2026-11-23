import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { BACKUP_FILE, JOURNAL_FILE, readJournal, UPDATE_DIR } from "../../src/update.ts";
import { decrypt, newDevice, startPushEndpoint } from "../support/push-service.ts";
import { botbenchRepo, bumpVersion, commitAndTag, notesFor, startReleaseServer, type ReleaseServer } from "../support/releases.ts";
import { git, tempDir } from "../support/repo.ts";

// Updating Botbench to a release over its real HTTP API: a real Botbench server, real SQLite, a real git repository
// acting as GitHub's holding this checkout's own files with real tags, an installation cloned from it on main, and
// GitHub's latest-release answer served from a real HTTP server (test/support/releases.ts: the captured response, with
// only its tag and notes set to the test's). The update really unpacks the tag's commit, runs npm ci at the root and in
// web/, builds the client, starts the new build on an empty data folder to check it, and moves the installation. The
// service label is one launchd does not have, so nothing is restarted: the restart is a second server on the same data.

type T = { after(fn: () => unknown): void };
type Body = Record<string, unknown>;
const JSON_TYPE = { "content-type": "application/json" };
const NO_SERVICE = "dev.botbench.test-no-such-service";

interface Place {
  dir: string;
  home: string;
  remote: string;
  install: string;
  base: string;
  releases: ReleaseServer;
}

async function place(t: T): Promise<Place> {
  const dir = tempDir("botbench-update-api-");
  const releases = await startReleaseServer();
  t.after(async () => {
    await releases.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const remote = path.join(dir, "github");
  const base = botbenchRepo(remote);
  git(remote, "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "tag", "-a", "-m", "v0.1.0", "v0.1.0");
  const install = path.join(dir, "install");
  git(dir, "clone", "--quiet", remote, install);
  return { dir, home: path.join(dir, "home"), remote, install, base, releases };
}

async function start(t: T, p: Place): Promise<{ server: BotbenchServer; call: (method: string, route: string, body?: unknown) => Promise<{ status: number; body: Body }> }> {
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} } as Config;
  const server = await startServer({ config, home: p.home, signInDelayMs: 1, allowHttpPushEndpoints: true, installDir: p.install, updates: { releasesUrl: p.releases.url, gitUrl: p.remote, serviceLabel: NO_SERVICE, stepTimeoutMs: 90_000 } });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(p.home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await res.arrayBuffer();
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const call = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`${base}${route}`, { method, headers: { cookie, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as Body };
  };
  return { server, call };
}

/** GET /api/update once its first check has answered. */
async function checked(call: (m: string, r: string) => Promise<{ body: Body }>): Promise<Body> {
  for (let i = 0; i < 200; i++) {
    const { body } = await call("GET", "/api/update");
    if (body.checkedAt !== null) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the first check never answered");
}

/** GET /api/update once the update has stopped being under way. */
async function settled(call: (m: string, r: string) => Promise<{ body: Body }>): Promise<Body> {
  for (let i = 0; i < 1200; i++) {
    const { body } = await call("GET", "/api/update");
    const kind = (body.state as Body).kind;
    if (kind !== "waiting" && kind !== "updating" && kind !== "idle") return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the update never ended");
}

/** Publish v0.2.0 on the remote: the version bumped, and `change` made to the files. */
function publish(p: Place, change: (dir: string) => void = () => {}): string {
  bumpVersion(p.remote, "0.2.0");
  change(p.remote);
  const target = commitAndTag(p.remote, "chore(main): release 0.2.0", "v0.2.0");
  p.releases.publish({ tag: "v0.2.0", notes: notesFor("0.2.0", "update Botbench from Settings") });
  return target;
}

test("Update now installs a release, checks the new build starts, moves the installation, and the next start says it updated", async (t) => {
  const p = await place(t);
  const target = publish(p);
  const endpoint = await startPushEndpoint();
  t.after(() => endpoint.close());
  const phone = newDevice();

  const first = await start(t, p);
  first.server.push.subscribe(phone.subscription(endpoint.url("phone")));
  const before = await checked(first.call);
  assert.equal(before.version, "0.1.0");
  assert.equal(before.available, true);
  assert.equal(before.mode, "tap", "on a tap unless the owner chose otherwise");
  assert.deepEqual(before.latest, { version: "0.2.0", tag: "v0.2.0", summary: "update Botbench from Settings", url: "https://github.com/jon-lange/botbench/releases/tag/v0.2.0" });
  assert.equal((before.state as Body).kind, "idle", "on a tap: nothing starts by itself");
  assert.equal(git(p.install, "rev-parse", "HEAD").trim(), p.base);

  const started = await first.call("POST", "/api/update", {});
  assert.equal(started.status, 202);
  const after = await settled(first.call);
  assert.deepEqual(after.state, { ...(after.state as Body), kind: "restart_needed", version: "0.2.0", message: "0.2.0 is installed. Restart Botbench to run it." });
  assert.equal(git(p.install, "rev-parse", "HEAD").trim(), target, "moved to the tag's commit");
  assert.equal(git(p.install, "symbolic-ref", "--short", "HEAD").trim(), "main");
  assert.equal(git(p.install, "status", "--porcelain"), "", "installed and built with nothing left that git would list");
  assert.ok(fs.existsSync(path.join(p.install, "web", "dist", "index.html")), "the client was built in the installation");
  assert.ok(!fs.existsSync(path.join(p.home, UPDATE_DIR)), "the checked build and its data folder are removed");
  assert.equal(readJournal(p.home)?.state, "pending");
  assert.equal(fs.statSync(path.join(p.home, BACKUP_FILE)).mode & 0o777, 0o600, "the database as it was before, owner-only");
  assert.equal(endpoint.received.length, 0, "nothing is said to the phone before the new version runs");
  await first.server.close();

  // The restart: the next start runs on the installation's new commit, confirms the update and tells the phone once.
  const second = await start(t, p);
  for (let i = 0; i < 200 && endpoint.received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const now = (await second.call("GET", "/api/update")).body;
  assert.equal(now.version, "0.2.0");
  assert.equal((now.state as Body).kind, "updated");
  assert.equal(now.available, false);
  await second.server.push.idle();
  assert.deepEqual(endpoint.received.map((r) => JSON.parse(decrypt(r.body, phone.privateKey, phone.auth).toString("utf8"))), [{ title: "Botbench updated to 0.2.0", path: "/#/settings/workbench" }]);
  assert.equal(readJournal(p.home)?.state, "done");
  await second.server.close();
  const third = await start(t, p);
  await third.server.push.idle();
  assert.equal(endpoint.received.length, 1, "said once, not at every start");
  assert.ok(fs.existsSync(path.join(p.home, JOURNAL_FILE)));
});

test("a release whose new build does not start is not installed: the installation stays on its commit, and Settings says why", async (t) => {
  const p = await place(t);
  publish(p, (dir) => {
    const file = path.join(dir, "src", "server.ts");
    fs.writeFileSync(file, `throw new Error("this release cannot start");\n${fs.readFileSync(file, "utf8")}`);
  });
  const { call } = await start(t, p);
  await checked(call);
  assert.equal((await call("POST", "/api/update", {})).status, 202);
  const after = await settled(call);
  const state = after.state as Body;
  assert.equal(state.kind, "failed");
  assert.match(String(state.message), /^The new version did not start properly: it stopped as it started/);
  assert.match(String(state.message), /this release cannot start/);
  assert.match(String(state.message), /The installation stays on 0\.1\.0; nothing in it was changed\.$/);
  assert.equal(git(p.install, "rev-parse", "HEAD").trim(), p.base);
  assert.equal(git(p.install, "status", "--porcelain"), "");
  assert.equal(readJournal(p.home), null);
  assert.ok(!fs.existsSync(path.join(p.home, UPDATE_DIR)));
  assert.ok(!fs.existsSync(path.join(p.home, BACKUP_FILE)));
});

test("an installation with local changes is refused over the API, and the owner's choice of when to update is kept", async (t) => {
  const p = await place(t);
  publish(p);
  fs.writeFileSync(path.join(p.install, "README.md"), "changed by the owner\n");
  const { call } = await start(t, p);
  await checked(call);
  assert.equal((await call("PUT", "/api/update", { mode: "sometimes" })).status, 400);
  assert.equal((await call("PUT", "/api/update", { mode: "tap" })).body.mode, "tap");
  assert.equal((await call("POST", "/api/update", {})).status, 202);
  const state = (await settled(call)).state as Body;
  assert.equal(state.kind, "failed");
  assert.match(String(state.message), /has changes that are not committed, so it was not updated/);
  assert.equal(git(p.install, "rev-parse", "HEAD").trim(), p.base);
  assert.equal(fs.readFileSync(path.join(p.install, "README.md"), "utf8"), "changed by the owner\n");
});

test("with no release newer than the running one, Update now is refused and nothing runs", async (t) => {
  const p = await place(t);
  const { call } = await start(t, p);
  const status = await checked(call);
  assert.equal(status.latest, null);
  assert.equal(status.available, false);
  const refused = await call("POST", "/api/update", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "There is no newer release to update to.");
  assert.equal(p.releases.requests.length, 1, "one check at the start, no more");
  assert.equal(p.releases.requests[0]!.headers.authorization, undefined);
});
