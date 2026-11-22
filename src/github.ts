import { spawn } from "node:child_process";
import { gitEnv } from "./worktrees.ts";

/*
 * The gh tool (`gh`), as Botbench uses it to open a pull request for an accepted task. Botbench runs the owner's own
 * `gh` on this Mac, with the owner's own sign-in, which `gh` keeps and reads itself: Botbench never reads a token, never
 * puts one on a command line or in the environment, and reads nothing from `gh`'s files. Four commands are used, each
 * built here as an exact list of arguments (no shell), and each answer read here from what the real `gh` prints:
 *
 *   gh auth status --hostname=<host> --active --json=hosts       who is signed in on that host (the JSON holds no token)
 *   gh repo view <host/owner/name> --json=...                      the repository's default branch
 *   gh pr list --repo=... --head=<branch> --state=all --json=...   a pull request already open (or closed) for the branch
 *   gh pr create --repo=... --base=... --head=... --title=... --body-file=-   the body on standard input, never an argument
 *
 * Never `gh pr merge`, never `gh repo delete`, never anything that changes a branch.
 */

/** A repository on a host `gh` can open pull requests on. */
export interface RepoRef {
  host: string;
  owner: string;
  name: string;
}
export const repoName = (repo: RepoRef): string => `${repo.host}/${repo.owner}/${repo.name}`;

/** A pull request as `gh` reports it. */
export interface PullRequest {
  number: number;
  url: string;
  /** OPEN, CLOSED or MERGED, as `gh pr list` says; OPEN for one just created. */
  state: string;
}

/** What one run of `gh` printed and how it ended. `started` is false when `gh` could not be started at all. */
export interface GhResult {
  started: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}
export type RunGh = (args: readonly string[], o: { cwd: string; stdin?: string }) => Promise<GhResult>;

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const OWNER = /^[A-Za-z0-9]([A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Any credentials written into an address, `https://user:token@host/...` or `https://token@host/...`, replaced by `***`,
 * wherever they appear in `text`. Used on everything Botbench shows or stores that came from git, `gh` or a remote's address.
 */
export function redact(text: string): string {
  // Everything from the scheme to the last "@" that is followed by a host name, so a "/" or "@" inside a password goes too.
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s'"]+@(?=[A-Za-z0-9.-]+(?:[:/\s'"]|$))/gi, "$1***@");
}

/**
 * The GitHub repository a remote's address names, or null when it names none: `https://host/owner/name(.git)`,
 * `ssh://git@host/owner/name(.git)`, or `git@host:owner/name(.git)`. Credentials in the address are ignored.
 */
export function githubRepoOf(url: string): RepoRef | null {
  const trimmed = url.trim();
  let host: string;
  let rest: string;
  const scheme = /^(https|ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const scp = /^[A-Za-z0-9._-]+@([^/:]+):(?!\/)(.+)$/.exec(trimmed);
  if (scheme) {
    host = scheme[2]!;
    rest = scheme[3]!;
  } else if (scp) {
    host = scp[1]!;
    rest = scp[2]!;
  } else return null;
  host = host.toLowerCase();
  const parts = rest.replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!HOST.test(host) || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { host, owner, name };
}

/** A branch name Botbench hands to `gh`: plain, never one that could read as an option. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
function checkBranch(branch: string): void {
  if (!BRANCH.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) throw new Error(`${JSON.stringify(branch)} is not a branch name Botbench passes to the gh tool.`);
}

/** A pull request's title: one line, at most 200 characters. */
export function titleLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** The exact arguments of each `gh` command Botbench runs. Every value is joined to its flag with `=`, so none can be read as a flag of its own. */
export const ghArgs = {
  authStatus: (host: string): string[] => ["auth", "status", `--hostname=${host}`, "--active", "--json=hosts"],
  repoView: (repo: RepoRef): string[] => ["repo", "view", repoName(repo), "--json=nameWithOwner,defaultBranchRef"],
  prList: (repo: RepoRef, branch: string): string[] => {
    checkBranch(branch);
    return ["pr", "list", `--repo=${repoName(repo)}`, `--head=${branch}`, "--state=all", "--json=number,url,state,headRefName,isCrossRepository", "--limit=100"];
  },
  prCreate: (repo: RepoRef, o: { base: string; head: string; title: string }): string[] => {
    checkBranch(o.base);
    checkBranch(o.head);
    const title = titleLine(o.title);
    if (title === "") throw new Error("A pull request needs a title.");
    return ["pr", "create", `--repo=${repoName(repo)}`, `--base=${o.base}`, `--head=${o.head}`, `--title=${title}`, "--body-file=-"];
  },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function parseJson(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`The gh tool's answer to ${what} could not be read.`);
  }
}

/** Who is signed in on `host`, from `gh auth status --json=hosts`; null when nobody is, or the sign-in does not work. */
export function parseAuthStatus(stdout: string, host: string): { login: string } | null {
  const parsed = parseJson(stdout, "who is signed in");
  if (!isObject(parsed) || !isObject(parsed.hosts)) return null;
  const accounts = parsed.hosts[host];
  if (!Array.isArray(accounts)) return null;
  const active = accounts.find((a) => isObject(a) && a.active === true && a.state === "success" && typeof a.login === "string");
  return active === undefined ? null : { login: String((active as Record<string, unknown>).login) };
}

/** The repository's default branch, from `gh repo view --json=nameWithOwner,defaultBranchRef`. */
export function parseRepoView(stdout: string): { defaultBranch: string } {
  const parsed = parseJson(stdout, "which branch is the repository's default");
  const name = isObject(parsed) && isObject(parsed.defaultBranchRef) ? parsed.defaultBranchRef.name : undefined;
  if (typeof name !== "string" || name === "") throw new Error("The gh tool did not say which branch is the repository's default.");
  return { defaultBranch: name };
}

/** The pull request for `branch` of this same repository (not of a fork), from `gh pr list --json=...`; null when there is none. */
export function parsePrList(stdout: string, branch: string, repo?: RepoRef): PullRequest | null {
  const parsed = parseJson(stdout, "which pull requests the branch has");
  if (!Array.isArray(parsed)) throw new Error("The gh tool's list of pull requests could not be read.");
  const address = (n: unknown): string | null => (repo === undefined ? null : `https://${repo.host}/${repo.owner}/${repo.name}/pull/${String(n)}`);
  // Only this repository's own pull request of the branch, at the address GitHub gives it: nothing else is shown as a link.
  const found = parsed.filter((pr) => isObject(pr) && pr.headRefName === branch && pr.isCrossRepository === false && typeof pr.number === "number" && typeof pr.url === "string" && /^https:\/\/\S+\/pull\/\d+$/.test(pr.url) && (repo === undefined || pr.url.toLowerCase() === address(pr.number)!.toLowerCase()));
  if (found.length === 0) return null;
  // An open one first, else the newest.
  const sorted = (found as Record<string, unknown>[]).sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || Number(b.number) - Number(a.number));
  const pr = sorted[0]!;
  return { number: Number(pr.number), url: String(pr.url), state: String(pr.state) };
}

/** The pull request just opened, from the address `gh pr create` prints. */
export function parsePrCreate(stdout: string): PullRequest {
  const url = stdout.trim().split("\n").map((line) => line.trim()).find((line) => /^https:\/\/\S+\/pull\/\d+$/.test(line));
  if (url === undefined) throw new Error("The gh tool did not print the new pull request's address.");
  return { number: Number(/\/pull\/(\d+)$/.exec(url)![1]), url, state: "OPEN" };
}

/** What a failed `gh` said, on one line, with any credentials in an address taken out. */
export function ghFailure(result: GhResult): string {
  if (!result.started) return "The gh tool is not installed, or is not on the PATH Botbench runs with. Install it, sign in with gh auth login in a terminal, then try again.";
  const said = redact((result.stderr.trim() || result.stdout.trim()).replace(/\s+/g, " ")).slice(0, 600);
  return said === "" ? `The gh tool stopped with exit code ${result.code ?? "none"}.` : `The gh tool said: ${said}`;
}

/** How long one `gh` command may take: it talks to GitHub. Then it is stopped with everything it started. */
export const GH_LIMIT_MS = 60_000;

/**
 * The environment `git push` and `gh` get: Botbench's own (the owner's), without any GIT_* variable and without any
 * variable that carries a GitHub token, so `gh` and git's credential helper use the sign-in the owner keeps with them.
 * Prompts are off: nothing can wait for an answer nobody gives.
 */
export function deliveryEnv(): NodeJS.ProcessEnv {
  return { ...gitEnv(), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0" };
}

/**
 * Run the real `gh` with an argument list (no shell), in its own process group, with `stdin` written to its input. After
 * `GH_LIMIT_MS` the whole group is killed. Resolves with what it printed; never rejects.
 */
export const runGh: RunGh = (args, o) =>
  new Promise((resolve) => {
    const child = spawn("gh", [...args], { cwd: o.cwd, env: deliveryEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let started = true;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, GH_LIMIT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk.slice(0, 1_000_000)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk.slice(0, 1_000_000)));
    child.stdin.on("error", () => {});
    child.stdin.end(o.stdin ?? "");
    child.on("error", () => (started = false));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ started, code, stdout, stderr: timedOut ? `${stderr}\nStopped after ${GH_LIMIT_MS / 1000} seconds without an answer.` : stderr });
    });
  });

/**
 * What Botbench asks of GitHub, through `gh`. This is the seam the delivery's ledger is tested through: a test hands
 * in its own GitHub whose answers are parsed from output captured once from the real `gh`.
 */
export interface GitHub {
  /** The account signed in on `host`, or why there is none. */
  signedIn(host: string): Promise<{ login: string } | { problem: string }>;
  defaultBranch(repo: RepoRef): Promise<string>;
  /** The pull request already made for `branch` in `repo`, in any state; null when there is none. */
  findPullRequest(repo: RepoRef, branch: string): Promise<PullRequest | null>;
  /** Open a pull request; `body` goes to `gh` on its standard input. */
  openPullRequest(repo: RepoRef, o: { base: string; head: string; title: string; body: string; cwd: string }): Promise<PullRequest>;
}

/** The GitHub Botbench uses: the owner's `gh`, run by `run`. */
export function createGitHub(run: RunGh = runGh, cwd = process.cwd()): GitHub {
  const ok = async (args: string[], stdin?: string, at = cwd): Promise<string> => {
    const result = await run(args, { cwd: at, ...(stdin === undefined ? {} : { stdin }) });
    if (!result.started || result.code !== 0) throw new Error(ghFailure(result));
    return result.stdout;
  };
  return {
    async signedIn(host) {
      const result = await run(ghArgs.authStatus(host), { cwd });
      if (!result.started || result.code !== 0) return { problem: ghFailure(result) };
      return parseAuthStatus(result.stdout, host) ?? { problem: `The gh tool is not signed in to ${host}, or its sign-in there does not work. Run gh auth login in a terminal on this Mac, then try again.` };
    },
    defaultBranch: async (repo) => parseRepoView(await ok(ghArgs.repoView(repo))).defaultBranch,
    findPullRequest: async (repo, branch) => parsePrList(await ok(ghArgs.prList(repo, branch)), branch, repo),
    openPullRequest: async (repo, o) => parsePrCreate(await ok(ghArgs.prCreate(repo, o), o.body, o.cwd)),
  };
}
