import { spawn } from "node:child_process";
import { gitEnv } from "./worktrees.ts";

/*
 * The gh tool (`gh`), as Botbench uses it to open a pull request for an accepted task. Botbench runs the owner's own
 * `gh` on this Mac, with the owner's own sign-in, which `gh` keeps and reads itself: Botbench never reads a token, never
 * puts one on a command line or in the environment, and reads nothing from `gh`'s files. These commands are used, each
 * built here as an exact list of arguments (no shell), and each answer read here from what the real `gh` prints:
 *
 *   gh auth status --hostname=<host> --active --json=hosts       who is signed in on that host (the JSON holds no token)
 *   gh repo view <host/owner/name> --json=...                      the repository's default branch
 *   gh pr list --repo=... --head=<branch> --state=all --json=...   a pull request already open (or closed) for the branch
 *   gh pr create --repo=... --base=... --head=... --title=... --body-file=-   the body on standard input, never an argument
 *   gh issue view <number> --repo=<host/owner/name> --json=...     one issue, read only (engine/intake.ts)
 *   gh api --method=GET --hostname=<host> repos/<owner>/<name>/issues/<number>   the same issue as GitHub's REST API
 *                                                                  gives it, read only, for how its author relates to the repository
 *   gh pr list --repo=... --state=all --json=... --limit=100       the latest pull requests in any state, read only (engine/peers.ts)
 *
 * The one write besides a pull request goes through git, not gh, and only for a run that opens pull requests: an issue
 * claim (its lock and named branch) pushed and deleted (engine/claims.ts).
 * Never `gh pr merge`, never `gh repo delete`, never anything that changes a branch, and nothing that writes to an
 * issue: no comment, label, close or assignment.
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
  /** The repository's pull requests in one state or all, read only: what other workbenches have in flight (engine/peers.ts). */
  prListOpen: (repo: RepoRef, state: "open" | "all" = "open"): string[] => ["pr", "list", `--repo=${repoName(repo)}`, `--state=${state}`, `--json=${PR_FIELDS}`, `--limit=${PR_LIST_LIMIT}`],
  /** The number is checked to be a plain positive whole number, so it can only ever be read as the issue's number. */
  issueView: (repo: RepoRef, number: number): string[] => {
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_ISSUE_NUMBER) throw new Error(`${String(number)} is not an issue number.`);
    return ["issue", "view", String(number), `--repo=${repoName(repo)}`, "--json=number,title,body,author,state,url,labels,comments"];
  },
  /**
   * The same issue from GitHub's REST API, read only (GET, no field sent), for its `author_association`, which `gh issue
   * view` does not give for the issue itself. The owner and the name are each one encoded segment of the path.
   */
  issueApi: (repo: RepoRef, number: number): string[] => {
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_ISSUE_NUMBER) throw new Error(`${String(number)} is not an issue number.`);
    return ["api", "--method=GET", `--hostname=${repo.host}`, `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${number}`];
  },
};

const PR_FIELDS = "number,title,url,state,headRefName,isCrossRepository,closingIssuesReferences,files";
/** The most open pull requests asked for at once. */
export const PR_LIST_LIMIT = 100;
/** The most files kept for one pull request (gh itself gives at most 100), and the longest path and title kept. */
export const PR_FILE_LIMIT = 100;
const PATH_LIMIT = 500;
const TITLE_LIMIT = 300;

/**
 * A pull request of a repository as `gh pr list --json=...` gives it, kept to what Botbench shows: its number, title,
 * head branch, state, the issues of the same repository it closes, and the files it changes. Every text in it (title,
 * branch, paths) was written by somebody else, so all of it is outside text: shown as plain text, and never an argument.
 */
export interface ListedPullRequest {
  number: number;
  /** The pull request's address, made by Botbench from the repository and the number, never taken from the answer. */
  url: string;
  title: string;
  state: string;
  headRefName: string;
  /** The numbers of the issues of this same repository it closes, as GitHub reports them. */
  closes: number[];
  files: string[];
}

/**
 * The pull requests of `repo` in what `gh pr list --json=...` printed: only those of this same repository (not a
 * fork's), each at the address GitHub gives a pull request of `repo`. Anything else in the answer is left out.
 */
export function parsePullRequestList(stdout: string, repo: RepoRef): ListedPullRequest[] {
  const parsed = parseJson(stdout, "which pull requests are open");
  if (!Array.isArray(parsed)) throw new Error("The gh tool's list of pull requests could not be read.");
  const base = `https://${repo.host}/${repo.owner}/${repo.name}`;
  const sameRepo = (r: unknown): boolean => isObject(r) && typeof r.name === "string" && isObject(r.owner) && typeof r.owner.login === "string" && r.name.toLowerCase() === repo.name.toLowerCase() && r.owner.login.toLowerCase() === repo.owner.toLowerCase();
  const plain = (text: string, limit: number): string => {
    const line = text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  };
  const found: ListedPullRequest[] = [];
  for (const pr of parsed) {
    if (!isObject(pr) || pr.isCrossRepository !== false || typeof pr.title !== "string" || typeof pr.headRefName !== "string" || typeof pr.state !== "string" || typeof pr.url !== "string") continue;
    const number = pr.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > MAX_ISSUE_NUMBER) continue;
    const url = `${base}/pull/${number}`;
    if (pr.url.toLowerCase() !== url.toLowerCase()) continue;
    const closes = Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences.flatMap((i) => (isObject(i) && sameRepo(i.repository) && typeof i.number === "number" && Number.isSafeInteger(i.number) && i.number >= 1 && i.number <= MAX_ISSUE_NUMBER ? [i.number] : [])) : [];
    const files = Array.isArray(pr.files) ? pr.files.flatMap((f) => (isObject(f) && typeof f.path === "string" && f.path !== "" && f.path.length <= PATH_LIMIT && !f.path.includes("\0") ? [f.path] : [])).slice(0, PR_FILE_LIMIT) : [];
    found.push({ number, url, title: plain(pr.title, TITLE_LIMIT), state: pr.state, headRefName: pr.headRefName, closes: [...new Set(closes)], files: [...new Set(files)] });
  }
  return found;
}

/**
 * One page of a repository's pull requests: those the parser kept, and whether gh's answer filled the page (`full`), so
 * that older pull requests may be missing from it. `full` counts every entry gh gave, a fork's and an unreadable one
 * included: a page of 100 with one fork's pull request in it is still full though only 99 are kept.
 */
export interface PullRequestPage {
  pullRequests: ListedPullRequest[];
  full: boolean;
}

/** `parsePullRequestList`, with whether gh's answer held as many entries as were asked for. */
export function parsePullRequestPage(stdout: string, repo: RepoRef): PullRequestPage {
  const pullRequests = parsePullRequestList(stdout, repo);
  // parsePullRequestList has made sure the answer is a list.
  return { pullRequests, full: (JSON.parse(stdout) as unknown[]).length >= PR_LIST_LIMIT };
}

/** The largest issue number Botbench asks for: GitHub's numbers are 32-bit. */
export const MAX_ISSUE_NUMBER = 2_147_483_647;

/**
 * How an issue's author relates to its repository, in GitHub's own words (`author_association`): the repository's owner,
 * a member of the organization that owns it, a collaborator, someone who contributed before, someone contributing for
 * the first time (to the repository, or to GitHub at all), a placeholder for an imported account, or none of these.
 */
export const AUTHOR_RELATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "NONE"] as const;
export type AuthorRelation = (typeof AUTHOR_RELATIONS)[number];

/** One issue as `gh issue view --json=...` gives it: every field written by whoever wrote the issue, so all of it is data. */
export interface IssueView {
  number: number;
  url: string;
  title: string;
  body: string;
  /** The author's login; null for an account GitHub no longer has. */
  author: string | null;
  /**
   * How the author relates to the repository, read with `gh api` (parseIssueRelation); null when GitHub did not say.
   * It changes only what the owner is told: an issue is outside text whoever wrote it.
   */
  authorRelation: AuthorRelation | null;
  /** OPEN or CLOSED. */
  state: string;
  labels: string[];
  comments: { author: string | null; body: string }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const loginOf = (v: unknown): string | null => (isObject(v) && typeof v.login === "string" && v.login !== "" ? v.login : null);

/**
 * The issue `number` of `repo`, from what `gh issue view --json=...` printed. Refused when the answer is about anything
 * else: a pull request (which `gh issue view` also shows), another number, or another repository's address.
 */
export function parseIssueView(stdout: string, repo: RepoRef, number: number): IssueView {
  const parsed = parseJson(stdout, "what the issue says");
  if (!isObject(parsed)) throw new Error("The gh tool's answer about the issue could not be read.");
  const address = `https://${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();
  const url = typeof parsed.url === "string" ? parsed.url : "";
  if (url.toLowerCase() === `${address}/pull/${number}`) throw new Error(`#${number} in ${repoName(repo)} is a pull request, not an issue. Give the number of an issue.`);
  if (parsed.number !== number || url.toLowerCase() !== `${address}/issues/${number}`) throw new Error(`The gh tool's answer is not about issue #${number} of ${repoName(repo)}.`);
  if (typeof parsed.title !== "string" || typeof parsed.state !== "string") throw new Error("The gh tool's answer about the issue has no title or state.");
  const labels = Array.isArray(parsed.labels) ? parsed.labels.flatMap((l) => (isObject(l) && typeof l.name === "string" ? [l.name] : [])) : [];
  const comments = Array.isArray(parsed.comments) ? parsed.comments.flatMap((c) => (isObject(c) && typeof c.body === "string" ? [{ author: loginOf(c.author), body: c.body }] : [])) : [];
  // `gh issue view` does not say how the issue's own author relates to the repository: that is read with `gh api`.
  return { number, url, title: parsed.title, body: typeof parsed.body === "string" ? parsed.body : "", author: loginOf(parsed.author), authorRelation: null, state: parsed.state, labels, comments };
}

/**
 * How the author of issue `number` of `repo` relates to the repository, from what `gh api repos/<owner>/<name>/issues/<number>`
 * printed: its top-level `author_association`. Null for a value GitHub does not document, or none. Refused when the
 * answer is about anything else: a pull request (which that address also answers for), another number or repository.
 */
export function parseIssueRelation(stdout: string, repo: RepoRef, number: number): AuthorRelation | null {
  const parsed = parseJson(stdout, "who wrote the issue");
  if (!isObject(parsed)) throw new Error("The gh tool's answer about who wrote the issue could not be read.");
  const address = `https://${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();
  const url = typeof parsed.html_url === "string" ? parsed.html_url.toLowerCase() : "";
  if (parsed.pull_request !== undefined || url === `${address}/pull/${number}`) throw new Error(`#${number} in ${repoName(repo)} is a pull request, not an issue. Give the number of an issue.`);
  if (parsed.number !== number || url !== `${address}/issues/${number}`) throw new Error(`The gh tool's answer is not about issue #${number} of ${repoName(repo)}.`);
  const relation = parsed.author_association;
  return (AUTHOR_RELATIONS as readonly unknown[]).includes(relation) ? (relation as AuthorRelation) : null;
}

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
  /** Read one issue, and how its author relates to the repository; nothing is written to it. */
  issue(repo: RepoRef, number: number): Promise<IssueView>;
  /** The repository's latest pull requests in every state, open, closed and merged, read only (engine/peers.ts). */
  pullRequests(repo: RepoRef): Promise<PullRequestPage>;
  /**
   * The repository's open pull requests only, read only: for checking together (engine/combined.ts), when the page of
   * every state is full and may have left out an older open one. `full` says this page may be cut too.
   */
  openPullRequests(repo: RepoRef): Promise<PullRequestPage>;
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
    issue: async (repo, number) => {
      const view = parseIssueView(await ok(ghArgs.issueView(repo, number)), repo, number);
      return { ...view, authorRelation: parseIssueRelation(await ok(ghArgs.issueApi(repo, number)), repo, number) };
    },
    pullRequests: async (repo) => parsePullRequestPage(await ok(ghArgs.prListOpen(repo, "all")), repo),
    openPullRequests: async (repo) => {
      const page = parsePullRequestPage(await ok(ghArgs.prListOpen(repo, "open")), repo);
      return { pullRequests: page.pullRequests.filter((pr) => pr.state === "OPEN"), full: page.full };
    },
  };
}
