import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bothPaths, HOME_SECRETS, MOVED_SIGN_INS } from "./confinement.ts";

/*
 * Where a repository's commands run (U28, ADR 0009): the execution environment, one of two kinds, set per repository
 * in the settings file as `"execution": { "kind": "host" }` or `{ "kind": "container", "image": "node:24" }`.
 * - host (the default): on this Mac, confined as src/confinement.ts says (U27). Nothing here changes it.
 * - container: in one Docker container per task, started before the task's setup from an image already on this Mac,
 *   with the task's copy as its one mount and no network. The agent CLI stays on this Mac under the owner's own
 *   sign-in; each shell command it is allowed to run is rewritten into `docker exec … sh -c '<command>'` in the
 *   permission answer (src/drivers/claude-code.ts), and the setup and check commands Botbench runs itself go through
 *   `docker exec` too (src/engine/stations.ts). Botbench commits on this Mac, as for the host kind.
 * Nothing falls back: a container that cannot be started as described here is a task that does not start.
 *
 * Adapted, not copied (ADR 0009): the hardening flags and the inspect of what the container really got after it started,
 * from OpenMausBot's server/container-isolation.ts (`dockerSecurityIsHardened`); probing the network rule from inside the
 * container instead of assuming it, from rakazo's infra/sandboxes/supervisor/src/egress-probe.ts; one sweep that owns
 * removing what is left, run at start and after each change of a task, from paperclip's orphan sandbox sweep
 * (server/src/index.ts).
 */

export type Execution = { kind: "host" } | { kind: "container"; image: string };
export const HOST_EXECUTION: Execution = { kind: "host" };
const EXECUTION_SETTINGS = ["kind", "image"] as const;
/** An image reference as Docker takes it: a name with its registry, tag or digest. Never one that reads as a flag. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

/**
 * What is wrong with a repository's "execution", as a sentence that names the setting, or null. `allowedHosts` is the
 * same repository's list: a container reaches no network, and Botbench cannot prove that one reaches only its proxy.
 */
export function executionProblem(value: unknown, allowedHosts: unknown): string | null {
  const kinds = '"host" (commands run on this Mac, kept away from your sign-ins and the network; the default) or "container" (they run in a Docker container of an image you name)';
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `"execution" must be an object with a "kind": ${kinds}.`;
  const entry = value as Record<string, unknown>;
  const unknown = Object.keys(entry).find((key) => !(EXECUTION_SETTINGS as readonly string[]).includes(key));
  if (unknown !== undefined) return `"execution" has unknown setting "${unknown}". Known settings: ${EXECUTION_SETTINGS.join(", ")}.`;
  if (entry.kind === undefined) return `"execution" needs a "kind": ${kinds}.`;
  if (entry.kind !== "host" && entry.kind !== "container") return `"execution.kind" is ${JSON.stringify(entry.kind)}, which Botbench does not know. It is ${kinds}.`;
  if (entry.kind === "host") return entry.image === undefined ? null : '"execution.image" is only for "kind": "container". Remove it, or set "kind" to "container".';
  if (entry.image === undefined || entry.image === "") return '"execution" is "container" with no "image": name the Docker image, already on this Mac, that the task\'s commands run in, such as "node:24". Botbench never downloads an image, and does not run the commands on this Mac instead.';
  if (typeof entry.image !== "string" || !IMAGE.test(entry.image)) return `"execution.image" must be a Docker image name such as "node:24" or "ghcr.io/owner/tools:1.2": letters, digits and . _ / : @ -, starting with a letter or digit.`;
  if (Array.isArray(allowedHosts) && allowedHosts.length > 0) return '"execution" is "container" and "allowedHosts" names hosts. A container\'s commands reach no network, and Botbench cannot yet prove that a container reaches only its own proxy to those hosts, so it does not start one. Remove "allowedHosts", or set "kind" to "host".';
  return null;
}

/**
 * Where one task's commands run in a container: its name, its id, the folder they start in (the task's copy) and the
 * docker program. Commands go to it by its id, the one Botbench proved after the start, never by its name: a container
 * made under the same name later (after this one was removed) is not this one.
 */
export interface TaskContainer {
  name: string;
  id: string;
  workdir: string;
  docker: string;
}

/**
 * The name of a task's container: botbench-<workbench>-<data>-task-<id>, where <data> is the first 8 hex digits of the
 * SHA-256 of the data folder's real path. Task ids are counted per data folder, and an owner may run more than one
 * Botbench under the same workbench name (a second data folder for trying a change): without <data> their task 7s would
 * want the same name, and the second could not start. A workbench name is already one Docker accepts.
 */
export const containerName = (workbench: string, dataDir: string, taskId: number): string => `botbench-${workbench}-${dataDigest(dataDir)}-task-${taskId}`;
const dataDigest = (dataDir: string): string => createHash("sha256").update(bothPaths(dataDir).at(-1)!).digest("hex").slice(0, 8);
/** What Docker gives as a container's id. */
const CONTAINER_ID = /^[0-9a-f]{64}$/;

export const LABEL_WORKBENCH = "botbench.workbench";
export const LABEL_TASK = "botbench.task";
/** What was mounted, so a sweep removes only containers of copies in this data folder. */
export const LABEL_MOUNT = "botbench.mount";

/** The PATH a container's commands get: the usual system folders and nothing of this Mac's. */
export const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const CONTAINER_LIMITS = { pids: 1024, memory: "4g", cpus: "2" } as const;
/** `--memory 4g` as Docker records it. */
const MEMORY_BYTES = 4 * 1024 ** 3;

/** A word for a POSIX shell, in single quotes: nothing in it is read by the shell. */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

const within = (place: string, folder: string): boolean => place === folder || place.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`);

/**
 * Why a container may not be started with `source` (a task's copy, links resolved) as its mount, in words for the
 * owner, or null. Refused: a path a mount spec cannot hold; the home folder or a folder that holds it; a place that is,
 * holds or lies inside ~/.ssh, ~/Library, a vendor sign-in folder (moved ones included) or another secret place of
 * src/confinement.ts; Botbench's data folder or a folder that holds it; and anything else but one task's copy in the
 * data folder (`<data>/worktrees/<run>/<task>`).
 */
export function mountProblem(source: string, o: { dataDir: string; home?: string; env?: NodeJS.ProcessEnv }): string | null {
  const refuse = (why: string): string => `Botbench does not start a container with ${source} in it: ${why} Nothing ran on this Mac instead.`;
  if (!path.isAbsolute(source) || /[\0-\x1f,"]/.test(source)) return refuse("the path holds a comma, a quote or a control character, which a Docker mount cannot take as written.");
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const homes = bothPaths(home);
  if (homes.some((h) => within(h, source))) return refuse("it is your home folder, or a folder that holds it.");
  const moved = MOVED_SIGN_INS.map((name) => env[name]).filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
  const secrets = [".ssh", "Library", ...HOME_SECRETS].map((place) => path.join(home, place));
  for (const secret of [...secrets, ...moved].flatMap(bothPaths)) {
    if (within(source, secret) || within(secret, source)) return refuse(`it is, holds or lies inside ${secret}, a place with your keys, sign-ins or settings.`);
  }
  const data = bothPaths(o.dataDir);
  if (data.some((d) => within(d, source))) return refuse("it is Botbench's data folder, or a folder that holds it.");
  const copy = data.some((d) => {
    const parts = path.relative(path.join(d, "worktrees"), source).split(path.sep);
    return parts.length === 2 && parts.every((part) => part !== "" && part !== "." && part !== "..");
  });
  if (!copy) return refuse("it is not a task's separate copy in Botbench's data folder.");
  return null;
}

/**
 * The arguments of `docker run` for a task's container: detached, never pulling, named and labelled, every capability
 * dropped, no new privileges, limits on processes, memory and CPU, private IPC and cgroup namespaces, no network, the
 * owner's own user and group ids, exactly one bind mount (the task's copy, read-write, at the same path) as its working
 * folder, an environment of HOME and PATH only, and `sleep infinity` from the owner's image as the one thing it runs.
 */
export function containerRunArgs(o: { name: string; workbench: string; taskId: number; image: string; mount: string; uid: number; gid: number }): string[] {
  return [
    "run", "-d", "--pull", "never",
    "--name", o.name,
    "--label", `${LABEL_WORKBENCH}=${o.workbench}`,
    "--label", `${LABEL_TASK}=${o.taskId}`,
    "--label", `${LABEL_MOUNT}=${o.mount}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(CONTAINER_LIMITS.pids),
    "--memory", CONTAINER_LIMITS.memory,
    "--cpus", CONTAINER_LIMITS.cpus,
    "--ipc", "private",
    "--cgroupns", "private",
    "--network", "none",
    "--user", `${o.uid}:${o.gid}`,
    "--mount", `type=bind,source=${o.mount},target=${o.mount}`,
    "--workdir", o.mount,
    "--env", "HOME=/tmp",
    "--env", `PATH=${CONTAINER_PATH}`,
    // `env -i` execs `sleep`: the container's first process has HOME and PATH only, not the image's own ENV lines.
    "--entrypoint", "env",
    o.image, "-i", "HOME=/tmp", `PATH=${CONTAINER_PATH}`, "sleep", "infinity",
  ];
}

/**
 * What every command runs under in the container: `env -i` and only HOME and PATH, so neither this Mac's environment
 * nor the image's own `ENV` lines reach it.
 */
const CLEAN_ENV = ["env", "-i", "HOME=/tmp", `PATH=${CONTAINER_PATH}`] as const;

/**
 * How Botbench runs one setup or check command in a task's container: argv, with no shell on this Mac between, to the
 * container by its id. `--` before the command: one that starts with "-" is a command, as it is on this Mac, never
 * options of the container's sh.
 */
export const containerExecArgv = (c: TaskContainer, command: string): string[] => [c.docker, "exec", "--workdir", c.workdir, c.id, ...CLEAN_ENV, "sh", "-c", "--", command];

/** One shell command line that runs `command` in a task's container: what the agent's allowed command becomes. */
export const containerCommand = (c: TaskContainer, command: string): string => containerExecArgv(c, command).map(shellQuote).join(" ");

/** The fields of a shell call that are kept when it is rewritten: what it is for, its time limit, and a background run (src/approvals/gate.ts CONFINED_SHELL_FIELDS). */
const KEPT_SHELL_FIELDS = ["description", "timeout", "run_in_background"] as const;

/**
 * The input an allowed shell call runs with in the container kind: the command rewritten into the task's container,
 * its description, time limit and background run kept, and the CLI's sandbox set aside for this one call
 * (`dangerouslyDisableSandbox`): the CLI's sandbox blocks the Docker socket, and the command it runs is this exact
 * docker exec and nothing else. Every other field the call carried is dropped, the agent's own
 * `dangerouslyDisableSandbox` among them. Null when the call holds no command to rewrite: it is then refused, never
 * run as it is.
 */
export function containerShellInput(c: TaskContainer, input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const given = input as Record<string, unknown>;
  if (typeof given.command !== "string" || given.command.trim() === "" || given.command.includes("\0")) return null;
  const kept = Object.fromEntries(KEPT_SHELL_FIELDS.filter((name) => given[name] !== undefined).map((name) => [name, given[name]]));
  return { ...kept, command: containerCommand(c, given.command), dangerouslyDisableSandbox: true };
}

/** What one docker call did. */
export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not be started at all. */
  error: string | null;
}

const MAX_DOCKER_OUTPUT = 64 * 1024;

/**
 * Run the docker program with `args`, in a process group of its own, and resolve with what it did. Never rejects. When
 * `limitMs` passes the whole group is killed (a docker CLI starts plugins and credential helpers of its own). It gets
 * this process's environment: it is the owner's own tool, as git and gh are, and nothing of it reaches a container,
 * whose environment is only what `containerRunArgs` names.
 */
export function runDocker(docker: string, args: readonly string[], limitMs: number): Promise<DockerResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const finish = (result: Omit<DockerResult, "stdout" | "stderr" | "timedOut">): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limitMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-MAX_DOCKER_OUTPUT)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-MAX_DOCKER_OUTPUT)));
    child.on("error", (err) => finish({ code: null, error: err.message }));
    child.on("close", (code) => {
      kill();
      finish({ code, error: null });
    });
  });
}

/** What a failed docker call said, shortened, for a sentence. */
const said = (r: DockerResult): string => {
  const text = (r.error ?? (r.stderr.trim() || r.stdout.trim())).replace(/\s+/g, " ");
  return text === "" ? `it ended with exit code ${r.code ?? "none"}` : `it said: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
};

/** The docker program on `PATH` as a full path, or null when there is none. */
export function findDocker(pathVariable: string | undefined = process.env.PATH): string | null {
  for (const folder of (pathVariable ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(folder)) continue;
    const candidate = path.join(folder, "docker");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

export const DOCKER_ANSWER_MS = 10_000;
const NOT_INSTEAD = "Nothing ran on this Mac instead.";

/** Why Docker cannot be used now, in words for the owner, or null when `docker info` answered with a server version within 10 seconds. */
export async function dockerProblem(docker: string, limitMs = DOCKER_ANSWER_MS): Promise<string | null> {
  const r = await runDocker(docker, ["info", "--format", "{{.ServerVersion}}"], limitMs);
  if (r.timedOut) return `Docker did not answer within ${Math.round(limitMs / 1000)} seconds (docker info), so Botbench did not start this task's container. Start Docker and start the task again, or set this repository's "execution" to "host". ${NOT_INSTEAD}`;
  if (r.code !== 0 || r.stdout.trim() === "") return `Docker did not answer (docker info: ${said(r)}), so Botbench did not start this task's container. Start Docker and start the task again, or set this repository's "execution" to "host". ${NOT_INSTEAD}`;
  return null;
}

/**
 * What is wrong with a running container's own record (`docker inspect` of it, as JSON) against what Botbench asked
 * for, or null. Read after the start, so a runtime that dropped a flag does not go unnoticed (OpenMausBot's
 * `dockerSecurityIsHardened`): no network, every capability dropped, no new privileges, private IPC and cgroup
 * namespaces, not privileged, a process limit, and one mount only, the task's copy, read-write at the same path.
 */
export function hardeningProblem(inspected: unknown, mount: string, expected?: { image: string; imageId: string; uid: number; gid: number }): string | null {
  const record = Array.isArray(inspected) ? inspected[0] : inspected;
  if (typeof record !== "object" || record === null) return "Docker gave no record of the container.";
  const host = (record as { HostConfig?: Record<string, unknown> }).HostConfig ?? {};
  const config = (record as { Config?: Record<string, unknown> }).Config ?? {};
  if (expected !== undefined) {
    if (config.Image !== expected.image) return `it runs the image ${JSON.stringify(config.Image ?? null)}, not ${expected.image}.`;
    // By the image's id, not only its name: a name moved to another image since the container started does not count.
    if ((record as { Image?: unknown }).Image !== expected.imageId) return `it was started from another image than ${expected.image} is now (${String((record as { Image?: unknown }).Image ?? "none")}, not ${expected.imageId}).`;
    if (config.User !== `${expected.uid}:${expected.gid}`) return `it runs as ${JSON.stringify(config.User ?? null)}, not your user and group ${expected.uid}:${expected.gid}.`;
  }
  if (host.Memory !== MEMORY_BYTES) return `its memory limit is ${JSON.stringify(host.Memory ?? null)}, not ${CONTAINER_LIMITS.memory}.`;
  if (host.NanoCpus !== Number(CONTAINER_LIMITS.cpus) * 1e9) return `its CPU limit is ${JSON.stringify(host.NanoCpus ?? null)}, not ${CONTAINER_LIMITS.cpus} CPUs.`;
  const mounts = (record as { Mounts?: unknown }).Mounts;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : []);
  if (host.NetworkMode !== "none") return `its network is ${JSON.stringify(host.NetworkMode ?? null)}, not none.`;
  if (!list(host.CapDrop).includes("all")) return "not every capability was dropped.";
  if (list(host.CapAdd).length > 0) return "it was given capabilities back.";
  if (!list(host.SecurityOpt).some((opt) => /^no-new-privileges(?:[:=]true)?$/.test(opt))) return "it may gain new privileges.";
  if (host.Privileged !== false) return "it is privileged.";
  if (host.IpcMode !== "private") return `its IPC namespace is ${JSON.stringify(host.IpcMode ?? null)}, not private.`;
  if (host.CgroupnsMode !== "private") return `its cgroup namespace is ${JSON.stringify(host.CgroupnsMode ?? null)}, not private.`;
  if (host.PidsLimit !== CONTAINER_LIMITS.pids) return `its process limit is ${JSON.stringify(host.PidsLimit ?? null)}, not ${CONTAINER_LIMITS.pids}.`;
  if (!Array.isArray(mounts) || mounts.length !== 1) return `it has ${Array.isArray(mounts) ? mounts.length : "no record of its"} mounts, not exactly one.`;
  const only = mounts[0] as Record<string, unknown>;
  if (only.Type !== "bind" || only.Destination !== mount || only.RW !== true || only.Source !== mount) return `its one mount is not the task's copy, read-write, at ${mount}.`;
  return null;
}

/** Whether what `ls /sys/class/net` printed in the container shows the loopback interface and no other. */
export const onlyLoopback = (listing: string): boolean => {
  const names = listing.split(/\s+/).filter((name) => name !== "");
  return names.length === 1 && names[0] === "lo";
};

export type ContainerStart = { ok: true; container: TaskContainer } | { ok: false; why: string };

export interface StartContainerOptions {
  workbench: string;
  taskId: number;
  image: string;
  /** The task's copy, links resolved: the one mount and the working folder. */
  mount: string;
  dataDir: string;
  /** The hosts the task's commands may reach. Any at all is refused: a container's commands reach no network. */
  allowedHosts: readonly string[];
  /** The docker program; found on PATH when left out. */
  docker?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
}

const START_MS = 60_000;
const STEP_MS = 20_000;

/**
 * Start a task's container, or find it running as it was started, and prove it is what `containerRunArgs` asks for.
 * Refused, with why, before anything runs: hosts allowed, a mount `mountProblem` refuses, no docker program, Docker
 * not answering, the image not on this Mac (it is never pulled). After the start, refused and removed again: a record
 * `hardeningProblem` refuses, or a network that is not loopback only, looked at from inside. Never falls back to this Mac.
 */
export async function startTaskContainer(o: StartContainerOptions): Promise<ContainerStart> {
  const refuse = (why: string): ContainerStart => ({ ok: false, why });
  if (o.allowedHosts.length > 0) return refuse(`This repository's commands run in a container, which reaches no network, and this task may reach ${o.allowedHosts.join(", ")}. Botbench cannot prove that a container reaches only its own proxy to those hosts, so it did not start one. ${NOT_INSTEAD}`);
  const mount = mountProblem(o.mount, { dataDir: o.dataDir, ...(o.home === undefined ? {} : { home: o.home }), ...(o.env === undefined ? {} : { env: o.env }) });
  if (mount !== null) return refuse(mount);
  const docker = o.docker ?? findDocker(o.env?.PATH);
  if (docker === null) return refuse(`This repository's commands run in a Docker container, and no docker program was found on this Mac. Install Docker, or set this repository's "execution" to "host". ${NOT_INSTEAD}`);
  const down = await dockerProblem(docker);
  if (down !== null) return refuse(down);
  const image = await runDocker(docker, ["image", "inspect", "--format", "{{.Id}}", o.image], STEP_MS);
  if (image.code !== 0) return refuse(`The image ${o.image} is not on this Mac, and Botbench never downloads one. Run docker pull ${o.image} yourself, then start the task again. ${NOT_INSTEAD}`);
  // The copy at its own real path, as Docker would resolve it: a link on the way to it would mount what it points at.
  let real: string | null = null;
  try {
    real = fs.realpathSync(o.mount);
  } catch {
    // Gone: refused below.
  }
  if (real !== o.mount) return refuse(`Botbench does not start a container with ${o.mount} in it: ${real === null ? "it is not there." : `it is not its own real path (a link on the way leads to ${real}).`} ${NOT_INSTEAD}`);
  const name = containerName(o.workbench, o.dataDir, o.taskId);
  const uid = o.uid ?? process.getuid?.() ?? -1;
  const gid = o.gid ?? process.getgid?.() ?? -1;
  if (uid < 0 || gid < 0) return refuse(`Botbench could not read your user and group ids, which the container runs as. ${NOT_INSTEAD}`);
  // The container of this name held to what was asked: its id, or why not.
  const proven = async (): Promise<{ id: string } | { problem: string }> => {
    const inspected = await runDocker(docker, ["inspect", "--type", "container", name], STEP_MS);
    const no = (problem: string) => ({ problem });
    if (inspected.code !== 0) return no(`Docker could not say what the container got (docker inspect: ${said(inspected)}).`);
    let record: unknown;
    try {
      record = JSON.parse(inspected.stdout);
    } catch {
      return no("Docker's record of the container could not be read.");
    }
    const state = (Array.isArray(record) ? record[0] : record) as { Id?: unknown; State?: { Running?: unknown }; Config?: { Labels?: Record<string, unknown> } } | undefined;
    const id = typeof state?.Id === "string" && CONTAINER_ID.test(state.Id) ? state.Id : null;
    if (id === null) return no("Docker gave the container no id.");
    if (state?.State?.Running !== true) return no("the container is not running.");
    if (state.Config?.Labels?.[LABEL_MOUNT] !== o.mount) return no("the container was made for another folder.");
    const hardened = hardeningProblem(record, o.mount, { image: o.image, imageId: image.stdout.trim(), uid, gid });
    if (hardened !== null) return no(hardened);
    // Probed, not assumed: from inside, the container has the loopback interface and nothing else to reach anything by.
    const net = await runDocker(docker, ["exec", id, "sh", "-c", "ls /sys/class/net"], STEP_MS);
    if (net.code !== 0) return no(`Botbench could not look at the container's network from inside (${said(net)}).`);
    if (!onlyLoopback(net.stdout)) return no(`the container has network interfaces besides loopback (${net.stdout.trim().replace(/\s+/g, ", ")}).`);
    return { id };
  };
  const ready = (id: string): ContainerStart => ({ ok: true, container: { name, id, workdir: o.mount, docker } });
  // The id of the container of this name and what it records as mounted, or null when there is none.
  const foundNow = async (): Promise<{ id: string; mount: string } | null> => {
    const r = await runDocker(docker, ["inspect", "--type", "container", "--format", `{{.Id}}\t{{index .Config.Labels "${LABEL_MOUNT}"}}`, name], STEP_MS);
    if (r.code !== 0) return null;
    const [id = "", mount = ""] = r.stdout.trim().split("\t");
    return { id, mount };
  };
  // Removed only when the container of this name is this task's (its mount label is this copy), and by the id that look
  // found, not by name: one another process made under the same name meanwhile is left alone.
  const removeOurs = async (): Promise<void> => {
    const found = await foundNow();
    if (found !== null && found.mount === o.mount && CONTAINER_ID.test(found.id)) await removeContainer(docker, found.id);
  };
  // A container left running from before (a restart) is used again only when it is still exactly what was asked for.
  // One made for another folder (another Botbench with the same workbench name) is not this task's: it is left alone.
  const existing = (await foundNow())?.mount ?? null;
  if (existing !== null) {
    if (existing !== o.mount) return refuse(`A container named ${name} already exists for another folder (${existing || "none recorded"}), and Botbench does not remove what is not this task's. Remove it with docker rm -f ${name} if it is not in use, then start the task again. ${NOT_INSTEAD}`);
    const again = await proven();
    if ("id" in again) return ready(again.id);
    await removeOurs();
  }
  const started = await runDocker(docker, containerRunArgs({ name, workbench: o.workbench, taskId: o.taskId, image: o.image, mount: o.mount, uid, gid }), START_MS);
  if (started.code !== 0) {
    await removeOurs();
    return refuse(`Docker did not start this task's container (docker run: ${said(started)}). ${NOT_INSTEAD}`);
  }
  const checked = await proven();
  if ("problem" in checked) {
    await removeOurs();
    return refuse(`Botbench removed this task's container again and did not start the task: ${checked.problem} ${NOT_INSTEAD}`);
  }
  return ready(checked.id);
}

/** Remove a container, whatever state it is in. Resolves with what Docker said when it could not. */
export async function removeContainer(docker: string, name: string): Promise<string | null> {
  const r = await runDocker(docker, ["rm", "-f", name], STEP_MS);
  return r.code === 0 || /no such container/i.test(r.stderr) ? null : said(r);
}

/**
 * After a setup or check command in a container has ended, whatever it left running there goes with it, as on this
 * Mac its process group does: every process of the container's user but the container's own first one.
 */
export const stopLeftovers = (c: TaskContainer): Promise<DockerResult> => runDocker(c.docker, ["exec", c.id, "sh", "-c", "kill -9 -1 2>/dev/null; true"], STEP_MS);

/**
 * The containers carrying Botbench's workbench label, whatever workbench name it holds (a workbench may have been renamed
 * since): each one's name, task id and what was mounted. Which are this Botbench's is decided by the mount, which lies in
 * its own data folder (`mountedFrom`). Null when Docker could not list them.
 */
export async function labelledContainers(docker: string): Promise<{ id: string; name: string; taskId: number | null; mount: string }[] | null> {
  const r = await runDocker(docker, ["ps", "-a", "--no-trunc", "--filter", `label=${LABEL_WORKBENCH}`, "--format", `{{.ID}}\t{{.Names}}\t{{.Label "${LABEL_TASK}"}}\t{{.Label "${LABEL_MOUNT}"}}`], DOCKER_ANSWER_MS);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const [id = "", name = "", task = "", mount = ""] = line.split("\t");
    return { id, name, taskId: /^[1-9]\d{0,14}$/.test(task) ? Number(task) : null, mount };
  }).filter((c) => CONTAINER_ID.test(c.id));
}

/** Whether `mount`, as a container's label records it, lies in `dataDir`: only such a container is this Botbench's to remove. */
export const mountedFrom = (mount: string, dataDir: string): boolean => bothPaths(dataDir).some((d) => mount !== d && within(mount, d));
