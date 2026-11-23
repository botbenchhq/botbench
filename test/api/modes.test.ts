import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { createRun, storePlan } from "../../src/engine/run.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { initRepo, tempDir } from "../support/repo.ts";

// The modes over HTTP, with a real server, store and repository. No test here starts a driver: every request that
// would start a planner is one the server refuses first, and runs are otherwise put in the store as the engine stores
// them. A run that really plans is in test/live and in the browser journey e2e/modes.e2e.ts.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  repo: string;
  commit: string;
  base: string;
  headers: Record<string, string>;
}

async function start(t: T, o: { checks?: string[]; mode?: "manual" | "semi" | "full" } = {}): Promise<Api> {
  const dir = tempDir("botbench-modes-api-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const commit = initRepo(repo);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: { [repo]: { checks: o.checks ?? [] } }, ...(o.mode ? { autonomy: { mode: o.mode } } : {}) };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await res.arrayBuffer();
  return { server, repo, commit, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

type Body = Record<string, unknown>;
async function call(api: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...api.headers, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Body) };
}
const runCount = (api: Api): number => Number(api.server.db.prepare("SELECT count(*) AS n FROM runs").get()!.n);

test("a fully autonomous run on a repository with no checks is refused with 400 and the plain reason, and nothing is stored", async (t) => {
  const api = await start(t);
  const res = await call(api, "POST", "/api/runs", { repo: api.repo, prompt: "Add a file", mode: "full" });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /^This repository has no checks set up, so a run on it cannot be fully autonomous: without checks, "fully autonomous" would mean agents agreeing with each other\./);
  assert.equal(runCount(api), 0);
});

test("a mode that is none of the three is refused with 400 before anything is looked at", async (t) => {
  const api = await start(t);
  const res = await call(api, "POST", "/api/runs", { repo: "/nowhere/at/all", prompt: "Add a file", mode: "yolo" });
  assert.deepEqual([res.status, res.body.error], [400, '"mode" must be "manual", "semi" or "full".']);
  assert.equal(runCount(api), 0);
});

test("a run shows its mode in the list and on its own screen, and no request but the owner's change of mode changes it", async (t) => {
  const api = await start(t);
  const run = createRun(api.server.db, { repo: api.repo, prompt: "Add a file", baseCommit: api.commit, mode: "semi" });
  const stored = storePlan(api.server.db, run.id, [{ title: "Add a file", criteria: ["It exists"] }]);
  assert.equal((await call(api, "GET", `/api/runs/${run.id}`)).body.mode, "semi");
  assert.equal(((await call(api, "GET", "/api/runs")).body.runs as Body[])[0]!.mode, "semi");
  // Only its own route changes it (below), and an edit of the plan that names a mode changes the plan only.
  for (const method of ["PATCH", "PUT", "POST"]) assert.equal((await call(api, method, `/api/runs/${run.id}`, { mode: "full" })).status, 404, method);
  const edited = await call(api, "PATCH", `/api/runs/${run.id}/plan`, { planVersion: stored.planVersion, tasks: [{ title: "Add a file", criteria: ["It exists"] }], mode: "full" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.mode, "semi");
});

test("the owner makes a run that has not finished stricter on its own route: the run answers with its new mode, the stricter modes left and the change in its history", async (t) => {
  const api = await start(t);
  const { db } = api.server;
  const run = createRun(db, { repo: api.repo, prompt: "Add a file", baseCommit: api.commit, mode: "full" });
  storePlan(db, run.id, [{ title: "Add a file", criteria: ["It exists"] }]);
  const shown = await call(api, "GET", `/api/runs/${run.id}`);
  assert.deepEqual([shown.body.mode, shown.body.modeChoices, shown.body.modeChanges], ["full", ["semi", "manual"], []]);
  // Reading the run changes nothing: only the owner's request does.
  assert.equal((await call(api, "GET", `/api/runs/${run.id}`)).body.mode, "full");

  const semi = await call(api, "POST", `/api/runs/${run.id}/mode`, { mode: "semi" });
  assert.equal(semi.status, 200);
  assert.deepEqual([semi.body.mode, semi.body.modeChoices], ["semi", ["manual"]]);
  const manual = await call(api, "POST", `/api/runs/${run.id}/mode`, { mode: "manual" });
  assert.deepEqual([manual.status, manual.body.mode, manual.body.modeChoices], [200, "manual", []]);
  assert.deepEqual((manual.body.modeChanges as Body[]).map((change) => change.words), ["You changed the mode from fully autonomous to semi-autonomous.", "You changed the mode from semi-autonomous to manual."]);
  assert.equal(((await call(api, "GET", "/api/runs")).body.runs as Body[])[0]!.mode, "manual");
  const owner = db.prepare("SELECT actor, mode_from, mode_to, detail FROM run_events WHERE run_id = ? AND mode_to IS NOT NULL ORDER BY id").all(run.id).map((row) => ({ ...row }));
  assert.deepEqual(owner, [
    { actor: "owner", mode_from: "full", mode_to: "semi", detail: "mode changed by the owner from fully autonomous to semi-autonomous" },
    { actor: "owner", mode_from: "semi", mode_to: "manual", detail: "mode changed by the owner from semi-autonomous to manual" },
  ]);
});

test("a looser or the same mode, an unknown mode, a finished run or no such run is answered with a plain error, and the mode is as it was", async (t) => {
  const api = await start(t);
  const { db } = api.server;
  const run = createRun(db, { repo: api.repo, prompt: "Add a file", baseCommit: api.commit, mode: "semi" });
  const answered = async (body: unknown, id = run.id) => {
    const res = await call(api, "POST", `/api/runs/${id}/mode`, body);
    return [res.status, res.body.error];
  };
  assert.deepEqual(await answered({ mode: "full" }), [409, `Run ${run.id} is semi-autonomous. A run's mode can be made stricter while it works, never looser, so it cannot become fully autonomous.`]);
  assert.deepEqual(await answered({ mode: "semi" }), [409, `Run ${run.id} is already semi-autonomous.`]);
  assert.deepEqual(await answered({ mode: "yolo" }), [400, '"mode" must be "manual", "semi" or "full".']);
  assert.deepEqual(await answered({}), [400, '"mode" must be "manual", "semi" or "full".']);
  assert.deepEqual(await answered({ mode: "manual" }, 9999), [404, "No such run."]);
  db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(run.id);
  assert.deepEqual(await answered({ mode: "manual" }), [409, `Run ${run.id} has finished, so its mode can no longer be changed.`]);
  const after = await call(api, "GET", `/api/runs/${run.id}`);
  assert.deepEqual([after.body.mode, after.body.modeChoices, after.body.modeChanges], ["semi", [], []]);
  // Without the owner's session nothing is changed.
  const live = createRun(db, { repo: api.repo, prompt: "Add a file", baseCommit: api.commit, mode: "semi" });
  const res = await fetch(`${api.base}/api/runs/${live.id}/mode`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ mode: "manual" }) });
  assert.equal(res.status, 401);
  await res.arrayBuffer();
  assert.equal((await call(api, "GET", `/api/runs/${live.id}`)).body.mode, "semi");
});

test("Settings: the default mode is the settings file's until the owner picks one, which is kept; a value that is no mode is refused", async (t) => {
  const api = await start(t, { mode: "semi" });
  assert.equal((await call(api, "GET", "/api/settings")).body.defaultMode, "semi");
  const saved = await call(api, "PUT", "/api/settings", { defaultMode: "full" });
  assert.deepEqual([saved.status, saved.body.defaultMode], [200, "full"]);
  assert.equal((await call(api, "GET", "/api/settings")).body.defaultMode, "full");
  assert.equal((await call(api, "PUT", "/api/settings", { defaultMode: "yolo" })).status, 400);
  assert.equal((await call(api, "GET", "/api/settings")).body.defaultMode, "full");
  // The default applies to a run that names no mode: here fully autonomous, which this repository cannot have.
  const res = await call(api, "POST", "/api/runs", { repo: api.repo, prompt: "Add a file" });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /cannot be fully autonomous/);
});

test("Settings: web access in chat is Allow until the owner picks Ask or Off, which is kept; any other value is refused", async (t) => {
  const api = await start(t);
  assert.equal((await call(api, "GET", "/api/settings")).body.chatWebAccess, "allow");
  for (const value of ["ask", "off", "allow"]) {
    const saved = await call(api, "PUT", "/api/settings", { chatWebAccess: value });
    assert.deepEqual([saved.status, saved.body.chatWebAccess], [200, value]);
    assert.equal((await call(api, "GET", "/api/settings")).body.chatWebAccess, value);
  }
  assert.equal((await call(api, "PUT", "/api/settings", { chatWebAccess: "always" })).status, 400);
  assert.equal((await call(api, "GET", "/api/settings")).body.chatWebAccess, "allow");
});

test("Settings: Ask before every command is off until the owner turns it on, which is kept; anything but true or false is refused", async (t) => {
  const api = await start(t);
  assert.equal((await call(api, "GET", "/api/settings")).body.askEveryCommand, false);
  for (const value of [true, false, true]) {
    const saved = await call(api, "PUT", "/api/settings", { askEveryCommand: value });
    assert.deepEqual([saved.status, saved.body.askEveryCommand], [200, value]);
    assert.equal((await call(api, "GET", "/api/settings")).body.askEveryCommand, value);
  }
  for (const bad of ["on", 1, null]) assert.equal((await call(api, "PUT", "/api/settings", { askEveryCommand: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await call(api, "GET", "/api/settings")).body.askEveryCommand, true);
});

test("Settings needs the owner's session", async (t) => {
  const api = await start(t);
  const res = await fetch(`${api.base}/api/settings`);
  assert.equal(res.status, 401);
  await res.arrayBuffer();
});
