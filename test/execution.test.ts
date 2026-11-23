import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gate } from "../src/approvals/gate.ts";
import { CODEX_BUILD_CAPABILITIES, CodexDriver } from "../src/drivers/codex.ts";
import { builderContainerProblem } from "../src/engine/containers.ts";
import { ClaudeCodeDriver } from "../src/drivers/claude-code.ts";
import { QUESTION_TOOL } from "../src/approvals/question.ts";
import { loadConfig, repositoryExecution } from "../src/config.ts";
import { claudeArgs, controlAnswer } from "../src/drivers/claude-code.ts";
import { containerCommand, containerExecArgv, containerName, containerRunArgs, containerShellInput, CONTAINER_PATH, dockerProblem, hardeningProblem, mountedFrom, mountProblem, onlyLoopback, startTaskContainer, type TaskContainer } from "../src/execution.ts";
import { launchFingerprint } from "./support/launch-fingerprint.ts";
import { bannedIn } from "../e2e/voice.ts";
import { EXECUTION_ABOUT, executionWords, NO_REPOSITORIES } from "../web/src/app/execution-words.ts";

// Where a repository's commands run (U28, ADR 0009): the setting, the host kind left exactly as it was, and the
// container kind's run arguments, refusals and command rewrite, each at the lowest layer that can prove it. Docker
// itself is in test/live/container.live.test.ts; the children here are sh and system programs.

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = { port: 4780, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: { implementer: { driver: "claude-code" } } };

function load(t: { after(fn: () => void): void }, repositories: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-execution-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "botbench.config.json");
  fs.writeFileSync(file, JSON.stringify({ ...BASE, repositories }));
  return () => loadConfig({ defaults: file });
}

test("execution: host when absent, host or container with an image when set; an unknown kind or key, a container without an image, and a container with allowed hosts are refused in plain words", (t) => {
  const config = load(t, { "/r/a": { execution: { kind: "host" } }, "/r/b": { execution: { kind: "container", image: "node:24" } }, "/r/c": { setup: ["npm ci"] } })();
  assert.deepEqual(repositoryExecution(config, "/r/a"), { kind: "host" });
  assert.deepEqual(repositoryExecution(config, "/r/b"), { kind: "container", image: "node:24" });
  assert.deepEqual(repositoryExecution(config, "/r/c"), { kind: "host" }, "absent is host");
  assert.deepEqual(repositoryExecution(config, "/elsewhere"), { kind: "host" });
  const refused = (execution: unknown, extra: Record<string, unknown> = {}): string => {
    try {
      load(t, { "/r/x": { ...extra, execution } })();
    } catch (err) {
      return (err as Error).message;
    }
    return assert.fail(`not refused: ${JSON.stringify(execution)}`);
  };
  assert.match(refused({ kind: "vm" }), /repository "\/r\/x": "execution\.kind" is "vm", which Botbench does not know\. It is "host" .* or "container"/);
  assert.match(refused({ kind: "container", image: "node:24", network: "bridge" }), /"execution" has unknown setting "network"\. Known settings: kind, image\./);
  assert.match(refused({}), /"execution" needs a "kind"/);
  assert.match(refused("container"), /"execution" must be an object with a "kind"/);
  assert.match(refused({ kind: "container" }), /"execution" is "container" with no "image": name the Docker image, already on this Mac, .* Botbench never downloads an image, and does not run the commands on this Mac instead\./);
  assert.match(refused({ kind: "container", image: "" }), /with no "image"/);
  assert.match(refused({ kind: "container", image: "--privileged" }), /"execution\.image" must be a Docker image name/);
  assert.match(refused({ kind: "host", image: "node:24" }), /"execution\.image" is only for "kind": "container"/);
  assert.match(refused({ kind: "container", image: "node:24" }, { allowedHosts: ["registry.npmjs.org"] }), /"execution" is "container" and "allowedHosts" names hosts\. .* Botbench cannot yet prove that a container reaches only its own proxy to those hosts, so it does not start one\./);
  // The repository's other settings say which are known, the new one among them.
  assert.match(refused({ kind: "host" }, { exec: 1 }), /unknown setting "exec"\. Known settings: .*execution/);
});

test("with the host kind, the agent's launch settings and the setup and check argv are byte for byte what they were before the container kind", async (t) => {
  // The digest was taken with this same function from the code before this change (git archive of origin/main at 803e1f9).
  const BEFORE = "bb63ed7d2e689e4b5dcf50aee77c9264c19fa0721428f29a6cc0afca3c147e90";
  const saved = Object.fromEntries(["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"].map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  process.env.HOME = "/nonexistent-home/owner";
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) delete process.env[name];
  const now = await launchFingerprint(ROOT);
  assert.equal(now.digest, BEFORE);
  // Not hollow: the settings really are in what was hashed.
  assert.match(now.normalized, /allowUnsandboxedCommands\\":false/);
  assert.match(now.normalized, /sandbox-exec/);
});

test("in the container kind the launch settings differ in one thing: allowUnsandboxedCommands, for the one rewritten call; still no allow rule for Bash and no auto-allow", () => {
  const place = { cwd: "/nonexistent-data/botbench/worktrees/run-1/task-1", dataDir: "/nonexistent-data/botbench", allowedHosts: [] as string[] };
  const settingsOf = (args: string[]): Record<string, any> => JSON.parse(args[args.indexOf("--settings") + 1]!);
  const host = claudeArgs({ confinement: place, allowEdits: true, gated: true });
  const container = claudeArgs({ confinement: place, allowEdits: true, gated: true, container: true });
  const i = host.indexOf("--settings");
  assert.deepEqual([...container.slice(0, i + 1), ...container.slice(i + 2)], [...host.slice(0, i + 1), ...host.slice(i + 2)], "every other argument is the same");
  const expected = settingsOf(host);
  expected.sandbox.allowUnsandboxedCommands = true;
  assert.deepEqual(settingsOf(container), expected);
  const s = settingsOf(container);
  assert.deepEqual(s.permissions, { ask: ["Bash"], blockReadsOutsideWorkingDirectories: true }, "every Bash call asks; no allow rule");
  assert.equal(s.sandbox.autoAllowBashIfSandboxed, false);
  assert.equal(s.sandbox.excludedCommands, undefined, "no command is excluded from the sandbox by a standing pattern");
  assert.equal(container[container.indexOf("--allowedTools") + 1], "Edit(./**)", "no Bash rule among the allowed tools");
  assert.throws(() => claudeArgs({ confinement: place, allowEdits: true, container: true }), /only through Botbench's permission check/);
});

const CLEAN = ["env", "-i", "HOME=/tmp", `PATH=${CONTAINER_PATH}`];
const C: TaskContainer = { name: "botbench-studio-0a1b2c3d-task-7", id: "e".repeat(64), workdir: "/Users/o/.botbench/worktrees/run-3/task-7", docker: "/usr/local/bin/docker" };

/** The words a real sh makes of a command line. */
function shellWords(line: string): string[] {
  const r = spawnSync("/bin/sh", ["-c", 'eval "set -- $1"; for a in "$@"; do printf "%s\\0" "$a"; done', "sh", line], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\0").slice(0, -1);
}

test("an allowed command is rewritten into docker exec … sh -c '<command>', and a real sh reads back exactly the original, quotes and newlines included", () => {
  const commands = ["npm test", "echo 'it''s' \"$HOME\" `id` $(whoami)", "printf '%s\\n' a b\ncat <<'EOF'\nline 'one'\nEOF", "a=1; b='x'\"'\"'y'; echo \\$a", "'", "\\'\\\\", "ends with newline\n", "-c 'touch /tmp/x'", "--help", "-x"];
  for (const command of commands) {
    const line = containerCommand(C, command);
    // To the container by its id, and after `--`: a command that starts with "-" is not read as the container sh's options.
    assert.deepEqual(shellWords(line), [C.docker, "exec", "--workdir", C.workdir, C.id, ...CLEAN, "sh", "-c", "--", command], JSON.stringify(command));
  }
  assert.equal(containerCommand(C, "npm test"), `'/usr/local/bin/docker' 'exec' '--workdir' '/Users/o/.botbench/worktrees/run-3/task-7' '${C.id}' 'env' '-i' 'HOME=/tmp' 'PATH=${CONTAINER_PATH}' 'sh' '-c' '--' 'npm test'`);
  // A real sh given `-c -- <command>` runs a command named "-x", as this Mac's shell would, and takes no option from it.
  const dashed = spawnSync("/bin/sh", ["-c", "--", "-x"], { encoding: "utf8" });
  assert.equal(dashed.status, 127, dashed.stderr);
  // What the inner sh then runs is the original: the same output as running it directly.
  const original = "printf '%s|' \"a b\" 'c'\"'\"'d'\necho done";
  const inner = shellWords(containerCommand(C, original)).at(-1)!;
  assert.equal(spawnSync("/bin/sh", ["-c", inner], { encoding: "utf8" }).stdout, spawnSync("/bin/sh", ["-c", original], { encoding: "utf8" }).stdout);
  // Setup and check commands go as argv, with no shell on this Mac between; both start from an empty environment
  // (`env -i`), so neither this Mac's variables nor the image's own ENV lines reach the command.
  assert.deepEqual(containerExecArgv(C, "npm ci && npm test"), [C.docker, "exec", "--workdir", C.workdir, C.id, ...CLEAN, "sh", "-c", "--", "npm ci && npm test"]);
  const env = spawnSync("/usr/bin/env", ["-i", ...CLEAN.slice(2), "/bin/sh", "-c", "env"], { encoding: "utf8", env: { ...process.env, FROM_THE_IMAGE: "1" } });
  assert.deepEqual(env.stdout.split("\n").filter((line) => line !== "" && !line.startsWith("PWD=") && !line.startsWith("SHLVL=") && !line.startsWith("_=")).sort(), ["HOME=/tmp", `PATH=${CONTAINER_PATH}`], "env -i leaves only HOME and PATH");
});

test("the rewritten input keeps the description, time limit and background run, sets the sandbox aside for this exact call only, and drops the agent's own fields", () => {
  const input = { command: "npm test", description: "Run the tests", timeout: 60_000, run_in_background: true, dangerouslyDisableSandbox: false, other: "x" };
  assert.deepEqual(containerShellInput(C, input), { description: "Run the tests", timeout: 60_000, run_in_background: true, command: containerCommand(C, "npm test"), dangerouslyDisableSandbox: true });
  for (const bad of [null, "npm test", {}, { command: "" }, { command: "  " }, { command: 3 }, { command: "a\0b" }]) assert.equal(containerShellInput(C, bad), null, JSON.stringify(bad));
});

test("the permission answer rewrites only an allowed Bash call; a refused or declined call is never rewritten or run; on the host the input goes back as it was", () => {
  const request = { name: "Bash", input: { command: "git push origin main" } };
  // The safety rules judge the command as the agent asked it: here they ask, and a fully autonomous run refuses it.
  const verdict = gate({ tool: "Bash", input: request.input, worktree: C.workdir, cwd: C.workdir, mode: "full", confined: true });
  assert.equal(verdict.verdict, "refuse");
  const refused = controlAnswer(request, { decision: "decline", refused: "On the always-ask list." }, C);
  assert.deepEqual(refused.reply, { behavior: "deny", message: "Botbench's permission check denied this request without asking the owner: On the always-ask list. Nothing was run." });
  assert.equal(refused.decision, "denied");
  assert.equal(JSON.stringify(refused).includes("docker"), false, "nothing of a refusal is rewritten");
  const declined = controlAnswer(request, { decision: "decline", note: "not now" }, C);
  assert.equal(declined.reply.behavior, "deny");
  assert.equal(JSON.stringify(declined).includes("docker"), false);
  assert.equal(controlAnswer(request, { decision: "allowed" }, C).reply.behavior, "deny", "only the exact word allows");

  const allowed = controlAnswer({ name: "Bash", input: { command: "npm test" } }, { decision: "allow", mode: true }, C);
  assert.deepEqual(allowed, { reply: { behavior: "allow", updatedInput: { command: containerCommand(C, "npm test"), dangerouslyDisableSandbox: true } }, decision: "mode", note: null });
  const edit = { name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } };
  assert.deepEqual(controlAnswer(edit, { decision: "allow", files: true }, C).reply, { behavior: "allow", updatedInput: edit.input }, "a file tool runs on this Mac, in the same copy");
  // The sandbox escape is open in the container kind for Botbench's own rewritten call only: any other tool carrying
  // it is refused, even when allowed, and on the host kind the CLI ignores it (allowUnsandboxedCommands is false).
  for (const name of ["Monitor", "PowerShell", "bash", "Skill"]) {
    const escaped = controlAnswer({ name, input: { command: "id", dangerouslyDisableSandbox: true } }, { decision: "allow" }, C);
    assert.equal(escaped.reply.behavior, "deny", name);
    assert.equal(escaped.decision, "denied", name);
    assert.match(escaped.note!, /asks to run outside Claude Code's sandbox/);
  }
  // A question (the CLI's AskUserQuestion) runs nothing: in the container kind it reaches the owner and the owner's answer
  // goes back as on the host, never refused by the container's guards, even if it carried the sandbox escape.
  const ask = { name: QUESTION_TOOL, input: { questions: [{ question: "Which file?", options: [{ label: "a.ts" }, { label: "b.ts" }] }] } };
  for (const input of [ask.input, { ...ask.input, dangerouslyDisableSandbox: true }]) {
    const answered = controlAnswer({ name: QUESTION_TOOL, input }, { decision: "allow", answers: { "Which file?": "b.ts" } }, C);
    assert.equal(answered.decision, "answered");
    assert.deepEqual(answered.reply, { behavior: "allow", updatedInput: { ...input, answers: { "Which file?": "b.ts" } } });
    assert.deepEqual(controlAnswer({ name: QUESTION_TOOL, input }, { decision: "allow", answers: { "Which file?": "b.ts" } }), answered, "the same as on the host");
  }
  assert.equal(gate({ tool: QUESTION_TOOL, input: ask.input, worktree: C.workdir, cwd: C.workdir, mode: "manual", confined: true }).verdict === "refuse", false, "the gate does not refuse a question");
  const empty = controlAnswer({ name: "Bash", input: {} }, { decision: "allow" }, C);
  assert.equal(empty.reply.behavior, "deny");
  assert.equal(empty.decision, "denied");
  const host = controlAnswer({ name: "Bash", input: { command: "npm test", timeout: 5 } }, { decision: "allow" });
  assert.deepEqual(host.reply, { behavior: "allow", updatedInput: { command: "npm test", timeout: 5 } });
});

test("docker run: detached, never pulling, named and labelled, hardened, no network, the owner's ids, one bind mount of the copy at the same path as its working folder, HOME and PATH only, sleep infinity", () => {
  const mount = "/Users/o/.botbench/worktrees/run-3/task-7";
  const name = containerName("studio", "/nonexistent-data/one", 7);
  const args = containerRunArgs({ name, workbench: "studio", taskId: 7, image: "node:24", mount, uid: 501, gid: 20 });
  // Named for the workbench, the data folder and the task: two Botbench data folders under one workbench name do not
  // want the same name for their task 7.
  assert.match(name, /^botbench-studio-[0-9a-f]{8}-task-7$/);
  assert.equal(containerName("studio", "/nonexistent-data/one", 7), name);
  assert.notEqual(containerName("studio", "/nonexistent-data/two", 7), name);
  assert.deepEqual(args.slice(0, 4), ["run", "-d", "--pull", "never"]);
  const pairs = (flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
  assert.deepEqual(pairs("--name"), [name]);
  assert.deepEqual(pairs("--label"), ["botbench.workbench=studio", "botbench.task=7", `botbench.mount=${mount}`]);
  assert.deepEqual(pairs("--cap-drop"), ["ALL"]);
  assert.deepEqual(pairs("--security-opt"), ["no-new-privileges"]);
  for (const flag of ["--pids-limit", "--memory", "--cpus"]) assert.equal(pairs(flag).length, 1, flag);
  assert.deepEqual([pairs("--ipc"), pairs("--cgroupns"), pairs("--network")], [["private"], ["private"], ["none"]]);
  assert.deepEqual(pairs("--user"), ["501:20"]);
  assert.deepEqual(pairs("--mount"), [`type=bind,source=${mount},target=${mount}`], "exactly one mount");
  assert.deepEqual(pairs("--workdir"), [mount]);
  assert.deepEqual(pairs("--env"), ["HOME=/tmp", `PATH=${CONTAINER_PATH}`], "an environment built from scratch");
  // The first process is `sleep infinity`, exec'd by `env -i`, so not even the image's ENV lines are on it.
  assert.deepEqual(args.slice(-8), ["--entrypoint", "env", "node:24", "-i", "HOME=/tmp", `PATH=${CONTAINER_PATH}`, "sleep", "infinity"]);
  for (const flag of ["-v", "--volume", "--privileged", "--cap-add", "--env-file", "-e", "--pull=always", "--network=host", "--pid", "--userns"]) assert.equal(args.includes(flag), false, flag);
  assert.equal(args.some((a) => /docker\.sock|\.ssh|\.claude|\.codex|Library/.test(a)), false, "no socket, key or sign-in folder");
});

test("a container is refused for a mount that is, holds or lies inside the home folder root, ~/.ssh, ~/Library, a sign-in folder or the data folder, and for anything but a task's copy", () => {
  const home = "/nonexistent-home/owner";
  const dataDir = `${home}/.botbench`;
  const copy = `${dataDir}/worktrees/run-3/task-7`;
  const o = { home, dataDir, env: { CODEX_HOME: "/nonexistent-elsewhere/codex" } };
  assert.equal(mountProblem(copy, o), null);
  const cases: [string, RegExp][] = [
    [home, /it is your home folder, or a folder that holds it\./],
    ["/nonexistent-home", /your home folder, or a folder that holds it/],
    ["/", /your home folder, or a folder that holds it/],
    [`${home}/.ssh`, /lies inside \/nonexistent-home\/owner\/\.ssh/],
    [`${home}/.ssh/keys`, /\.ssh, a place with your keys/],
    [`${home}/Library`, /owner\/Library,/],
    [`${home}/Library/Application Support/Botbench/worktrees/run-1/task-1`, /owner\/Library,/],
    [`${home}/.claude`, /\.claude/],
    [`${home}/.codex/sessions`, /\.codex/],
    [`${home}/.config`, /holds or lies inside .*\.config\/(gcloud|gh|git|op|configstore)/],
    ["/nonexistent-elsewhere", /\/nonexistent-elsewhere\/codex/],
    [dataDir, /Botbench's data folder, or a folder that holds it/],
    [`${dataDir}/worktrees`, /not a task's separate copy/],
    [`${dataDir}/worktrees/run-3`, /not a task's separate copy/],
    [`${dataDir}/memory`, /not a task's separate copy/],
    [`${dataDir}/worktrees/run-3/task-7/sub`, /not a task's separate copy/],
    ["/nonexistent-other/project", /not a task's separate copy/],
    [`${dataDir}/worktrees/run-3/task,7`, /a comma, a quote or a control character/],
    ["relative/path", /a comma, a quote or a control character/],
  ];
  for (const [source, why] of cases) {
    const problem = mountProblem(source, o);
    assert.ok(problem !== null, source);
    assert.match(problem, why, source);
    assert.match(problem, /^Botbench does not start a container with .* Nothing ran on this Mac instead\.$/);
  }
  // Only a container mounted from this data folder is this Botbench's to sweep.
  assert.equal(mountedFrom(copy, dataDir), true);
  assert.equal(mountedFrom("/nonexistent-home/owner/.botbench-dev3/worktrees/run-1/task-1", dataDir), false);
  assert.equal(mountedFrom(dataDir, dataDir), false);
});

test("Docker not answering is refused in plain words: a failure, no answer within the limit (the program is killed), and no program at all", async () => {
  const failed = await dockerProblem("/usr/bin/false");
  assert.match(failed!, /^Docker did not answer \(docker info: it ended with exit code 1\), so Botbench did not start this task's container\. Start Docker and start the task again, or set this repository's "execution" to "host"\. Nothing ran on this Mac instead\.$/);
  // `yes` never ends by itself: a real program that does not answer in time. It writes as fast as it can, so it is
  // given a short limit: the suite's timing-sensitive tests run beside this one.
  const began = Date.now();
  const late = await dockerProblem("/usr/bin/yes", 100);
  assert.match(late!, /^Docker did not answer within 0 seconds \(docker info\)/);
  assert.ok(Date.now() - began < 5000, "it was stopped at its limit");
  assert.match((await dockerProblem("/nonexistent/docker"))!, /^Docker did not answer \(docker info: it said: spawn \/nonexistent\/docker ENOENT\)/);
  assert.equal(await dockerProblem("/bin/echo"), null, "a program that answers with a version, as docker info --format does");
});

test("starting a task's container is refused, before anything runs and with no fallback, for allowed hosts, a refused mount, no docker program, and Docker not answering", async () => {
  const home = "/nonexistent-home/owner";
  const base = { workbench: "studio", taskId: 7, image: "node:24", mount: `${home}/.botbench/worktrees/run-3/task-7`, dataDir: `${home}/.botbench`, allowedHosts: [] as string[], home, env: {} };
  const hosts = await startTaskContainer({ ...base, allowedHosts: ["registry.npmjs.org"], docker: "/usr/bin/false" });
  assert.deepEqual(hosts, { ok: false, why: "This repository's commands run in a container, which reaches no network, and this task may reach registry.npmjs.org. Botbench cannot prove that a container reaches only its own proxy to those hosts, so it did not start one. Nothing ran on this Mac instead." });
  const mount = await startTaskContainer({ ...base, mount: `${home}/.ssh`, docker: "/usr/bin/false" });
  assert.equal(mount.ok, false);
  assert.match(mount.ok ? "" : mount.why, /\.ssh/);
  const none = await startTaskContainer({ ...base, env: { PATH: "" } });
  assert.match(none.ok ? "" : none.why, /no docker program was found on this Mac\. Install Docker, or set this repository's "execution" to "host"\. Nothing ran on this Mac instead\./);
  const down = await startTaskContainer({ ...base, docker: "/usr/bin/false" });
  assert.match(down.ok ? "" : down.why, /^Docker did not answer \(docker info/);
});

test("a copy reached through a link, or gone, is refused before docker run: what is mounted is the copy's own real path", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-execution-link-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "data");
  const elsewhere = path.join(dir, "elsewhere");
  fs.mkdirSync(path.join(elsewhere, "run-3", "task-7"), { recursive: true });
  fs.mkdirSync(dataDir);
  // The data folder's worktrees folder is a link to another place: by name the copy is inside the data folder.
  fs.symlinkSync(elsewhere, path.join(dataDir, "worktrees"));
  const mount = path.join(dataDir, "worktrees", "run-3", "task-7");
  assert.equal(mountProblem(mount, { dataDir, home: "/nonexistent-home/owner", env: {} }), null, "by name alone it looks like a copy");
  // /bin/echo answers `docker info` and `docker image inspect` with a line, as Docker would: the next step is the mount.
  const base = { workbench: "studio", taskId: 7, image: "node:24", dataDir, allowedHosts: [] as string[], home: "/nonexistent-home/owner", env: {}, docker: "/bin/echo" };
  const linked = await startTaskContainer({ ...base, mount });
  assert.deepEqual(linked, { ok: false, why: `Botbench does not start a container with ${mount} in it: it is not its own real path (a link on the way leads to ${path.join(elsewhere, "run-3", "task-7")}). Nothing ran on this Mac instead.` });
  const gone = await startTaskContainer({ ...base, mount: path.join(dataDir, "worktrees", "run-3", "task-8") });
  assert.match(gone.ok ? "" : gone.why, /it is not there\. Nothing ran on this Mac instead\.$/);
});

test("a started container is held to what was asked, from its own record and from inside: anything else is refused", () => {
  const mount = "/Users/o/.botbench/worktrees/run-3/task-7";
  // The shape `docker inspect` gives (Docker 28, OrbStack), with only the fields read here.
  const good = [{ Image: "sha256:aaa", Config: { Image: "node:24", User: "501:20" }, HostConfig: { NetworkMode: "none", CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], Privileged: false, IpcMode: "private", CgroupnsMode: "private", PidsLimit: 1024, Memory: 4294967296, NanoCpus: 2000000000 }, Mounts: [{ Type: "bind", Source: mount, Destination: mount, RW: true }] }];
  const asked = { image: "node:24", imageId: "sha256:aaa", uid: 501, gid: 20 };
  // The name node:24 now leads to another image than the container was started from: it is not used again.
  assert.match(hardeningProblem(good, mount, { ...asked, imageId: "sha256:bbb" })!, /started from another image than node:24 is now \(sha256:aaa, not sha256:bbb\)/);
  assert.equal(hardeningProblem(good, mount, asked), null);
  // Before a container is used again: its image, user and limits are the ones asked for.
  assert.match(hardeningProblem([{ ...good[0], Config: { Image: "alpine:3", User: "501:20" } }], mount, asked)!, /image "alpine:3", not node:24/);
  assert.match(hardeningProblem([{ ...good[0], Config: { Image: "node:24", User: "" } }], mount, asked)!, /runs as "", not your user and group 501:20/);
  const changed = (host: Record<string, unknown>, mounts?: unknown[]) => [{ ...good[0], HostConfig: { ...good[0]!.HostConfig, ...host }, Mounts: mounts ?? good[0]!.Mounts }];
  assert.match(hardeningProblem(changed({ Memory: 0 }), mount)!, /memory limit is 0, not 4g/);
  assert.match(hardeningProblem(changed({ NanoCpus: 0 }), mount)!, /CPU limit is 0, not 2 CPUs/);
  assert.match(hardeningProblem(changed({}, [{ ...good[0]!.Mounts[0], Source: `/elsewhere${mount}` }]), mount)!, /not the task's copy/, "the source is the copy itself, not a path ending like it");
  assert.match(hardeningProblem(changed({ NetworkMode: "bridge" }), mount)!, /network is "bridge", not none/);
  assert.match(hardeningProblem(changed({ CapDrop: [] }), mount)!, /not every capability/);
  assert.match(hardeningProblem(changed({ CapAdd: ["NET_ADMIN"] }), mount)!, /capabilities back/);
  assert.match(hardeningProblem(changed({ SecurityOpt: [] }), mount)!, /new privileges/);
  assert.match(hardeningProblem(changed({ Privileged: true }), mount)!, /privileged/);
  assert.match(hardeningProblem(changed({ IpcMode: "host" }), mount)!, /IPC/);
  assert.match(hardeningProblem(changed({ CgroupnsMode: "host" }), mount)!, /cgroup/);
  assert.match(hardeningProblem(changed({ PidsLimit: 0 }), mount)!, /process limit is 0, not 1024/);
  assert.match(hardeningProblem(changed({}, [...good[0]!.Mounts, { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }]), mount)!, /2 mounts, not exactly one/);
  assert.match(hardeningProblem(changed({}, [{ ...good[0]!.Mounts[0], RW: false }]), mount)!, /not the task's copy, read-write/);
  assert.match(hardeningProblem([], mount)!, /no record/);
  assert.equal(onlyLoopback("lo\n"), true);
  assert.equal(onlyLoopback("eth0\nlo\n"), false);
  assert.equal(onlyLoopback(""), false);
});

test("Settings says where each repository's commands run, the default as on this Mac kept away from sign-ins and the network, in the words of docs/product/voice.md", () => {
  assert.deepEqual(executionWords({ kind: "host" }), { kind: "On this Mac", about: "On this Mac, kept away from your sign-ins and the network, in the task's separate copy." });
  const container = executionWords({ kind: "container", image: "node:24" });
  assert.equal(container.kind, "In a container");
  assert.match(container.about, /^In a Docker container of the image node:24, one for each task, with only the task's separate copy in it and no network\./);
  for (const words of [EXECUTION_ABOUT, NO_REPOSITORIES, container.kind, container.about, executionWords({ kind: "host" }).about]) assert.deepEqual(bannedIn(words), [], words);
});

test("a container task is built only by a builder whose shell commands Botbench can rewrite into it: Claude Code yes, Codex (which runs its own commands) no, with why", () => {
  // The task's own builder decides, not the workbench's default: a task built by Codex would otherwise be handed the
  // container and run its commands on this Mac.
  assert.equal(builderContainerProblem({ kind: "host" }, { name: "codex", capabilities: CODEX_BUILD_CAPABILITIES }), null, "the host kind needs nothing");
  assert.equal(builderContainerProblem({ kind: "container", image: "node:24" }, { name: "claude-code", capabilities: new ClaudeCodeDriver().capabilities }), null);
  const codex = builderContainerProblem({ kind: "container", image: "node:24" }, { name: "codex", capabilities: CODEX_BUILD_CAPABILITIES });
  assert.match(codex ?? "", /^This repository's commands run in a container, and Codex cannot have its commands run there\. Build it with Claude Code, or set the repository's "execution" to "host"\. Nothing ran on this Mac instead\.$/);
});

test("Codex handed a task's container refuses to start rather than run the task's commands on this Mac", async () => {
  const place = { cwd: "/nonexistent-data/botbench/worktrees/run-1/task-1", dataDir: "/nonexistent-data/botbench", allowedHosts: [] as string[] };
  // Refused before anything is started: no database, no program, nothing on this Mac is touched.
  await assert.rejects(new CodexDriver().startAttempt({ db: null as never, cwd: place.cwd, allowEdits: true, gate: { socketPath: "/nonexistent-socket", secret: "x" }, confinement: place, container: C }), /This repository's commands run in a container, and Codex cannot have its commands run there\..* Nothing ran on this Mac instead\./);
});
