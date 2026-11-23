import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./store/atomic.ts";
import { now } from "./store/db.ts";

/*
 * Updating Botbench to a published release, by pulling, never by a push to this machine (docs/adr/0010).
 *
 * The check: at most every few hours, one unauthenticated GET of this repository's latest GitHub Release from
 * api.github.com, nothing else. It sends no token, no cookie and nothing about the owner; the request names only the
 * repository and a fixed user agent.
 *
 * The update, on the owner's tap or by itself when the owner chose that in Settings:
 *   1. It waits until no task is building and no chat is answering, so no work is interrupted (restart recovery would
 *      retry a turn once; waiting needs no retry).
 *   2. The installation's own checkout (the server's working directory) must be clean (`git status` lists nothing) and
 *      on `main`; otherwise it refuses and changes nothing.
 *   3. It fetches the release's tag and the repository's `main` from GitHub, over HTTPS, with no credential helper,
 *      into a ref of its own (refs/botbench-update/main) and the tag. The tag's commit must be on that `main`, must be a
 *      fast-forward of the checkout's commit, and its package.json must name the release's version.
 *   4. The tag's commit, exactly as committed (`git archive`), is unpacked into a folder in the data folder, installed
 *      from its lockfiles (`npm ci` at the root and in web/) and its client built. Then that build is started on a free
 *      loopback port with an empty, temporary data folder and an empty settings file: it must start, serve the client,
 *      sign in with the login token it made, answer /health and say it is the release's version. An empty data folder,
 *      not a copy of the owner's: the new build's restart recovery on a copy would see the owner's recorded processes and
 *      claims and could stop the first or release the second, outside the copy. Nothing of the owner's is reachable.
 *      Then the new build's store code alone (no server) opens a copy of the owner's database, so its migrations are
 *      proven on the real data too. Both folders are removed afterwards.
 *   5. Only then does the checkout move: `git merge --ff-only` to the tag's commit, then the same install and build
 *      there. If that install or build fails, the checkout goes back to the commit it was on (`git reset --keep`, which
 *      keeps any file it would lose) and is installed and built again, and the update says so. Nothing else ever moves
 *      the checkout back, and nothing ever forces.
 *   6. It records what it did (update.json in the data folder) and restarts through launchd
 *      (`launchctl kickstart -k gui/<uid>/<label>`) when that service exists, after waiting once more for work to
 *      finish; otherwise it says that a restart is needed. The next start reads the record, checks the checkout is on
 *      the release's commit, and sends the phone one notification: "Botbench updated to <version>".
 * Nothing from a Release is run but the repository's own committed files and the packages its lockfiles name.
 */

export const RELEASES_URL = "https://api.github.com/repos/jon-lange/botbench/releases/latest";
export const GIT_URL = "https://github.com/jon-lange/botbench.git";
/** The launchd label of the login service that runs an installation as a service (a LaunchAgent the owner made). */
export const SERVICE_LABEL = "dev.botbench.server";
export const CHECK_EVERY_MS = 6 * 3600_000;
export const UPDATE_DIR = "update";
export const JOURNAL_FILE = "update.json";
/** The owner's database as it was just before the checkout last moved, for going back by hand (threat model, open item 14). */
export const BACKUP_FILE = "before-update.sqlite";
const RELEASE_REF = "refs/botbench-update/main";
const BUSY_POLL_MS = 15_000;
const STEP_TIMEOUT_MS = 10 * 60_000;
const HEALTH_TIMEOUT_MS = 60_000;

export type UpdateMode = "tap" | "auto";
export const isUpdateMode = (v: unknown): v is UpdateMode => v === "tap" || v === "auto";

export function updateMode(db: DatabaseSync): UpdateMode {
  const stored = db.prepare("SELECT value FROM owner_settings WHERE name = 'update_mode'").get()?.value;
  return isUpdateMode(stored) ? stored : "tap";
}

export function setUpdateMode(db: DatabaseSync, mode: UpdateMode): void {
  db.prepare("INSERT INTO owner_settings (name, value, updated_at) VALUES ('update_mode', ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(mode, now());
}

/** A release version, `X.Y.Z` with an optional `v`; null for anything else, a prerelease included. */
export function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `latest` is a later release than `current`. Anything that is not a plain release version is never newer. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/**
 * A release's notes in one short line: the changelog's first items, without their links, issue numbers and commit
 * hashes. The notes are the repository's text, shown as text; nothing in them is followed.
 */
export function releaseSummary(body: string, max = 200): string {
  const plain = (line: string): string =>
    line
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\s*\((?:#\d+|[0-9a-f]{7,40})\)/g, "")
      .replace(/\*\*([^*]*)\*\*/g, "$1")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const lines = body.split(/\r?\n/);
  const items = lines.filter((l) => /^\s*[*-]\s+/.test(l)).map((l) => plain(l.replace(/^\s*[*-]\s+/, ""))).filter((l) => l !== "");
  const text = items.length > 0 ? items.join("; ") : plain(lines.find((l) => l.trim() !== "" && !/^\s*#/.test(l)) ?? "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface Release {
  version: string;
  tag: string;
  summary: string;
  url: string | null;
}

/** The latest published release, as GitHub's API gives it; null when the repository has none yet. */
export async function latestRelease(url: string, fetchFn: typeof fetch = fetch): Promise<Release | null> {
  const res = await fetchFn(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "botbench-update-check", "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return (await res.arrayBuffer(), null);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  const release = (await res.json()) as { tag_name?: unknown; body?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof release.tag_name !== "string" || parseVersion(release.tag_name) === null || !release.tag_name.startsWith("v")) throw new Error("GitHub's latest release has no tag of the form vX.Y.Z.");
  if (release.draft === true || release.prerelease === true) return null;
  return {
    version: release.tag_name.slice(1),
    tag: release.tag_name,
    summary: typeof release.body === "string" ? releaseSummary(release.body) : "",
    url: typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/") ? release.html_url : null,
  };
}

/** The version a checkout's package.json names. */
export function checkoutVersion(dir: string): string {
  const version = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error(`${path.join(dir, "package.json")} names no version.`);
  return version;
}

/** Why an update did not go ahead. Nothing was changed when it is thrown before the checkout moved. */
export class UpdateRefused extends Error {}

/** An environment for git, npm and the build check: only what they need, nothing of the owner's keys or tokens. */
function stepEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

function run(cmd: string, args: string[], cwd: string, timeout = STEP_TIMEOUT_MS, label = [cmd, ...args].join(" ")): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: stepEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }), timeout, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) return resolve(stdout);
      const said = `${stderr}\n${stdout}`.trim().split("\n").slice(-6).join("\n");
      reject(new Error(`${label} failed${said ? `: ${said}` : `: ${err.message}`}`));
    });
  });
}

/** git in the checkout, with no credential helper: a public repository is read with nothing of the owner's. */
const git = (dir: string, ...args: string[]): Promise<string> => run("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-C", dir, ...args], dir);

async function ancestor(dir: string, a: string, b: string): Promise<boolean> {
  try {
    await git(dir, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything that is checked before anything changes: the checkout is clean and on main, the tag is fetched, its
 * commit is on GitHub's main, is a fast-forward of the checkout and names the release's version. Returns the commit
 * the checkout is on and the tag's commit. Throws UpdateRefused, having changed nothing but the fetched refs.
 */
export async function preflight(dir: string, release: { tag: string; version: string }, gitUrl: string): Promise<{ previous: string; target: string }> {
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag) || release.tag.slice(1) !== release.version) throw new UpdateRefused(`${release.tag} is not a release tag of the form vX.Y.Z.`);
  let status: string;
  try {
    status = await git(dir, "status", "--porcelain");
  } catch (err) {
    throw new UpdateRefused(`${dir} is not a git checkout Botbench can update. ${err instanceof Error ? err.message : String(err)}`);
  }
  if (status.trim() !== "") throw new UpdateRefused(`The installation in ${dir} has changes that are not committed, so it was not updated. Commit or remove them, then update again.`);
  const branch = (await git(dir, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")).trim();
  if (branch !== "main") throw new UpdateRefused(`The installation in ${dir} is ${branch === "" ? "not on a branch" : `on the branch ${branch}`}, not main, so it was not updated. Switch it to main, then update again.`);
  const previous = (await git(dir, "rev-parse", "HEAD")).trim();
  try {
    await git(dir, "fetch", "--quiet", "--no-tags", gitUrl, `+refs/heads/main:${RELEASE_REF}`, `refs/tags/${release.tag}:refs/tags/${release.tag}`);
  } catch (err) {
    throw new UpdateRefused(`${release.tag} could not be fetched from ${gitUrl}, so nothing was changed. ${err instanceof Error ? err.message : String(err)}`);
  }
  const target = (await git(dir, "rev-parse", "--verify", `refs/tags/${release.tag}^{commit}`)).trim();
  if (!(await ancestor(dir, target, RELEASE_REF))) throw new UpdateRefused(`${release.tag} is not on main's history in ${gitUrl}, so it was not installed.`);
  if (target === previous) throw new UpdateRefused(`The installation is already on ${release.tag}.`);
  if (!(await ancestor(dir, previous, target))) throw new UpdateRefused(`${release.tag} does not follow the commit the installation is on (it would not be a fast-forward), so it was not installed. Nothing is ever reset or forced.`);
  const named = (JSON.parse(await git(dir, "show", `${target}:package.json`)) as { version?: unknown }).version;
  if (named !== release.version) throw new UpdateRefused(`${release.tag}'s package.json names version ${String(named)}, not ${release.version}, so it was not installed.`);
  return { previous, target };
}

/** The install and build of a checkout: the lockfiles' packages at the root and in web/, then the client. */
export const INSTALL_STEPS: readonly (readonly [string, readonly string[]])[] = [
  ["npm", ["ci", "--no-audit", "--no-fund"]],
  ["npm", ["ci", "--prefix", "web", "--no-audit", "--no-fund"]],
  ["npm", ["run", "build", "--prefix", "web"]],
];

export async function installAndBuild(dir: string): Promise<void> {
  for (const [cmd, args] of INSTALL_STEPS) await run(cmd, [...args], dir);
}

/** The tag's commit, exactly as committed, unpacked into `dest` (made empty first). */
export async function unpack(dir: string, commit: string, dest: string): Promise<void> {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const archive = spawn("git", ["-C", dir, "archive", "--format=tar", commit], { env: stepEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-f", "-", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    let said = "";
    archive.stderr.on("data", (c: Buffer) => (said += c.toString()));
    tar.stderr.on("data", (c: Buffer) => (said += c.toString()));
    archive.stdout.pipe(tar.stdin);
    let ended = 0;
    const done = (code: number | null): void => {
      if (code !== 0) return reject(new Error(`The release could not be unpacked: ${said.trim() || `exit ${code}`}`));
      if (++ended === 2) resolve();
    };
    archive.once("error", reject);
    tar.once("error", reject);
    archive.once("close", done);
    tar.once("close", done);
  });
}

/**
 * Start the build in `dir` as Botbench starts (`node src/server.ts`), with `home` as an empty data folder and an empty
 * settings file, on a free loopback port, and check that it answers as `version` should: the client, a sign-in with the
 * login token it made, /health and /api/update. Always stops it, and every process it started, before returning.
 */
export async function checkBuildStarts(dir: string, home: string, version: string): Promise<void> {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const settings = path.join(home, "..", "check-settings.json");
  fs.writeFileSync(settings, "{}\n", { mode: 0o600 });
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: dir,
    env: stepEnv({ BOTBENCH_HOME: home, BOTBENCH_PORT: "0", BOTBENCH_CONFIG: settings, BOTBENCH_UPDATES: "off" }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`it did not start within ${HEALTH_TIMEOUT_MS / 1000} seconds`)), HEALTH_TIMEOUT_MS);
      const onData = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-8000);
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (m) (clearTimeout(timer), resolve(Number(m[1])));
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", (err) => (clearTimeout(timer), reject(err)));
      child.once("exit", (code, signal) => (clearTimeout(timer), reject(new Error(`it stopped as it started (${signal ?? `exit ${code}`})`))));
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (route: string, headers: Record<string, string> = {}) => fetch(`${base}${route}`, { headers, signal: AbortSignal.timeout(10_000) });
    const shell = await get("/");
    const page = await shell.text();
    if (shell.status !== 200 || !/<html/i.test(page)) throw new Error(`its client did not load (${shell.status})`);
    const token = fs.readFileSync(path.join(home, "login-token"), "utf8").trim();
    const signIn = await fetch(`${base}/api/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(10_000) });
    await signIn.arrayBuffer();
    const cookie = signIn.headers.getSetCookie()[0]?.split(";")[0];
    if (signIn.status !== 200 || cookie === undefined) throw new Error(`it did not sign in (${signIn.status})`);
    const health = await get("/health", { cookie });
    const healthBody = (await health.json().catch(() => null)) as { status?: unknown } | null;
    if (health.status !== 200 || healthBody?.status !== "ok") throw new Error(`its health check did not answer ok (${health.status})`);
    const about = await get("/api/update", { cookie });
    const aboutBody = (await about.json().catch(() => null)) as { version?: unknown } | null;
    if (about.status !== 200 || aboutBody?.version !== version) throw new Error(`it says it is version ${String(aboutBody?.version)}, not ${version}`);
  } catch (err) {
    const tail = output.trim().split("\n").slice(-6).join("\n");
    throw new Error(`The new version did not start properly: ${err instanceof Error ? err.message : String(err)}.${tail ? ` It said: ${tail}` : ""}`);
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const killer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 10_000);
      await exited;
      clearTimeout(killer);
    }
  }
}

/**
 * The new build's database migrations, run on a copy of the owner's database (`VACUUM INTO`, a consistent copy of the
 * live file) in `dir`, by the new build's own store code alone: no server starts, so nothing of restart recovery runs.
 * Proves the release opens the owner's real data before the checkout moves. The copy is removed by the caller.
 */
export async function checkMigrations(stage: string, db: DatabaseSync, dir: string): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  db.prepare("VACUUM INTO ?").run(path.join(dir, "botbench.sqlite"));
  fs.chmodSync(path.join(dir, "botbench.sqlite"), 0o600);
  const script = "try { const { openStore } = await import(process.argv[1]); openStore(process.argv[2]).close(); } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }";
  try {
    await run(process.execPath, ["--input-type=module", "-e", script, path.join(stage, "src", "store", "db.ts"), dir], stage, HEALTH_TIMEOUT_MS, "Opening it");
  } catch (err) {
    throw new Error(`The new version could not open a copy of your data. ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Move the checkout to `target` by fast-forward and install and build it there. If the install or build fails, the
 * checkout goes back to `previous` (`git reset --keep`, which refuses to lose a file) and is installed and built again.
 */
export async function switchCheckout(dir: string, previous: string, target: string, install: (dir: string) => Promise<void> = installAndBuild): Promise<void> {
  await git(dir, "merge", "--ff-only", "--quiet", target);
  try {
    await install(dir);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    try {
      await git(dir, "reset", "--keep", "--quiet", previous);
      await install(dir);
    } catch (back) {
      throw new Error(`The new version could not be installed (${why}), and going back to the previous version failed too: ${back instanceof Error ? back.message : String(back)}. Botbench keeps running the previous version until it restarts.`);
    }
    throw new Error(`The new version could not be installed, so the installation went back to the previous version. ${why}`);
  }
}

/** What update.json records: the update that ran, for the next start to confirm. */
export interface Journal {
  version: string;
  previous: string;
  target: string;
  at: string;
  /** `pending` until a start of Botbench on the target commit confirms it and notifies the phone. */
  state: "pending" | "done";
}

export function readJournal(home: string): Journal | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, JOURNAL_FILE), "utf8")) as Journal;
    return typeof j.version === "string" && typeof j.target === "string" && (j.state === "pending" || j.state === "done") ? j : null;
  } catch {
    return null;
  }
}

function writeJournal(home: string, journal: Journal): void {
  writeFileAtomic(path.join(home, JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`);
}

/** Whether launchd has the login service `label` in this user's session. */
function serviceExists(label: string): Promise<boolean> {
  if (process.platform !== "darwin" || process.getuid === undefined) return Promise.resolve(false);
  return run("launchctl", ["print", `gui/${process.getuid()}/${label}`], os.homedir(), 10_000).then(() => true, () => false);
}

export type UpdateStateKind = "idle" | "waiting" | "updating" | "failed" | "restart_needed" | "restarting" | "updated";

export interface UpdateState {
  kind: UpdateStateKind;
  /** The release the state is about; null when idle. */
  version: string | null;
  /** What is being done, or what went wrong and what to do; null when there is nothing to say. */
  message: string | null;
  at: string;
}

export interface UpdateStatus {
  version: string;
  /** Whether this Botbench looks for releases at all (off in tests and with BOTBENCH_UPDATES=off). */
  checking: boolean;
  checkedAt: string | null;
  checkProblem: string | null;
  latest: Release | null;
  available: boolean;
  mode: UpdateMode;
  state: UpdateState;
}

export interface UpdateOptions {
  /** GitHub's latest-release address for this repository. */
  releasesUrl: string;
  /** Where the release's tag and main are fetched from. */
  gitUrl: string;
  /** The launchd label to restart through. */
  serviceLabel: string;
  checkEveryMs?: number;
  fetch?: typeof fetch;
}

export interface Updates {
  status(): UpdateStatus;
  /** Look for a release now. Starts the update when it is newer and the owner chose to update automatically. */
  check(): Promise<void>;
  /** Start updating to the latest release, on the owner's tap. Throws UpdateRefused when there is none to update to. */
  start(): void;
  setMode(mode: UpdateMode): void;
  close(): Promise<void>;
}

export function createUpdates(o: {
  db: DatabaseSync;
  home: string;
  /** The installation's checkout: the server's working directory. */
  installDir: string;
  /** Whether any work would be interrupted by a restart now. */
  busy: () => boolean;
  /** The phone's one notification once the new version runs. */
  notifyUpdated: (version: string) => void;
  /** Null: this Botbench does not look for releases. */
  options: UpdateOptions | null;
  log?: (line: string) => void;
  /** How often waiting work is looked at again. */
  pollMs?: number;
}): Updates {
  const log = o.log ?? ((line: string) => console.log(line));
  const version = checkoutVersion(o.installDir);
  let latest: Release | null = null;
  let checkedAt: string | null = null;
  let checkProblem: string | null = null;
  let state: UpdateState = { kind: "idle", version: null, message: null, at: now() };
  let running: Promise<void> | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const wakers = new Set<() => void>();
  const set = (kind: UpdateStateKind, v: string | null, message: string | null = null): void => {
    state = { kind, version: v, message, at: now() };
  };
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const wake = (): void => (clearTimeout(t), wakers.delete(wake), resolve());
      const t = setTimeout(wake, ms);
      wakers.add(wake);
    });

  // The update a start before this one made: confirmed once this start runs on its commit, with one notification.
  const journal = readJournal(o.home);
  if (journal?.state === "pending") {
    void git(o.installDir, "rev-parse", "HEAD").then(
      (head) => {
        if (head.trim() === journal.target && version === journal.version) {
          writeJournal(o.home, { ...journal, state: "done" });
          set("updated", journal.version, `Updated to ${journal.version}.`);
          log(`Botbench updated to ${journal.version} (from commit ${journal.previous.slice(0, 12)}).`);
          o.notifyUpdated(journal.version);
        } else {
          writeJournal(o.home, { ...journal, state: "done" });
          set("failed", journal.version, `The update to ${journal.version} was not running after the restart: the installation is on another commit. Nothing more was changed.`);
        }
      },
      (err: unknown) => log(`The last update could not be confirmed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  const available = (): boolean => latest !== null && isNewerVersion(latest.version, version);

  /** Wait for no work to be under way; false when Botbench is closing. */
  const restingPoint = async (release: Release, words: string): Promise<boolean> => {
    while (!closed && o.busy()) {
      set("waiting", release.version, words);
      await sleep(o.pollMs ?? BUSY_POLL_MS);
    }
    return !closed;
  };

  const update = async (release: Release): Promise<void> => {
    if (!(await restingPoint(release, `Waiting for work to finish, then updating to ${release.version}.`))) return;
    set("updating", release.version, "Checking the release.");
    const { previous, target } = await preflight(o.installDir, release, o.options!.gitUrl);
    const work = path.join(o.home, UPDATE_DIR);
    const stage = path.join(work, "s");
    try {
      set("updating", release.version, "Installing and building the new version.");
      await unpack(o.installDir, target, stage);
      await installAndBuild(stage);
      set("updating", release.version, "Checking that the new version starts.");
      await checkBuildStarts(stage, path.join(work, "h"), release.version);
      await checkMigrations(stage, o.db, path.join(work, "m"));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    set("updating", release.version, "Installing the new version.");
    // The database as it is now, which the previous version can open, kept until the next update.
    const backup = path.join(o.home, BACKUP_FILE);
    fs.rmSync(backup, { force: true });
    o.db.prepare("VACUUM INTO ?").run(backup);
    fs.chmodSync(backup, 0o600);
    await switchCheckout(o.installDir, previous, target);
    writeJournal(o.home, { version: release.version, previous, target, at: now(), state: "pending" });
    log(`Botbench ${release.version} is installed in ${o.installDir} (commit ${target.slice(0, 12)}, from ${previous.slice(0, 12)}).`);
    if (!(await serviceExists(o.options!.serviceLabel))) {
      set("restart_needed", release.version, `${release.version} is installed. Restart Botbench to run it.`);
      return;
    }
    if (!(await restingPoint(release, `${release.version} is installed. Waiting for work to finish, then restarting.`))) return;
    set("restarting", release.version, `Restarting to run ${release.version}.`);
    // Detached: launchd stops this process (and its group) and starts the service again.
    spawn("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/${o.options!.serviceLabel}`], { detached: true, stdio: "ignore", env: stepEnv() }).unref();
  };

  const start = (): void => {
    if (running !== null) return;
    if (o.options === null) throw new UpdateRefused("This Botbench does not look for releases, so there is nothing to update to.");
    if (latest === null || !available()) throw new UpdateRefused("There is no newer release to update to.");
    if (state.kind === "restart_needed" || state.kind === "restarting") throw new UpdateRefused(state.message ?? "An update is already installed.");
    const release = latest;
    running = update(release)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`Updating to ${release.version} did not finish: ${message}`);
        set("failed", release.version, err instanceof UpdateRefused || /went back to the previous version/.test(message) ? message : `${message.replace(/[.\s]*$/, ".")} The installation stays on ${version}; nothing in it was changed.`);
      })
      .finally(() => (running = null));
  };

  const check = async (): Promise<void> => {
    if (o.options === null) return;
    try {
      latest = await latestRelease(o.options.releasesUrl, o.options.fetch);
      checkProblem = null;
    } catch (err) {
      checkProblem = err instanceof Error ? err.message : String(err);
    }
    checkedAt = now();
    if (available() && updateMode(o.db) === "auto" && (state.kind === "idle" || state.kind === "updated")) {
      try {
        start();
      } catch {}
    }
  };

  if (o.options !== null) {
    const every = o.options.checkEveryMs ?? CHECK_EVERY_MS;
    void check();
    const loop = (): void => {
      timer = setTimeout(() => void check().finally(() => !closed && loop()), every);
      timer.unref();
    };
    loop();
  }

  return {
    status: () => ({ version, checking: o.options !== null, checkedAt, checkProblem, latest, available: available(), mode: updateMode(o.db), state }),
    check,
    start,
    setMode: (mode) => {
      setUpdateMode(o.db, mode);
      if (mode === "auto" && available() && state.kind === "idle") {
        try {
          start();
        } catch {}
      }
    },
    close: async () => {
      closed = true;
      clearTimeout(timer);
      for (const wake of [...wakers]) wake();
      await running;
    },
  };
}
