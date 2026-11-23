import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { StoredEvent } from "../../src/api/stream.ts";
import type { Config } from "../../src/config.ts";
import type { DriverEvent } from "../../src/drivers/events.ts";
import { createContainers } from "../../src/engine/containers.ts";
import { runCommand } from "../../src/engine/stations.ts";
import { containerCommand, dockerProblem, findDocker, runDocker, startTaskContainer, type TaskContainer } from "../../src/execution.ts";
import { startServer } from "../../src/server.ts";
import { openStore } from "../../src/store/db.ts";
import { commitWork, createWorktree } from "../../src/worktrees.ts";
import { git, initRepo, tempDir } from "../support/repo.ts";

// The container kind (U28, ADR 0009) on the owner's real Docker and an image already on this Mac, named by
// BOTBENCH_TEST_CONTAINER_IMAGE (any image with sh, such as alpine:3 or node:24). Nothing is ever pulled. No model turn:
// the agent's side is the exact command line Botbench's permission answer hands Claude Code, run as the CLI would run it.
// In the task's container a command sees the task's copy, writes a file that Botbench then commits on this Mac to the
// task's branch, cannot read a decoy outside the mount, and reaches no network; at start a container whose task is not
// live is removed.

const IMAGE = process.env.BOTBENCH_TEST_CONTAINER_IMAGE ?? "";
const DOCKER = findDocker();

async function why(): Promise<string | false> {
  if (IMAGE === "") return "BOTBENCH_TEST_CONTAINER_IMAGE is not set: name an image already on this Mac that has sh (for example alpine:3) to run the container tests. Nothing is pulled.";
  if (DOCKER === null) return "No docker program was found on PATH, so the container tests did not run.";
  const down = await dockerProblem(DOCKER);
  if (down !== null) return `Docker does not answer here, so the container tests did not run: ${down}`;
  const image = await runDocker(DOCKER, ["image", "inspect", "--format", "{{.Id}}", IMAGE], 20_000);
  if (image.code !== 0) return `The image ${IMAGE} is not on this Mac, and these tests never pull one: run docker pull ${IMAGE} first.`;
  return false;
}

const skip = await why();
if (skip !== false) console.log(`# ${skip}`);

const DECOY = "DECOY-b71e-not-for-containers";

test("in a task's container a command sees the copy, writes a file that lands on the task branch, cannot read a decoy outside the mount, and reaches no network", { skip, timeout: 180_000 }, async (t) => {
  const dir = fs.realpathSync(tempDir("botbench-live-container-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "inside.txt": "INSIDE-OK\n" });
  const dataDir = path.join(dir, "home");
  fs.mkdirSync(dataDir);
  // Beside the copy, in the data folder, as Botbench's own login token is; and outside the data folder.
  fs.writeFileSync(path.join(dataDir, "decoy-login-token"), `${DECOY}\n`);
  fs.writeFileSync(path.join(dir, "decoy-outside"), `${DECOY}\n`);
  const taskId = 900_000 + Math.floor(Math.random() * 99_999);
  const worktree = await createWorktree({ repo, home: dataDir, run: "run-1", task: `task-${taskId}`, workbench: "live" });
  const copy = fs.realpathSync(worktree.path);

  const started = await startTaskContainer({ workbench: "live", taskId, image: IMAGE, mount: copy, dataDir, allowedHosts: [], docker: DOCKER! });
  assert.ok(started.ok, started.ok ? "" : started.why);
  const c: TaskContainer = started.container;
  t.after(() => runDocker(DOCKER!, ["rm", "-f", c.name], 20_000));
  const inspected = JSON.parse((await runDocker(DOCKER!, ["inspect", c.name], 20_000)).stdout)[0];
  assert.equal(inspected.Config.User, `${process.getuid!()}:${process.getgid!()}`);
  assert.deepEqual(inspected.Config.Labels["botbench.task"], String(taskId));
  assert.equal(inspected.Config.Env.some((e: string) => /ANTHROPIC|OPENAI|SSH_AUTH|BOTBENCH/.test(e)), false, "nothing of this Mac's environment");

  const run = (command: string) => runCommand({ command, cwd: copy, limitMs: 60_000, confinement: { dataDir, allowedHosts: [] }, container: c });
  // A check command, through docker exec in the container.
  const seen = await run("cat inside.txt && pwd && echo from-check > check.txt");
  assert.equal(seen.outcome, "passed", seen.output);
  assert.match(seen.output, /INSIDE-OK/);
  assert.match(seen.output, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // The agent's command, as the permission answer rewrites it and the CLI then runs it, quotes and a newline included.
  const agent = spawnSync("/bin/sh", ["-c", containerCommand(c, "printf '%s\\n' \"it's here\" > agent.txt\necho done")], { encoding: "utf8", cwd: copy });
  assert.equal(agent.status, 0, agent.stderr);
  assert.equal(agent.stdout.trim(), "done");

  // Outside the mount there is nothing to read: not the data folder, not the folder above it.
  for (const decoy of [path.join(dataDir, "decoy-login-token"), path.join(dir, "decoy-outside")]) {
    const read = await run(`cat '${decoy}'`);
    assert.equal(read.outcome, "failed", read.output);
    assert.equal(read.output.includes(DECOY), false);
  }
  // No network: only loopback, and a connection attempt fails, with whichever tool the image has.
  const net = await run("ls /sys/class/net");
  assert.equal(net.output.trim(), "lo");
  const reach = await run("if command -v wget >/dev/null; then wget -q -T 5 -O- http://1.1.1.1/; elif command -v curl >/dev/null; then curl -s -m 5 http://1.1.1.1/; elif command -v node >/dev/null; then node -e \"require('http').get('http://1.1.1.1/',()=>process.exit(0)).on('error',()=>process.exit(1))\"; else exit 1; fi");
  assert.equal(reach.outcome, "failed", reach.output);

  // Botbench commits on this Mac: both files are on the task's branch, owned by the owner.
  assert.equal(fs.statSync(path.join(copy, "agent.txt")).uid, process.getuid!());
  await commitWork({ path: copy, message: "Botbench task: container" });
  assert.equal(git(repo, "show", `${worktree.branch}:agent.txt`).trim(), "it's here");
  assert.equal(git(repo, "show", `${worktree.branch}:check.txt`).trim(), "from-check");

  // At start, a container whose mount lies in this data folder and whose task is not live (here: no such task) is
  // removed, even when the workbench has been renamed since it was made.
  const db = openStore(dataDir);
  t.after(() => db.close());
  const containers = createContainers({ db, home: dataDir, workbench: () => "renamed-since", docker: DOCKER });
  await containers.sweep();
  assert.notEqual((await runDocker(DOCKER!, ["inspect", c.name], 20_000)).code, 0, "the container is gone");
});

test("an image that is not on this Mac is refused before anything runs, and is not pulled", { skip, timeout: 60_000 }, async (t) => {
  const dir = fs.realpathSync(tempDir("botbench-live-container-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n" });
  const dataDir = path.join(dir, "home");
  fs.mkdirSync(dataDir);
  const taskId = 900_000 + Math.floor(Math.random() * 99_999);
  const worktree = await createWorktree({ repo, home: dataDir, run: "run-1", task: `task-${taskId}`, workbench: "live" });
  const absent = `botbench-test-no-such-image:${taskId}`;
  const started = await startTaskContainer({ workbench: "live", taskId, image: absent, mount: fs.realpathSync(worktree.path), dataDir, allowedHosts: [], docker: DOCKER! });
  assert.equal(started.ok, false);
  assert.match(started.ok ? "" : started.why, /is not on this Mac, and Botbench never downloads one/);
  assert.notEqual((await runDocker(DOCKER!, ["image", "inspect", absent], 20_000)).code, 0, "nothing was pulled");
  assert.notEqual((await runDocker(DOCKER!, ["inspect", `botbench-live-task-${taskId}`], 20_000)).code, 0, "no container was made");
});

// The real Claude Code on its cheapest model, through Botbench's HTTP API, building a task of a repository set to run in
// a container: every shell call the agent makes is answered by Botbench's permission check, rewritten there, and run in
// the task's container (a Linux kernel, the copy mounted, nothing else of this Mac); the file it writes lands in the
// task's changes; and a decision removes the container. Skipped with the rest when Docker or the image is absent.
const JSON_TYPE = { "content-type": "application/json" };
type Call = Extract<DriverEvent, { type: "tool_call" }>;
type Result = Extract<DriverEvent, { type: "tool_result" }>;

test("live: a real Claude Code builder's shell commands run in the task's container, rewritten by the permission answer, and the container is removed when the task is decided", { skip, timeout: 300_000 }, async (t) => {
  const dir = fs.realpathSync(tempDir("botbench-live-container-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "inside.txt": "INSIDE-OK\n" });
  const decoy = path.join(dir, "decoy-outside.txt");
  fs.writeFileSync(decoy, `${DECOY}\n`);
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": { model: "haiku" } }, roles: { implementer: { driver: "claude-code" } }, repositories: { [repo]: { execution: { kind: "container", image: IMAGE } } } };
  const server = await startServer({ config, home, signInDelayMs: 1 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const token = fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim();
  const signIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token }) });
  assert.equal(signIn.status, 200);
  await signIn.arrayBuffer();
  const headers = { cookie: signIn.headers.getSetCookie()[0]!.split(";")[0]! };
  const getJson = async <B>(route: string): Promise<B> => (await (await fetch(`${base}${route}`, { headers })).json()) as B;

  const commands = { kernel: "uname -s > kernel.txt; cat kernel.txt inside.txt", decoy: `cat ${decoy}`, net: "ls /sys/class/net" };
  const prompt = `This is a test of where commands run. Run each of these three shell commands with your Bash tool, one Bash call per command, exactly as written, in this order, each exactly once. Do not change, combine, retry or skip any of them, even when one fails.\n${Object.values(commands).map((c, i) => `${i + 1}. ${c}`).join("\n")}\nThen reply with the single word: done`;
  const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: JSON.stringify({ repo, prompt }) });
  const { taskId } = (await res.json()) as { taskId: number };
  assert.equal(res.status, 200);
  let task: { status: string; reason: string | null; attemptId: number | null; files: { path: string; status: string }[] | null };
  const deadline = Date.now() + 240_000;
  for (;;) {
    task = await getJson(`/api/tasks/${taskId}`);
    if (task.status !== "queued" && task.status !== "building") break;
    for (const approval of (await getJson<{ approvals: { id: number }[] }>("/api/approvals?status=pending")).approvals) {
      const answer = await fetch(`${base}/api/approvals/${approval.id}`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: JSON.stringify({ decision: "allow" }) });
      assert.equal(answer.status, 200, await answer.text());
    }
    if (Date.now() > deadline) assert.fail("timed out waiting for the task to end");
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(task.status, "awaiting_decision", task.reason ?? "");
  const events = (await getJson<{ events: StoredEvent[] }>(`/api/attempts/${task.attemptId}/events`)).events.map((e) => e.payload);
  const resultOf = (marker: string): Result => {
    const call = events.find((e): e is Call => e.type === "tool_call" && e.name === "Bash" && JSON.stringify(e.input).includes(marker));
    assert.ok(call, `a shell call holds ${marker}`);
    const resolved = events.findIndex((e) => e.type === "permission_resolved" && e.toolCallId === call.id && e.decision !== "denied" && e.decision !== "declined");
    const ranAt = events.findIndex((e) => e.type === "tool_result" && e.id === call.id);
    assert.ok(resolved >= 0 && resolved < ranAt, `answered by Botbench's permission check before it ran: ${JSON.stringify(call.input)}`);
    return events[ranAt] as Result;
  };
  // In the container: a Linux kernel, the copy at its own path, the file written there.
  assert.match(resultOf("uname -s").output, /Linux\nINSIDE-OK/);
  // Outside the mount there is nothing: the decoy beside the repository is not there to read.
  assert.equal(JSON.stringify(events).includes(DECOY), false, "the decoy reached the transcript");
  assert.match(resultOf(decoy).output, /No such file or directory/);
  assert.equal(resultOf("/sys/class/net").output.trim(), "lo");
  assert.deepEqual(task.files!.map((f) => [f.path, f.status]), [["kernel.txt", "added"]]);
  assert.equal((await runDocker(DOCKER!, ["ps", "-q", "--filter", `label=botbench.task=${taskId}`, "--filter", `label=botbench.mount`], 20_000)).stdout.trim() !== "", true, "the task's container is running while the task waits");

  const rejected = await fetch(`${base}/api/tasks/${taskId}/reject`, { method: "POST", headers: { ...headers, ...JSON_TYPE }, body: JSON.stringify({ branch: "discard" }) });
  assert.equal(rejected.status, 200, await rejected.text());
  const gone = Date.now() + 30_000;
  for (;;) {
    const mine = (await runDocker(DOCKER!, ["ps", "-a", "--filter", "label=botbench.workbench", "--format", '{{.Label "botbench.mount"}}'], 20_000)).stdout.split("\n").filter((m) => m.startsWith(fs.realpathSync(home)));
    if (mine.length === 0) break;
    assert.ok(Date.now() < gone, `the container is removed once the task is rejected: ${mine.join(", ")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});
