import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { Config } from "../../src/config.ts";
import { createTask, moveTask } from "../../src/engine/task.ts";
import { startServer, type SmeltServer } from "../../src/server.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { checkoutState, git, initRepo, smeltBranches, tempDir, worktreeCount, write } from "../support/repo.ts";

// No test in this file starts a driver: tasks that reach Claude Code are in test/live/task.live.test.ts.

type T = { after(fn: () => unknown): void };
const JSON_TYPE = { "content-type": "application/json" };

async function start(t: T, dir = tempDir("smelt-tasks-api-")): Promise<{ server: SmeltServer; dir: string; home: string; base: string; headers: Record<string, string> }> {
  // `dir` holds the Smelt home and the test's repositories; removing it removes their worktrees with them.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const res = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(res.status, 200, "sign-in");
  await res.arrayBuffer();
  return { server, dir, home, base, headers: { cookie: res.headers.getSetCookie()[0]!.split(";")[0]! } };
}

async function get(base: string, headers: Record<string, string>, route: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function post(base: string, headers: Record<string, string>, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** One GET with the path sent exactly as written: `fetch` would tidy `..` away before sending. */
function raw(port: number, rawPath: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("every task route refuses a request without a session, and exists for one with a session", async (t) => {
  const { base, headers, dir } = await start(t);
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/tasks"],
    ["POST", "/api/tasks", { repo, prompt: "create hello.txt" }],
    ["GET", "/api/tasks/1"],
    ["GET", "/api/tasks/1/diff?file=hello.txt"],
    ["GET", `/api/repos/check?path=${encodeURIComponent(repo)}`],
  ];
  for (const [method, route, body] of routes) {
    for (const without of [{}, { cookie: "smelt_session=not-a-session" }] as Record<string, string>[]) {
      const res = await fetch(`${base}${route}`, { method, headers: { ...without, ...(body ? JSON_TYPE : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(res.status, 401, `${method} ${route} without a session`);
      assert.deepEqual(await res.json(), { error: "sign in required" });
    }
  }
  // Nothing came of the refused requests.
  assert.equal(worktreeCount(repo), 1);

  // With a session the same addresses are real routes, each with its own answer.
  assert.deepEqual(await get(base, headers, "/api/tasks"), { status: 200, body: { tasks: [] } });
  assert.deepEqual(await get(base, headers, "/api/tasks/1"), { status: 404, body: { error: "No such task." } });
  assert.deepEqual(await get(base, headers, "/api/tasks/1/diff?file=hello.txt"), { status: 404, body: { error: "No such task." } });
  assert.deepEqual(await get(base, headers, `/api/repos/check?path=${encodeURIComponent(repo)}`), { status: 200, body: { usable: true, path: repo, reason: null } });
  assert.equal((await post(base, headers, "/api/tasks", {})).status, 400);
  // Ids that are not ids name no task route.
  for (const route of ["/api/tasks/0", "/api/tasks/abc", "/api/tasks/1e3", "/api/tasks/-1", "/api/tasks/1/diff/extra", `/api/tasks/${"9".repeat(30)}`]) {
    assert.equal((await get(base, headers, route)).status, 404, route);
  }
});

test("a repository path that cannot be used is refused before any task row or worktree exists", async (t) => {
  const { server, base, headers, dir, home } = await start(t);
  const repo = path.join(dir, "repo");
  initRepo(repo);
  const empty = path.join(dir, "no-commits");
  fs.mkdirSync(empty);
  git(empty, "init", "--quiet");
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);
  const before = checkoutState(repo);

  const refusals: [unknown, RegExp][] = [
    [{ repo: plain, prompt: "p" }, /not a git repository/],
    [{ repo: empty, prompt: "p" }, /no commits/],
    [{ repo: "repo", prompt: "p" }, /full path/],
    [{ repo: "../repo", prompt: "p" }, /full path/],
    [{ repo: path.join(dir, "missing"), prompt: "p" }, /does not exist/],
    [{ repo: path.join(repo, "sub"), prompt: "p" }, /does not exist/],
    [{ repo: ["/tmp"], prompt: "p" }, /"repo".*"prompt"/],
    [{ prompt: "p" }, /"repo".*"prompt"/],
    [{ repo }, /"repo".*"prompt"/],
    [{ repo, prompt: "   " }, /"repo".*"prompt"/],
    [{ repo, prompt: 7 }, /"repo".*"prompt"/],
    [{ repo, prompt: "x".repeat(20_001) }, /too long/],
    [[repo, "p"], /"repo".*"prompt"/],
    ["not json", /not valid JSON/],
  ];
  for (const [body, words] of refusals) {
    const res = await post(base, headers, "/api/tasks", body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(String(res.body.error), words);
    assert.equal(res.body.taskId, undefined);
  }
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, 0, "no task row");
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM task_events").get()!.n, 0);
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0, "no driver was started");
  assert.equal(fs.existsSync(path.join(home, "worktrees")), false, "no worktree folder");
  assert.equal(worktreeCount(repo), 1);
  assert.deepEqual(smeltBranches(repo), []);
  assert.deepEqual(checkoutState(repo), before);
  assert.deepEqual((await get(base, headers, "/api/tasks")).body, { tasks: [] });

  // The same check, on its own route, answers in words as the owner types.
  const check = async (p: string) => (await get(base, headers, `/api/repos/check?path=${encodeURIComponent(p)}`)).body;
  assert.deepEqual(await check(repo), { usable: true, path: repo, reason: null });
  for (const [p, words] of [[plain, /not a git repository/], [empty, /no commits/], ["repo", /full path/], [path.join(dir, "missing"), /does not exist/], ["", /full path/]] as [string, RegExp][]) {
    const answer = await check(p);
    assert.equal(answer.usable, false, p);
    assert.match(String(answer.reason), words);
  }
  assert.equal((await get(base, headers, "/api/repos/check")).status, 400, "no path given");
  // It answers about one path and lists nothing.
  assert.deepEqual(Object.keys(await check(dir)).sort(), ["path", "reason", "usable"]);
});

test("a committed task is described with its changed files, and each file's diff runs from the base commit to the branch head", async (t) => {
  const { server, base, headers, dir, home } = await start(t);
  const repo = path.join(dir, "repo");
  const baseCommit = initRepo(repo, { "README.md": "# Sample\n", "src/app.txt": "one\ntwo\nthree\n", "old.txt": "going\n" });
  write(repo, "README.md", "# Sample\nthe owner's uncommitted line\n");
  const before = checkoutState(repo);

  // A task as the engine stores it, with real commits made by Smelt in a real worktree. No driver is involved.
  const first = createTask(server.db, { repo, prompt: "an older task" });
  const task = createTask(server.db, { repo, prompt: "change three files" });
  const worktree = await createWorktree({ repo, home, run: "run-api", task: `task-${task.id}` });
  moveTask(server.db, task.id, "building", { worktree });

  // Before anything is committed there is nothing to show, and the routes say so.
  const building = (await get(base, headers, `/api/tasks/${task.id}`)).body;
  assert.deepEqual([building.status, building.headCommit, building.files], ["building", null, null]);
  const early = await get(base, headers, `/api/tasks/${task.id}/diff?file=hello.txt`);
  assert.equal(early.status, 409);
  assert.match(String(early.body.error), /nothing committed yet/i);

  write(worktree.path, "hello.txt", "hi\n");
  write(worktree.path, "src/app.txt", "one\n2\nthree\nfour\n");
  fs.rmSync(path.join(worktree.path, "old.txt"));
  write(worktree.path, "odd name's \"file\".txt", "<b>not markup</b>\n");
  const committed = await commitWork({ path: worktree.path, message: "Smelt task: change three files" });
  assert.ok(committed.committed);
  // Work left uncommitted after Smelt's commit is not part of the task's changes.
  write(worktree.path, "later.txt", "not committed\n");
  moveTask(server.db, task.id, "awaiting_decision", { headCommit: committed.commit });

  const described = await get(base, headers, `/api/tasks/${task.id}`);
  assert.equal(described.status, 200);
  assert.deepEqual({ ...described.body, createdAt: null, updatedAt: null }, {
    id: task.id, repo, prompt: "change three files", status: "awaiting_decision", reason: null,
    branch: worktree.branch, baseCommit, headCommit: committed.commit, attemptId: null, waitingOnApproval: false, createdAt: null, updatedAt: null,
    files: [
      { path: "hello.txt", status: "added", added: 1, removed: 0, binary: false },
      { path: "odd name's \"file\".txt", status: "added", added: 1, removed: 0, binary: false },
      { path: "old.txt", status: "deleted", added: 0, removed: 1, binary: false },
      { path: "src/app.txt", status: "modified", added: 2, removed: 1, binary: false },
    ],
    filesProblem: null,
  });
  assert.equal(described.body.worktreePath, undefined, "the worktree's location is not part of the answer");

  const diff = async (file: string) => get(base, headers, `/api/tasks/${task.id}/diff?file=${encodeURIComponent(file)}`);
  const hello = await diff("hello.txt");
  assert.equal(hello.status, 200);
  assert.equal(hello.body.file, "hello.txt");
  assert.match(String(hello.body.diff), /^diff --git a\/hello\.txt b\/hello\.txt\nnew file mode 100644\n/);
  assert.match(String(hello.body.diff), /\n--- \/dev\/null\n\+\+\+ b\/hello\.txt\n@@ -0,0 \+1 @@\n\+hi\n$/);
  const app = String((await diff("src/app.txt")).body.diff);
  assert.match(app, /\n--- a\/src\/app\.txt\n\+\+\+ b\/src\/app\.txt\n/);
  assert.match(app, /\n one\n-two\n\+2\n three\n\+four\n$/);
  assert.match(String((await diff("old.txt")).body.diff), /deleted file mode 100644\n[^]*\n-going\n$/);
  assert.match(String((await diff("odd name's \"file\".txt")).body.diff), /\n\+<b>not markup<\/b>\n$/);
  // The diff is from the base commit, not from the owner's uncommitted checkout.
  assert.doesNotMatch(app + String(hello.body.diff), /uncommitted/);

  // A file that is not among the task's changes is refused, whatever it names.
  const refused = [
    "README.md", // exists, unchanged
    "later.txt", // in the worktree, not committed
    "../../../../etc/passwd",
    "/etc/passwd",
    "src/../hello.txt",
    "./hello.txt",
    "hello.txt/",
    ".git/config",
    "--output=/tmp/smelt-should-not-exist",
    "-p",
    ":(top)hello.txt",
    "*.txt",
    "HELLO.TXT",
    "",
  ];
  for (const file of refused) {
    const res = await diff(file);
    assert.equal(res.status, 400, `diff of ${JSON.stringify(file)}`);
    assert.match(String(res.body.error), /not one of this task's changed files|"file"/);
    assert.equal(res.body.diff, undefined);
  }
  assert.equal(fs.existsSync("/tmp/smelt-should-not-exist"), false);
  assert.equal((await get(base, headers, `/api/tasks/${task.id}/diff`)).status, 400, "no file given");
  assert.equal((await get(base, headers, `/api/tasks/${task.id}/diff?file=hello.txt&file=README.md`)).status, 400, "two files given");
  // A traversal in the address itself reaches no task route.
  for (const rawPath of [`/api/tasks/${task.id}/../../etc/passwd`, `/api/tasks/${task.id}/diff/..%2f..%2fetc%2fpasswd`, `/api/tasks/..%2f${task.id}`]) {
    const res = await raw(server.port, rawPath, headers);
    assert.equal(res.status, 404, rawPath);
    assert.doesNotMatch(res.body, /root:/);
  }

  // The list is newest first and carries no file detail.
  const list = (await get(base, headers, "/api/tasks")).body.tasks as Record<string, unknown>[];
  assert.deepEqual(list.map((x) => [x.id, x.status, x.prompt, x.repo, x.branch]), [
    [task.id, "awaiting_decision", "change three files", repo, worktree.branch],
    [first.id, "queued", "an older task", repo, null],
  ]);
  assert.equal(list[0]!.files, undefined);

  // A task whose worktree is gone still answers, and says in words why its files cannot be shown.
  const lost = createTask(server.db, { repo, prompt: "worktree removed by hand" });
  moveTask(server.db, lost.id, "building", { worktree: { path: path.join(home, "worktrees", "gone", "task-x"), branch: "smelt/gone/task-x", baseCommit } });
  moveTask(server.db, lost.id, "awaiting_decision", { headCommit: baseCommit });
  const gone = (await get(base, headers, `/api/tasks/${lost.id}`)).body;
  assert.equal(gone.files, null);
  assert.match(String(gone.filesProblem), /not a Smelt worktree/);
  assert.equal((await get(base, headers, `/api/tasks/${lost.id}/diff?file=hello.txt`)).status, 409);

  assert.deepEqual(checkoutState(repo), before, "the owner's checkout is as it was");
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0, "no driver was started");
});

test("starting a task answers at once with its id, and each state it reaches is announced on the event stream", async (t) => {
  // Smelt's home inside the repository: the task is real and fails at its first step, before any driver could start.
  const repo = tempDir("smelt-tasks-api-");
  initRepo(repo);
  const { server, base, headers } = await start(t, repo);
  const before = checkoutState(repo);

  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${base}/api/stream`, { headers, signal: abort.signal });
  const frames: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream.body!) frames.push(decoder.decode(chunk, { stream: true }));
    } catch {
      // Aborted when the test ends.
    }
  })();

  const started = await post(base, headers, "/api/tasks", { repo, prompt: "create hello.txt" });
  assert.deepEqual(started, { status: 200, body: { taskId: 1 } });
  const announcements = (): unknown[] => frames.join("").split("\n\n").filter((f) => f.startsWith("event: task\n")).map((f) => JSON.parse(f.split("\n")[1]!.slice("data: ".length)));
  const deadline = Date.now() + 10_000;
  while (announcements().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(announcements(), [{ taskId: 1, status: "queued", attemptId: null }, { taskId: 1, status: "failed", attemptId: null }]);
  // An announcement carries no id, so it never moves a client's place among the stored events.
  assert.doesNotMatch(frames.join(""), /(^|\n)id: /);

  const task = (await get(base, headers, "/api/tasks/1")).body;
  assert.equal(task.status, "failed");
  assert.match(String(task.reason), /worktree could not be created/);
  assert.deepEqual([task.branch, task.headCommit, task.attemptId, task.files], [null, null, null, null]);
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n, 0, "no driver was started");
  assert.deepEqual(checkoutState(repo), before);
  assert.deepEqual(smeltBranches(repo), []);
});
