import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import { actionLog } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { captureNote, memoryFolder, memorySection } from "../../src/engine/memory.ts";
import { plannerPrompt } from "../../src/engine/roles.ts";
import { startServer, type BotbenchServer } from "../../src/server.ts";
import { tempDir } from "../support/repo.ts";

// The memory routes over real HTTP, with a real server, data folder and store: listing, editing and forgetting the
// owner's notes, behind the sign-in, and what each change does to the next prompt. No agent is started.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

interface Api {
  server: BotbenchServer;
  home: string;
  base: string;
  headers: Record<string, string>;
}

async function start(t: T): Promise<Api> {
  const dir = tempDir("botbench-memory-api-");
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {}, repositories: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  await res.arrayBuffer();
  return { server, home, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

type Body = Record<string, unknown>;
async function call(api: Api, method: string, route: string, body?: unknown, signedIn = true): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${api.base}${route}`, { method, headers: { ...(signedIn ? api.headers : {}), ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Body) };
}

interface Listed {
  id: number;
  text: string;
  hash: string;
  savedAt: string;
  editedAt: string | null;
}
const notes = (res: { body: Body }): Listed[] => res.body.notes as Listed[];
const filesOf = (home: string): Record<string, string> => Object.fromEntries(fs.existsSync(memoryFolder(home)) ? fs.readdirSync(memoryFolder(home)).map((name) => [name, fs.readFileSync(path.join(memoryFolder(home), name), "utf8")]) : []);
const nextPrompt = (home: string): string => plannerPrompt({ work: "Add a greeting", memory: memorySection(home) });

test("listing, editing and forgetting notes need the sign-in: without it each is refused and nothing changes", async (t) => {
  const api = await start(t);
  const note = captureNote(api.server.db, api.home, "the staging database is read-only");
  const before = filesOf(api.home);
  for (const [method, route, body] of [["GET", "/api/memory", undefined], ["PUT", `/api/memory/${note.id}`, { text: "changed", hash: note.hash }], ["DELETE", `/api/memory/${note.id}`, { hash: note.hash }]] as const) {
    const res = await call(api, method, route, body, false);
    assert.equal(res.status, 401, `${method} ${route}`);
    assert.equal(JSON.stringify(res.body).includes("staging"), false, "no note is sent without the sign-in");
  }
  assert.deepEqual(filesOf(api.home), before);
});

test("GET lists the notes newest first with their versions and caps; with none, an empty list", async (t) => {
  const api = await start(t);
  const empty = await call(api, "GET", "/api/memory");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { notes: [], maxNoteChars: 1000, maxKb: 32 });
  captureNote(api.server.db, api.home, "first");
  captureNote(api.server.db, api.home, "second");
  const listed = await call(api, "GET", "/api/memory");
  assert.deepEqual(notes(listed).map((n) => [n.id, n.text]), [[2, "second"], [1, "first"]]);
  assert.match(notes(listed)[0]!.hash, /^[0-9a-f]{64}$/);
});

test("an edit through the API changes the next prompt; one made on a version that changed since is refused in plain words and overwrites nothing", async (t) => {
  const api = await start(t);
  captureNote(api.server.db, api.home, "run the linter before committing");
  const [loaded] = notes(await call(api, "GET", "/api/memory"));
  // Another tab edits it first.
  const other = await call(api, "PUT", `/api/memory/${loaded!.id}`, { text: "run npm run lint before committing", hash: loaded!.hash });
  assert.equal(other.status, 200);
  assert.equal((other.body.note as Listed).text, "run npm run lint before committing");
  assert.ok(nextPrompt(api.home).includes("<memory>\nrun npm run lint before committing\n</memory>"));
  assert.ok(!nextPrompt(api.home).includes("run the linter before committing"));

  const before = filesOf(api.home);
  const stale = await call(api, "PUT", `/api/memory/${loaded!.id}`, { text: "never lint", hash: loaded!.hash });
  assert.equal(stale.status, 409);
  assert.match(String(stale.body.error), /^This note changed since you opened it, so your edit was not saved\./);
  assert.deepEqual(filesOf(api.home), before);
  assert.ok(!nextPrompt(api.home).includes("never lint"));

  for (const [body, status] of [[{ text: "x" }, 400], [{ hash: "abc" }, 400], [{ text: 5, hash: "abc" }, 400], [{ text: "  ", hash: (other.body.note as Listed).hash }, 400], [{ text: "x".repeat(1001), hash: (other.body.note as Listed).hash }, 413]] as const) {
    const res = await call(api, "PUT", `/api/memory/${loaded!.id}`, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(typeof res.body.error, "string");
  }
  assert.equal((await call(api, "PUT", "/api/memory/99", { text: "x", hash: "abc" })).status, 404);
  assert.equal((await call(api, "PUT", "/api/memory/..%2Fsecret", { text: "x", hash: "abc" })).status, 404, "a route names a note by its number only");
  assert.deepEqual(filesOf(api.home), before);
});

test("forget through the API removes the note from the next prompt and from every file on disk, keeps no copy, and is logged", async (t) => {
  const api = await start(t);
  captureNote(api.server.db, api.home, "the staging database is read-only");
  captureNote(api.server.db, api.home, "my deploy key lives in the blue folder");
  const [gone, kept] = notes(await call(api, "GET", "/api/memory"));
  assert.equal(gone!.text, "my deploy key lives in the blue folder");
  assert.ok(nextPrompt(api.home).includes("deploy key"));

  assert.equal((await call(api, "DELETE", `/api/memory/${gone!.id}`, { hash: "0".repeat(64) })).status, 409, "a forget carries the version it saw");
  const res = await call(api, "DELETE", `/api/memory/${gone!.id}`, { hash: gone!.hash });
  assert.equal(res.status, 200);
  assert.deepEqual(notes(res).map((n) => n.id), [kept!.id], "the notes as they are now");
  assert.ok(!nextPrompt(api.home).includes("deploy key"));
  const files = filesOf(api.home);
  assert.deepEqual(Object.keys(files).sort(), ["MEMORY.md", `note-${kept!.id}.md`]);
  for (const [name, text] of Object.entries(files)) assert.ok(!text.includes("deploy key"), name);

  // Forgetting the last note leaves no section at all: the next prompt is as it was before memory.
  assert.equal((await call(api, "DELETE", `/api/memory/${kept!.id}`, { hash: kept!.hash })).status, 200);
  assert.equal(nextPrompt(api.home), plannerPrompt({ work: "Add a greeting" }));
  assert.deepEqual(actionLog(api.server.db).filter((e) => (e.rule as string) === "memory").map((e) => e.command), ["remember note-1", "remember note-2", "forget note-2", "forget note-1"]);
});
