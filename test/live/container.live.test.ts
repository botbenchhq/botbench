import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContainers } from "../../src/engine/containers.ts";
import { runCommand } from "../../src/engine/stations.ts";
import { containerCommand, dockerProblem, findDocker, runDocker, startTaskContainer, type TaskContainer } from "../../src/execution.ts";
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

  // At start, a container of this workbench and data folder whose task is not live (here: no such task) is removed.
  const db = openStore(dataDir);
  t.after(() => db.close());
  const containers = createContainers({ db, home: dataDir, workbench: () => "live", docker: DOCKER });
  await containers.sweep();
  assert.notEqual((await runDocker(DOCKER!, ["inspect", c.name], 20_000)).code, 0, "the container is gone");
});
