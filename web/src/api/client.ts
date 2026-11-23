/*
 * The only module that talks to the Botbench server. Every request goes to the
 * origin the page came from and carries the session cookie.
 */

import type { AuthorRelation } from "../../../src/github.ts";

export type TurnEndReason = "completed" | "interrupted" | "error";

/** The detail of a stopped `turn_ended` the server writes for a turn a restart cut off; the same words as its `RESTART_STOPPED`. */
export const RESTART_STOPPED = "Stopped: Botbench restarted";

/** The normalized events a driver emits; the same union as the server's `DriverEvent`. */
export type DriverEvent =
  | { type: "user_prompt"; text: string }
  | { type: "session_started"; resumeCursor: string; model: string | null; keySource: string | null }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean; confined?: { hosts: string[]; files: boolean } }
  | { type: "permission_denied"; id: string; name: string; reason: string | null; code?: string | null }
  | { type: "permission_request"; id: string; toolCallId: string; name: string; input: unknown; reason: string | null }
  | { type: "permission_resolved"; id: string; toolCallId: string; decision: "allowed" | "preapproved" | "standing" | "mode" | "files" | "web" | "chat" | "bookkeeping" | "declined" | "denied" | "cancelled"; note: string | null }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "rate_limit"; limited: boolean; status: string; resetsAt: string | null }
  /** `usageLimit`: the turn ended because the agent's usage limit was reached; `resetsAt` is when it said it resets, or null. */
  | { type: "turn_ended"; reason: TurnEndReason; detail: string | null; usageLimit?: { resetsAt: string | null } }
  | { type: "error"; message: string; raw: string | null };

/** One stored event, from the stream or from a transcript request. */
export interface StoredEvent {
  attemptId: number;
  id: number;
  turn: number;
  /** When the event was stored. */
  ts: string;
  type: DriverEvent["type"];
  payload: DriverEvent;
}

export interface DriverState {
  driver: string;
  installed: boolean;
  version: string | null;
  supported: boolean;
  signedIn: boolean;
  billing: "subscription" | "metered" | "unknown";
  /** One sentence when the CLI cannot be driven, else null. */
  problem: string | null;
}

/** A message a chat sent to agents given the conversation by Botbench, or a request to compare its answers. */
export interface ChatRound {
  id: number;
  kind: "ask" | "compare";
  message: string;
  /** The round whose answers were compared. */
  compares: number | null;
}

export interface Transcript {
  attemptId: number;
  status: string;
  turnRunning: boolean;
  /** The agent that answered, and the model it was asked for (null: its own default). */
  agent: string;
  model: string | null;
  /** Null for a Claude Code session that keeps the conversation itself. */
  round: ChatRound | null;
  events: StoredEvent[];
}

/** The server answered with an error status. `message` is its own account of why. */
export class ApiError extends Error {
  readonly status: number;
  /** The driver's state, when the server refused because the CLI cannot be driven. */
  readonly driver: DriverState | null;
  constructor(status: number, message: string, driver: DriverState | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.driver = driver;
  }
}

async function request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, timeoutMs?: number, giveUp?: AbortSignal): Promise<T> {
  const signals = [...(timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)]), ...(giveUp ? [giveUp] : [])];
  const res = await fetch(path, {
    method,
    ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
    credentials: "same-origin",
    cache: "no-store",
    // A recording goes as itself, with the type the browser recorded it in; everything else is JSON.
    ...(body === undefined ? {} : body instanceof Blob ? { headers: { "content-type": body.type }, body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // An error page that is not JSON: the status alone is the answer.
  }
  if (!res.ok) {
    const fields = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown; driver?: unknown }) : {};
    const message = typeof fields.error === "string" ? fields.error : `The server answered ${res.status}.`;
    throw new ApiError(res.status, message, typeof fields.driver === "object" && fields.driver !== null ? (fields.driver as DriverState) : null);
  }
  return parsed as T;
}

/** Whether this browser has a session. Throws when the server cannot be reached or does not answer in time. */
export async function hasSession(): Promise<boolean> {
  try {
    await request("GET", "/api/session", undefined, 8000);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return false;
    throw err;
  }
}

export async function signIn(token: string): Promise<void> {
  await request("POST", "/api/sign-in", { token });
}

export const getDriver = (): Promise<DriverState> => request("GET", "/api/driver");

/** Whether the Mac that runs Botbench can turn speech into text, and if not, why in words. */
export type VoiceState = { available: true } | { available: false; reason: string };
/** The Mac compiles its speech helper the first time, which can take a while. */
export const getVoice = (): Promise<VoiceState> => request("GET", "/api/voice", undefined, 60_000);
/** What was said in a recording, transcribed on the Mac. */
export const transcribe = async (recording: Blob): Promise<string> => (await request<{ text: string }>("POST", "/api/voice/transcribe", recording, 120_000)).text;

/** An agent as it reports itself, and the steps Botbench lets it work in ("planner", "builder", "reviewer"). */
export interface AgentState extends Omit<DriverState, "driver"> {
  agent: string;
  roles: string[];
  /** What it can do in a chat, in one sentence; null for Claude Code. */
  chat?: string | null;
}
/** The agents as their last check found them, when it ended, whether a new check is running, and the cap on rounds of fixes. */
export interface AgentsAnswer {
  agents: AgentState[];
  checkedAt: string;
  checking: boolean;
  maxRefineRounds: number;
}
/** One request at a time, shared by every screen and picker that needs the agents; a failed one is asked again next time. */
let askingAgents: Promise<AgentsAnswer> | null = null;
/**
 * The agents. Botbench answers from a check made in the last minute at once (each check runs every agent's own program,
 * which takes seconds); `fresh` waits for a check that ends after the request, for a screen that must show the state now.
 */
export function getAgentsAndCap(fresh = false): Promise<AgentsAnswer> {
  if (fresh) return request("GET", "/api/agents?fresh=1", undefined, 30_000);
  askingAgents ??= request<AgentsAnswer>("GET", "/api/agents", undefined, 30_000).finally(() => {
    askingAgents = null;
  });
  return askingAgents;
}
export const getAgents = async (fresh = false): Promise<AgentState[]> => (await getAgentsAndCap(fresh)).agents;
/** The models a reviewer offers, as its program lists them or as the configuration does. */
export const getAgentModels = (agent: string): Promise<ModelList> => request("GET", `/api/agents/${encodeURIComponent(agent)}/models`, undefined, 30_000);

/** Who reviews a run's tasks: an agent and a model, null for the agent's own default. */
export interface ReviewerChoice {
  agent: string;
  model: string | null;
}

/** A task's review, as stored. Its text is the reviewer's own words: a model's opinion, not a check. */
export interface Review {
  id: number;
  /** Which review of the task this is, from 1. */
  round: number;
  /** The commit reviewed; null when unknown. */
  headCommit: string | null;
  agent: string;
  model: string | null;
  attemptId: number | null;
  outcome: "reviewed" | "failed" | "timed_out" | "stopped";
  verdict: "looks_right" | "concerns" | null;
  text: string;
  /** The lines under the review's "Checked:" heading: what the reviewer says it examined. Empty when it gave no account. */
  checked: string[];
  /** The plain note on a finished review that gave no account of what it checked; null otherwise. */
  accountNote: string | null;
  /** Why there is no review, in words; null when there is one. */
  problem: string | null;
  diffChars: number;
  diffCut: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

/** An agent's sign-in, run by its own command-line program from Settings. The link and code are there only while it waits. */
export interface ConnectState {
  driver: string;
  kind: "device-code" | "link" | "on-the-mac";
  terminalCommand: string;
  /** The agent's own sign-out, as Disconnect runs it. */
  signOutCommand: string;
  /** The page shows a code after sign-in, to be pasted back here. */
  takesCode: boolean;
  state: "idle" | "starting" | "waiting" | "checking" | "succeeded" | "failed" | "cancelled";
  url: string | null;
  code: string | null;
  expiresAt: string | null;
  reason: string | null;
}

const agentPath = (driver: string): string => `/api/agents/${encodeURIComponent(driver)}`;
export const getConnect = (driver: string): Promise<ConnectState> => request("GET", `${agentPath(driver)}/connect`);
export const startConnect = (driver: string): Promise<ConnectState> => request("POST", `${agentPath(driver)}/connect`, {}, 60_000);
export const sendConnectCode = (driver: string, code: string): Promise<ConnectState> => request("POST", `${agentPath(driver)}/connect/code`, { code });
export const cancelConnect = (driver: string): Promise<ConnectState> => request("POST", `${agentPath(driver)}/connect/cancel`, {}, 30_000);
export const disconnectAgent = (driver: string): Promise<DriverState> => request("POST", `${agentPath(driver)}/disconnect`, {}, 60_000);

/** One round of fixes after a review with concerns. `reply` is the builder's own words; `addressed` and `notAddressed` are its two headings read, null when it did not use them. */
export interface Refinement {
  id: number;
  round: number;
  attemptId: number | null;
  outcome: "finished" | "failed" | "stopped";
  changed: boolean;
  reply: string;
  problem: string | null;
  addressed: string[] | null;
  notAddressed: string[] | null;
  fromCommit: string;
  headCommit: string | null;
  startedAt: string;
  endedAt: string;
}

/** What the refine loop came to: nothing reviewed, the reviewer satisfied, it looks right with no account of what was checked, the models still disagree, or a step did not finish. */
export type ReviewOutcome = "none" | "satisfied" | "unaccounted" | "unresolved" | "failed";

/** The models the driver offers and where the list came from. `default` null means the CLI's own default. */
export interface ModelList {
  driver: string;
  source: "cli" | "config";
  /** `label` is the agent's own name for the model; `resolved` is the full model name `id` stands for, which a session then reports. */
  models: { id: string; label?: string; resolved?: string }[];
  default: string | null;
  /** What the CLI says its own default is. */
  cliDefault: string | null;
}

/** The server asks the CLI, which it gives 10 seconds; a request silent for longer is not going to answer. */
export const getModels = (): Promise<ModelList> => request("GET", "/api/models", undefined, 15_000);

/** A model for a request: a name, null for the CLI's own default, or undefined to leave it to the server's configuration. */
const withModel = (model: string | null | undefined): { model?: string | null } => (model === undefined ? {} : { model });

/** Starting a turn launches the CLI, which takes a second or two. A server silent for half a minute is not going to answer. */
export const startTurn = (prompt: string, attemptId?: number, model?: string | null): Promise<{ attemptId: number; turn: number }> =>
  request("POST", "/api/turns", { prompt, ...(attemptId === undefined ? {} : { attemptId }), ...withModel(model) }, 30_000);

/** One agent asked in a chat: an agent and its model (null: its own default; undefined: the configured one). */
export interface ChatTarget {
  agent: string;
  model?: string | null;
}
export interface ChatReply {
  attemptId: number;
  turn: number;
  agent: string;
  model: string | null;
  roundId: number | null;
}
/** Send a chat message to one agent or several, with the chat so far; or, with `compare`, ask one to compare a round's answers. Each agent is checked first, which takes seconds. */
export const sendChatMessage = (o: { prompt: string; conversation: readonly number[]; agents: readonly ChatTarget[]; compare?: number }): Promise<ChatReply[]> =>
  request<{ replies: ChatReply[] }>("POST", "/api/chat", o, 60_000).then((r) => r.replies);

export async function interruptTurn(attemptId: number): Promise<void> {
  await request("POST", `/api/turns/${attemptId}/interrupt`, {});
}

export const getTranscript = (attemptId: number): Promise<Transcript> => request("GET", `/api/attempts/${attemptId}/events`);

/** `waiting_for_limit`: its builder's usage limit was reached; Botbench tries again by itself at `retryAt`. */
export type TaskStatus = "queued" | "building" | "verifying" | "reviewing" | "awaiting_decision" | "accepted" | "rejected" | "interrupted" | "failed" | "cancelled" | "waiting_for_limit";

/** The owner's decision on a task, as it was recorded. */
/** One time a list of setup or check commands was run on a task, and how many commands it holds. */
export interface CommandList {
  kind: "setup" | "check";
  round: number;
  total: number;
}

export interface TaskDecision {
  decision: "accept" | "reject";
  /** What became of the task's branch. */
  branch: "kept" | "deleted";
  branchName: string;
  /** The files the checks left in the task's copy, removed with it. */
  leftovers: string[];
  /** The owner's short note on the decision; null when none was given. */
  note: string | null;
  /** The owner, or the run's mode: a fully autonomous run accepted the task without the owner. */
  decidedBy: "owner" | "mode";
  /** Why the mode accepted it, in words; null for the owner's own decision. */
  reasons: string | null;
  decidedAt: string;
}
/** How much a run does without the owner, chosen when it is started. */
export type RunMode = "manual" | "semi" | "full";
/** What becomes of each task a run accepts: its branch is kept, or pushed and opened as a pull request. */
export type Delivery = "branch" | "pull_request";
/**
 * A task's pull request: what its run chose, and where it stands. `sending`: Botbench is pushing the branch or opening
 * the pull request. `failed`: what went wrong is in `problem`; nothing about the acceptance changed.
 */
export interface PullRequestView {
  choice: Delivery;
  state: "none" | "sending" | "opened" | "failed";
  number: number | null;
  url: string | null;
  /** The pull request was already there and was taken as this task's. */
  adopted: boolean;
  /** OPEN, CLOSED or MERGED, as GitHub said when it was opened or found. */
  prState: string | null;
  /** The branch was pushed to the remote, whatever came after. */
  pushed: boolean;
  repository: string | null;
  base: string | null;
  remote: string | null;
  branch: string | null;
  problem: string | null;
  at: string | null;
}
/** Where Open a pull request would send an accepted task's branch, for the owner to confirm. */
export interface PullRequestTarget {
  remote: string;
  /** The remote's address, any credentials in it taken out. */
  address: string;
  repository: string | null;
  branch: string;
  /** The base branch the settings name; null for the repository's default. */
  base: string | null;
}
/** What a task's checks found: all passed, at least one failed or ran out of time, or the repository has none. */
export type ChecksMark = "passed" | "failed" | "none";

/** One command Botbench ran on a task, as stored: a setup command before its builder started, or a check after. */
export interface Evidence {
  id: number;
  kind: "setup" | "check";
  /** Which time its list was run on the task, from 1: a list stopped by a restart is run again from the start as the next. */
  round: number;
  /** Its place in its list, from 1. */
  position: number;
  /** The command as the owner configured it. */
  command: string;
  outcome: "passed" | "failed" | "timed_out" | "stopped";
  exitCode: number | null;
  signal: string | null;
  /** What it printed, its end when it was long. */
  output: string;
  truncated: boolean;
  limitMs: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface TaskSummary {
  id: number;
  repo: string;
  prompt: string;
  /** The model asked for when the task was started; null is the CLI's own default. */
  requestedModel: string | null;
  status: TaskStatus;
  /** Why the task was interrupted or failed. */
  reason: string | null;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  attemptId: number | null;
  /** What its checks found once it was built; null before that. */
  checks: ChecksMark | null;
  /** For a task waiting for a usage limit: when Botbench tries again (ISO). Null for every other task. */
  retryAt: string | null;
  /** The task's agent asked for permission and is paused until the owner answers. */
  waitingOnApproval: boolean;
  /** A request that waits for the owner was asked before Botbench restarted: the agent is stopped, and the answer resumes the task. */
  parked: boolean;
  /** The owner's answer to such a request is stored, and the task is being started again to receive it. */
  resuming: boolean;
  /** Its run read a GitHub issue, which people outside the project wrote: no pre-approved or always-allowed command applies to it. */
  outsideText: boolean;
  /** The issue its run was started from, or null. */
  issue: IssueLink | null;
  /** The run whose approved plan queued this task, or null for a task started on its own. */
  ofPlan: number | null;
  /** The commands this task may run without asking, as the owner listed them when starting it. */
  preapproved: string[];
  /** The owner's decision, once there is one. */
  decision: TaskDecision | null;
  pullRequest: PullRequestView;
  /** For a stopped task Resume can take up again: what Resume will do, in words. Null when it cannot be resumed. */
  resumeNote: string | null;
  /** The owner's note that waits for the builder to finish what it is doing now; `replacedOne` when it took the place of another. */
  waitingNote: { id: number; text: string; sentAt: string; replacedOne: boolean } | null;
  /** The latest note, when it was not delivered, with why. */
  undeliveredNote: { id: number; text: string; sentAt: string; reason: string } | null;
  /** The mode of its run; manual for a task started on its own. */
  mode: RunMode;
  /** What the refine loop came to, and how many reviews and rounds of fixes there were. */
  reviewOutcome: ReviewOutcome;
  reviewRounds: number;
  refineRounds: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  binary: boolean;
  /** The task's plan, its checks or its tests lead one to expect this file (src/engine/scope.ts). */
  expected: boolean;
  /** The file lies under a path only the owner may accept a change to. */
  protected: boolean;
}

/** One round of fixes for a failing check: the round of checks it was sent, how it ended, and whether it changed the work. */
export interface CheckFix {
  round: number;
  checkRound: number;
  outcome: "finished" | "failed" | "stopped";
  changed: boolean;
  problem: string | null;
  fromCommit: string;
  headCommit: string | null;
  startedAt: string;
  endedAt: string;
}

export interface TaskDetail extends TaskSummary {
  /** For a task of a run from an issue whose owner allowed them, the network hosts its commands may reach; empty otherwise. */
  issueHosts: string[];
  /** The files changed from the base commit to Botbench's commit; null until there is a commit, or when they cannot be read. */
  files: FileChange[] | null;
  filesProblem: string | null;
  /** The commands Botbench ran on the task, in the order they ran. */
  evidence: Evidence[];
  /** How many commands each round of setup and checks holds, recorded as it starts. */
  commandLists: CommandList[];
  /** The rounds of fixes for a failing check on the latest version of the work, in order. */
  checkFixes: CheckFix[];
  /** What came of those rounds, in a plain line, once they are over; null before, or with none. */
  checkFixLine: string | null;
  /** Every request Botbench refused without asking during the task, in full, oldest first. */
  refused: string[];
  /** Who reviews the task, when its run names a reviewer. */
  reviewer: ReviewerChoice | null;
  /** Its latest review, once there is one. */
  review: Review | null;
  /** Every review, one per round, in order. */
  reviews: Review[];
  /** How many of the builder's sessions on this task came before the one its transcript shows; they are kept. */
  earlierAttempts: number;
  /** Every round of fixes, in order; round n follows review n. */
  refinements: Refinement[];
  /** The run's cap on rounds of fixes. */
  maxRefineRounds: number;
  /** What came of the reviews and fixes, in a plain line; null before the first review. */
  reviewLine: string | null;
  /** For a task that is ready for review: the files the checks left in its copy that are not on its branch. Null otherwise, or when they cannot be read. */
  leftovers: string[] | null;
  /** For a task that failed, was stopped or was cancelled: what it left, which Discard removes. Null otherwise, or when it cannot be read. */
  remains: TaskRemains | null;
  remainsProblem: string | null;
  /** For an accepted task that kept its branch and has no pull request yet: where Open a pull request would send it. */
  pullRequestTarget: PullRequestTarget | null;
}

/** What a task that ended without being ready for review left: its copy, Botbench's branch, and the files in the copy that are not on the branch. */
export interface TaskRemains {
  copy: boolean;
  branch: boolean;
  files: string[];
  /** When the owner discarded them; null when they have not. */
  discardedAt: string | null;
}

export interface RepoCheck {
  usable: boolean;
  path: string;
  /** Why the path cannot be used, in words. */
  reason: string | null;
}

/** The server gives git 5 seconds to answer about a path; a check silent for this long is not going to answer. */
export const CHECK_REPO_LIMIT_MS = 10_000;
/** Ask about one path. `giveUp` ends the request when a newer path has taken its place. */
export const checkRepo = (path: string, giveUp: AbortSignal): Promise<RepoCheck> =>
  request("GET", `/api/repos/check?path=${encodeURIComponent(path)}`, undefined, CHECK_REPO_LIMIT_MS, giveUp);
/** Whether a request ended because its time limit passed. */
export const timedOut = (err: unknown): boolean => err instanceof DOMException && err.name === "TimeoutError";
/** What the owner's settings offer for a repository: the commands a task there may be started with as pre-approved. It grants nothing by itself. */
export interface RepoSettings {
  path: string;
  preapproved: string[];
  /** Whether at least one check command is configured: a fully autonomous run needs one. */
  hasChecks: boolean;
  /**
   * Whether a run from an issue that opens pull requests first pushes a claim that other workbenches see (the setting
   * `claimIssues`, src/engine/claims.ts); nothing is pushed for a run that keeps its work on this Mac.
   */
  claimIssues: boolean;
}
export const getRepoSettings = (path: string, giveUp: AbortSignal): Promise<RepoSettings> =>
  request("GET", `/api/repos/settings?path=${encodeURIComponent(path)}`, undefined, CHECK_REPO_LIMIT_MS, giveUp);
/** A repository used before or named in the settings file: its folder name and full path. */
export interface KnownRepository {
  name: string;
  path: string;
}
/** The repositories used before, most recent first, then the configured ones. */
export const listRepos = (): Promise<KnownRepository[]> => request<{ repositories: KnownRepository[] }>("GET", "/api/repos", undefined, CHECK_REPO_LIMIT_MS).then((r) => r.repositories);
/** `preapproved` is exactly what this task's run may use without asking: the server grants nothing the request does not list. */
export const startTask = (repo: string, prompt: string, model: string | null | undefined, preapproved: string[]): Promise<{ taskId: number }> =>
  request("POST", "/api/tasks", { repo, prompt, ...withModel(model), preapproved }, 30_000);
export const listTasks = async (): Promise<TaskSummary[]> => (await request<{ tasks: TaskSummary[] }>("GET", "/api/tasks")).tasks;
export const getTask = (id: number): Promise<TaskDetail> => request("GET", `/api/tasks/${id}`);
/** Accept a task that is ready for review. `removeLeftovers` is the list of files its checks left, as the owner saw and confirmed them. */
export const acceptTask = (id: number, removeLeftovers: readonly string[], note: string | null = null): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/accept`, { removeLeftovers, note }, 60_000);
/** Push an accepted task's branch and open its pull request (or try again), naming the remote and branch the owner confirmed. */
export const openPullRequest = (id: number, to: { remote: string; branch: string; address: string }): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/pull-request`, { remote: to.remote, branch: to.branch, address: to.address }, 30_000);
/** Reject a task that is ready for review, keeping or deleting its branch. */
export const rejectTask = (id: number, branch: "keep" | "discard", removeLeftovers: readonly string[], note: string | null = null): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/reject`, { branch, removeLeftovers, note }, 60_000);
/** Remove the copy and branch of a task that failed, was stopped or was cancelled. `removeFiles` is the list of files not on the branch, as the owner saw and confirmed it. */
export const discardTask = (id: number, removeFiles: readonly string[]): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/discard`, { removeFiles }, 60_000);
/** Take up a stopped task again. Refused (409, with the reason) for a task in any other state. */
export const resumeTask = (id: number): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/resume`, {}, 30_000);
/** A note as the server stored it. */
export interface TaskNote {
  id: number;
  text: string;
  state: "waiting" | "delivered" | "replaced" | "not_delivered";
}
/** The owner's note for a building task's builder; the answer says which waiting note it replaced, if one waited. */
export const sendTaskNote = (id: number, text: string): Promise<{ note: TaskNote; replaced: TaskNote | null }> => request("POST", `/api/tasks/${id}/notes`, { text }, 30_000);
export const getTaskDiff = (id: number, file: string): Promise<{ file: string; diff: string; truncated: boolean }> =>
  request("GET", `/api/tasks/${id}/diff?file=${encodeURIComponent(file)}`);

export type RunStatus = "planning" | "awaiting_plan_approval" | "running" | "awaiting_decision" | "done" | "cancelled" | "failed";

/** One task of a plan: what to build, and how to tell it is built. Both are text a planner or the owner wrote. */
export interface PlanTask {
  title: string;
  criteria: string[];
}

/** A run as the list shows it. */
export interface RunSummary {
  id: number;
  repo: string;
  /** The first line of what the run was given. */
  title: string;
  status: RunStatus;
  reason: string | null;
  /** The newest planner attempt; null until a planner has been started for the run. */
  attemptId: number | null;
  /** How many tasks its plan holds. */
  taskCount: number;
  /** How many of the tasks made from its plan are at an end: built, failed, stopped or cancelled. */
  finishedCount: number;
  /** How many of them are ready for review, and how many are decided. */
  readyCount: number;
  decidedCount: number;
  /** Its planner asked for permission and is paused until the owner answers. */
  waitingOnApproval: boolean;
  mode: RunMode;
  /** The run read a GitHub issue, which people outside the project wrote. */
  outsideText: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The GitHub issue a run was started from, as it was read then. */
export interface IssueLink {
  repository: string;
  number: number;
  url: string;
  title: string;
  fetchedAt: string;
}

export interface RunDetail extends Omit<RunSummary, "taskCount" | "finishedCount" | "readyCount" | "decidedCount"> {
  prompt: string | null;
  specPath: string | null;
  specText: string | null;
  /** The model asked for the planner; null is the CLI's own default. */
  requestedModel: string | null;
  plannerModel: string | null;
  /** The model the run's tasks are built on, as asked when it started (null: Claude Code's default); absent for a run from before this was recorded. */
  buildModel?: string | null;
  /** Who reviews each built task; null when nobody does. */
  reviewer: ReviewerChoice | null;
  /** What becomes of each task the run accepts. */
  delivery: Delivery;
  baseCommit: string;
  /** The plan's version. A decision names the version it was made on, and is refused when the plan has changed since. */
  planVersion: number;
  plan: PlanTask[];
  /** The tasks made when the plan was approved, in plan order: where each stands, and the commands Botbench ran on it. */
  tasks: RunTask[];
  /** The commands the run's builders may use without asking, as the owner listed them when starting it. */
  preapproved: string[];
  /** The issue the run was started from, or null. */
  issue: IssueLink | null;
  /** The owner let this run's commands reach the repository's allowed network hosts all the same. */
  outsideHosts: boolean;
  /** Those hosts, by name, for a run from an issue whose owner allowed them; empty for any other run. */
  issueHosts: string[];
  /** Whether the run told other workbenches it started on its issue, and what became of that, in one sentence; null when it did not try. */
  claim: { state: "claiming" | "claimed" | "not_claimed" | "withdrawn" | "released" | "kept"; issue: number; branch: string | null; words: string } | null;
}

/** One task of a run as the run's screen shows it. */
export interface RunTask {
  id: number;
  status: TaskStatus;
  title: string;
  reason: string | null;
  attemptId: number | null;
  branch: string | null;
  checks: ChecksMark | null;
  /** For a task waiting for a usage limit: when Botbench tries again (ISO). Null for every other task. */
  retryAt: string | null;
  waitingOnApproval: boolean;
  evidence: Evidence[];
  /** How many commands each round of setup and checks holds, recorded as it starts. */
  commandLists: CommandList[];
  decision: TaskDecision | null;
  pullRequest: PullRequestView;
  leftovers: string[] | null;
  /** For a stopped task Resume can take up again: what Resume will do, in words. Null when it cannot be resumed. */
  resumeNote: string | null;
}

/** A run reached a state or its plan changed. The run itself is read from its route. */
export interface RunAnnouncement {
  runId: number;
  status: RunStatus;
}

/**
 * Exactly one of `prompt` and `specPath`. `preapproved` is exactly what the run's builders may use without asking.
 * `takeOver`: other workbenches' old claims on the run's issue the owner confirmed taking over, by branch.
 */
export const startRun = (o: { repo: string; prompt?: string; specPath?: string; issue?: IssueChoice; model: string | null | undefined; buildModel?: string | null; preapproved: string[]; reviewer: ReviewerChoice | null; mode: RunMode; delivery: Delivery; oneTask: boolean; takeOver?: string[] }): Promise<{ runId: number }> =>
  request("POST", "/api/runs", { repo: o.repo, ...(o.prompt === undefined ? {} : { prompt: o.prompt }), ...(o.specPath === undefined ? {} : { specPath: o.specPath }), ...(o.issue === undefined ? {} : { issue: o.issue }), ...withModel(o.model), ...(o.buildModel === undefined ? {} : { buildModel: o.buildModel }), preapproved: o.preapproved, reviewer: o.reviewer, mode: o.mode, delivery: o.delivery, oneTask: o.oneTask, ...(o.takeOver === undefined || o.takeOver.length === 0 ? {} : { takeOver: o.takeOver }) }, 30_000);

/** The issue a run is started from: the reading the owner was shown, and whether its commands may reach the repository's allowed hosts. */
export interface IssueChoice {
  fetchId: number;
  allowHosts: boolean;
}
/** An issue as it was read for the owner, before a run is started from it. Everything but the number and address is text written outside the project. */
export interface IssuePreview {
  fetchId: number;
  repository: string;
  number: number;
  url: string;
  title: string;
  author: string | null;
  /** How the author relates to the repository, as GitHub said when the issue was read; null when it did not say. */
  authorRelation: AuthorRelation | null;
  state: string;
  labels: string[];
  body: string;
  comments: { author: string | null; body: string }[];
  commentCount: number;
  /** What was left out, in one sentence; null when nothing was. */
  cutWords: string | null;
  fetchedAt: string;
}
/** Whether issues can be read for a repository: its GitHub repository, or why there is none, and the hosts its settings allow. */
export interface IssueSource {
  repository: string | null;
  problem: string | null;
  hosts: string[];
}
export const issueSourceOf = (path: string, giveUp: AbortSignal): Promise<IssueSource> => request("GET", `/api/repos/github?path=${encodeURIComponent(path)}`, undefined, CHECK_REPO_LIMIT_MS, giveUp);
/** The gh tool reads it from GitHub, which can take a while. */
export const lookUpIssue = async (repo: string, issue: string): Promise<IssuePreview> => (await request<{ issue: IssuePreview }>("POST", "/api/issues", { repo, issue }, 70_000)).issue;
/** Whether this installation is on its first run: no chat, task or run has ever been stored in it. */
export const getFirstRun = async (): Promise<boolean> => (await request<{ firstRun: boolean }>("GET", "/api/first-run", undefined, 30_000)).firstRun;
/** The mode a new run is given unless the owner chooses another in the composer. */
export const getDefaultMode = async (): Promise<RunMode> => (await request<{ defaultMode: RunMode }>("GET", "/api/settings", undefined, 30_000)).defaultMode;
/** What Claude Code's web tools may do in a chat: run, ask you each time, or not run. */
export type WebAccess = "allow" | "ask" | "off";
export const getChatWebAccess = async (): Promise<WebAccess> => (await request<{ chatWebAccess: WebAccess }>("GET", "/api/settings", undefined, 30_000)).chatWebAccess;
export const setChatWebAccess = async (value: WebAccess): Promise<WebAccess> => (await request<{ chatWebAccess: WebAccess }>("PUT", "/api/settings", { chatWebAccess: value }, 30_000)).chatWebAccess;
export const getAskEveryCommand = async (): Promise<boolean> => (await request<{ askEveryCommand: boolean }>("GET", "/api/settings", undefined, 30_000)).askEveryCommand;
export const setAskEveryCommand = async (on: boolean): Promise<boolean> => (await request<{ askEveryCommand: boolean }>("PUT", "/api/settings", { askEveryCommand: on }, 30_000)).askEveryCommand;
export const setDefaultMode = async (mode: RunMode): Promise<RunMode> => (await request<{ defaultMode: RunMode }>("PUT", "/api/settings", { defaultMode: mode }, 30_000)).defaultMode;
/** This installation's workbench name, and whether the settings file sets it (then it is changed there, not here). */
export interface WorkbenchSetting {
  name: string;
  setInFile: boolean;
}
export const getWorkbench = async (): Promise<WorkbenchSetting> => (await request<{ workbench: WorkbenchSetting }>("GET", "/api/settings", undefined, 30_000)).workbench;
export const setWorkbench = async (name: string): Promise<WorkbenchSetting> => (await request<{ workbench: WorkbenchSetting }>("PUT", "/api/settings", { workbench: name }, 30_000)).workbench;

/** A note the owner asked Botbench to remember (src/engine/memory.ts). `hash` is the version an edit or a forget carries. */
export interface MemoryNote {
  id: number;
  text: string;
  hash: string;
  savedAt: string;
  editedAt: string | null;
}

/** The notes in memory, newest first, with the caps of one note and of the whole store. */
export interface MemoryList {
  notes: MemoryNote[];
  maxNoteChars: number;
  maxKb: number;
}

export const getMemory = (): Promise<MemoryList> => request("GET", "/api/memory", undefined, 30_000);
/** Refused with 409 when the note changed since `hash` was read; nothing is overwritten then. */
export const editMemoryNote = async (id: number, text: string, hash: string): Promise<MemoryNote> => (await request<{ note: MemoryNote }>("PUT", `/api/memory/${id}`, { text, hash }, 30_000)).note;
/** The notes as they are after the forget. Refused with 409 when the note changed since `hash` was read. */
export const forgetMemoryNote = (id: number, hash: string): Promise<MemoryList> => request("DELETE", `/api/memory/${id}`, { hash }, 30_000);

/** Another workbench's open pull request on a repository's remote. Its title, branch, files and workbench are outside text. */
export interface PeerPullRequest {
  workbench: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  closes: number[];
  files: string[];
  /** The commit its branch points at on the remote; null when the remote did not list it. */
  head: string | null;
}
/** Another workbench's pushed branch with no pull request yet. */
export interface PeerBranch {
  workbench: string;
  branch: string;
}
/** Another workbench's claim on an issue: it started a run on it at `startedAt` (a UTC minute) and has no pull request yet. */
export interface PeerClaim {
  workbench: string;
  branch: string;
  issue: number;
  startedAt: string;
}
/** What other workbenches have in flight on one repository's remote, or why that cannot be read now. `repository` is the shared one, host/owner/name. */
export type PeersView =
  | { state: "ready"; repo: string; repository: string; pullRequests: PeerPullRequest[]; branches: PeerBranch[]; claims: PeerClaim[]; checkedAt: string }
  | { state: "unavailable"; repo: string; problem: string; checkedAt: string };
/** The view for each repository the owner has used. Reading it never holds up anything else. */
export const getPeers = async (): Promise<PeersView[]> => (await request<{ views: PeersView[] }>("GET", "/api/peers", undefined, 90_000)).views;
export const getPeersOf = async (repo: string): Promise<PeersView> => (await request<{ view: PeersView }>("GET", `/api/peers?path=${encodeURIComponent(repo)}`, undefined, 90_000)).view;

/** One command run on a merge with another workbench's pull request. */
export type CombinedCommand = Omit<Evidence, "round">;
/** Whether a check together still stands on the commits it ran on (src/engine/combined.ts). Only "current" counts. */
export type CombinedFreshness =
  | { state: "current" }
  | { state: "stale"; taskMoved: boolean; pullRequestMoved: boolean; taskNow: string | null; pullRequestNow: string | null }
  | { state: "closed" }
  | { state: "unknown"; problem: string };
/** One check of a task together with another workbench's open pull request, as stored. Its workbench and branch are outside text. */
export interface CombinedCheck {
  id: number;
  pullRequest: number;
  workbench: string;
  peerBranch: string;
  peerCommit: string | null;
  taskCommit: string;
  outcome: "passed" | "failed" | "conflict" | "not_run";
  conflicts: string[];
  problem: string | null;
  startedAt: string;
  endedAt: string;
  commands: CombinedCommand[];
  freshness: CombinedFreshness;
}
/** Another workbench's open pull request this task can be checked together with, and the files both change. */
export interface CheckTogetherOffer {
  number: number;
  title: string;
  url: string;
  workbench: string;
  head: string | null;
  overlaps: string[];
}
export interface CheckTogetherView {
  /** The owner requires checking together on this repository. */
  required: boolean;
  /** The pull request a check together runs with now, or null. */
  running: number | null;
  /** Newest first. */
  checks: CombinedCheck[];
  offers: CheckTogetherOffer[];
  /** With the setting on: the overlapping pull requests that still have no passing, current check together. */
  waitingOn: number[];
  /** With the setting on: why it cannot be met now when no pull request can be named (the list could not be read, or may be cut). */
  undetermined: string | null;
  viewProblem: string | null;
}
export const getCheckTogether = (taskId: number): Promise<CheckTogetherView> => request("GET", `/api/tasks/${taskId}/check-together`, undefined, 90_000);
export const startCheckTogether = (taskId: number, pullRequest: number): Promise<{ running: number }> => request("POST", `/api/tasks/${taskId}/check-together`, { pullRequest }, 90_000);
export const setCheckTogetherRequired = (path: string, required: boolean): Promise<{ path: string; required: boolean }> => request("PUT", "/api/repos/check-together", { path, required }, 30_000);
export const listRuns = async (): Promise<RunSummary[]> => (await request<{ runs: RunSummary[] }>("GET", "/api/runs", undefined, 30_000)).runs;
/** What a run's or a task's More menu offers besides Open and Hide, read as things are now. */
export interface RowMenuFacts {
  /** Its branch, while git still has it; for a run, only when it has exactly one. */
  branch: string | null;
  /** Its pull request, while it is open; for a run, only when it has exactly one. */
  pullRequest: { number: number; url: string } | null;
}
/** A chat as the Work list shows it: named by its first attempt. */
export interface ChatItem {
  id: number;
  /** The owner's name for it, else the first line of its first message. */
  title: string;
  /** Whether the title is one the owner gave it. */
  named: boolean;
  agents: string[];
  /** Its attempts, oldest first: what the Chat screen shows as this chat. */
  attempts: number[];
  createdAt: string;
  updatedAt: string;
}
/** One row of the board: a planned run, a task started on its own (a run of one), or a chat. */
export type BoardItem =
  | ({ kind: "run"; cancellable: boolean } & RunSummary & RowMenuFacts)
  | ({ kind: "task"; id: number; repo: string; title: string; status: TaskStatus; reason: string | null; checks: ChecksMark | null; waitingOnApproval: boolean; resuming: boolean; discardable: boolean; createdAt: string; updatedAt: string } & RowMenuFacts)
  | ({ kind: "chat" } & ChatItem);
export type BoardGroupName = "needs-you" | "running" | "finished" | "chats";
/** One group of the board: its real count, and its items (Finished and Chats send only their newest). */
export interface BoardGroup {
  name: BoardGroupName;
  total: number;
  items: BoardItem[];
}
/** The board's groups in order, the one that needs the owner first, each newest change first; with `hidden`, only the rows hidden from it. `hidden` counts the hidden rows. */
export const getBoard = (hidden = false): Promise<{ groups: BoardGroup[]; hidden: number }> => request("GET", hidden ? "/api/board?hidden=1" : "/api/board", undefined, 30_000);
/** Hide a row from the Work list, or show it there again. Nothing of the run, task or chat is changed. */
export const setRowHidden = (kind: BoardItem["kind"], id: number, hidden: boolean): Promise<{ kind: string; id: number; hidden: boolean }> => request("POST", hidden ? "/api/board/hide" : "/api/board/show", { kind, id }, 30_000);
/** A chat as the Chat screen opens it. */
export const getChat = (id: number): Promise<ChatItem> => request("GET", `/api/chats/${id}`, undefined, 30_000);
/** Give a chat a name of the owner's; an empty one gives it back its first message. */
export const renameChat = (id: number, title: string): Promise<ChatItem> => request("POST", `/api/chats/${id}/rename`, { title }, 30_000);
export const getRun = (id: number): Promise<RunDetail> => request("GET", `/api/runs/${id}`, undefined, 30_000);
/** The whole plan as it should be: how a task is edited, added and deleted. */
export const savePlan = (id: number, planVersion: number, tasks: PlanTask[]): Promise<RunDetail> => request("PATCH", `/api/runs/${id}/plan`, { planVersion, tasks }, 30_000);
export const approvePlan = (id: number, planVersion: number): Promise<RunDetail> => request("POST", `/api/runs/${id}/plan/approve`, { planVersion }, 30_000);
export const requestPlanChanges = (id: number, planVersion: number, feedback: string): Promise<RunDetail> => request("POST", `/api/runs/${id}/plan/request-changes`, { planVersion, feedback }, 30_000);
export const cancelRun = (id: number): Promise<RunDetail> => request("POST", `/api/runs/${id}/cancel`, {}, 30_000);

export type ApprovalStatus = "pending" | "allowed" | "declined" | "superseded";

/** One request an agent made that the owner answers. */
export interface Approval {
  id: number;
  /** The task whose agent asks; null when a run's planner or a chat asks. */
  taskId: number | null;
  /** True when a chat's Claude Code asks: its card is shown in the chat. */
  chat: boolean;
  /** The run whose planner asks, when no task does. */
  runId: number | null;
  /** The first line of the task's prompt, or of what the run was given. */
  taskTitle: string;
  attemptId: number;
  role: string;
  tool: string;
  /** The shell command in full, or what the tool was aimed at. */
  command: string;
  /** Relative to the task's worktree: "." is its top, "" when it is not known. */
  cwd: string;
  /** The agent's own account of why, when there is one. */
  reason: string | null;
  toolCallId: string;
  status: ApprovalStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** Set when the request was asked before Botbench restarted: its agent is stopped, and answering resumes the task. */
  parkedAt: string | null;
  /** The owner's answer to such a request, stored until the resumed task asks again. The status stays pending until then. */
  storedDecision: "allow" | "decline" | null;
  /** Present when this card may offer standing permission: the scope the grant would have. The server decides this, and decides again when it is asked for. */
  standingOffer?: StandingOffer;
  /** The request comes from a run that read a GitHub issue, written outside the project. */
  outsideText: boolean;
  /** Why it asks, in one plain line; null for a request from before Botbench recorded it. */
  asksBecause: string | null;
  /** Where a file tool's request is aimed: relative to the task's copy when inside it, a full path when not; null when it names none or it is not known. */
  target: string | null;
}

/** The scope of a standing permission a card offers. */
export interface StandingOffer {
  /** The exact command that would run without asking. */
  command: string;
  /** The repository, by its full path. */
  repo: string;
  /** Relative to a task's worktree: "." is its top. */
  cwd: string;
  role: string;
  /** How many times the owner has allowed exactly this. */
  approvals: number;
}

/** A standing permission in force. */
export interface StandingGrant {
  id: number;
  role: string;
  repo: string;
  cwd: string;
  command: string;
  /** The task whose card it was given from. */
  taskId: number | null;
  grantedAt: string;
  timesUsed: number;
  lastUsedAt: string | null;
}

export type LogRule =
  | "asked_owner"
  | "owner_allowed"
  | "owner_declined"
  | "ended_unanswered"
  | "auto_worktree_edit"
  | "broker_failure_denied"
  | "stored_answer_applied"
  | "stored_answer_discarded"
  | "preapproved"
  | "standing"
  | "standing_granted"
  | "standing_revoked"
  | "owner_accepted"
  | "owner_rejected"
  | "owner_discarded"
  | "mode_allowed"
  | "mode_refused"
  | "mode_accepted"
  | "delivery"
  | "web_allowed"
  | "web_refused"
  | "bookkeeping"
  | "issue_claim"
  | "sandboxed"
  /** The owner saved, edited or forgot a note in memory. The entry names the note by its number and holds none of its text. */
  | "memory";

/** One entry of the action log: what was asked, decided or run, and by which rule. */
export interface LogEntry {
  id: number;
  ts: string;
  taskId: number | null;
  rule: LogRule;
  tool: string;
  command: string;
  cwd: string;
  detail: string | null;
}

/** The approvals waiting for the owner's answer, oldest first. One whose answer is already stored no longer waits for the owner. */
export const listPendingApprovals = async (): Promise<Approval[]> =>
  (await request<{ approvals: Approval[] }>("GET", "/api/approvals?status=pending")).approvals.filter((approval) => approval.storedDecision === null);
export const answerApproval = (id: number, decision: "allow" | "decline", note?: string): Promise<{ approval: Approval }> =>
  request("POST", `/api/approvals/${id}`, note === undefined || note.trim() === "" ? { decision } : { decision, note }, 30_000);

/** Allow this request and give its command standing permission, with the scope its card offered. The server refuses a card that may not offer one. */
export const grantStanding = (id: number): Promise<{ approval: Approval; grant: StandingGrant }> => request("POST", `/api/approvals/${id}`, { decision: "allow", standing: true }, 30_000);
/** The standing permissions in force, and after how many approvals a card offers one. */
export const listGrants = (): Promise<{ grants: StandingGrant[]; offerStandingAfter: number }> => request("GET", "/api/grants", undefined, 30_000);
export const revokeGrant = (id: number): Promise<{ revoked: StandingGrant }> => request("POST", `/api/grants/${id}/revoke`, {}, 30_000);
/** One page of the action log, newest first: the entries older than `before`, or the newest. `older` says whether more remain. */
export const getActionLog = (limit: number, before?: number): Promise<{ entries: LogEntry[]; older: boolean }> =>
  request("GET", `/api/action-log?limit=${limit}${before === undefined ? "" : `&before=${before}`}`, undefined, 30_000);

/** An approval was asked for or answered. The approvals themselves are read from their route. */
export interface ApprovalAnnouncement {
  approvalId: number;
  taskId: number | null;
  runId: number | null;
  status: ApprovalStatus;
}

/** A task reached a state. The task itself is read from its route. */
export interface TaskAnnouncement {
  taskId: number;
  status: TaskStatus;
  attemptId: number | null;
}

export interface StreamHandlers {
  /** Called once per stored event, in id order, never twice for the same id. */
  onEvent(event: StoredEvent): void;
  /** Called with false when the stream drops and true when it is open again. */
  onConnection(connected: boolean): void;
  /** Called when the stream dropped because the session is gone. The stream stops. */
  onSignedOut(): void;
  /** Called when a task reached a state. */
  onTask?(announcement: TaskAnnouncement): void;
  /** Called when an approval was asked for or answered. */
  onApproval?(announcement: ApprovalAnnouncement): void;
  /** Called when a run reached a state or its plan changed. */
  onRun?(announcement: RunAnnouncement): void;
  /** Called when an agent's sign-in moved on, or it was signed out. */
  onAgent?(announcement: { driver: string; state: string }): void;
}

const RECONNECT_MS = [500, 1000, 2000, 5000];
/** The server sends a heartbeat every 15 seconds. A stream silent for this long is taken to be dead. */
const SILENCE_MS = 35_000;

/**
 * Open the one event stream and keep it open. `after` is the id of the last
 * event the caller already has (0 for none): the server sends everything
 * stored after it and then each new event. After a drop the stream reconnects
 * from the last id it delivered, so the caller sees no gap and no repeat.
 * Returns a function that closes it for good.
 */
export function openEventStream(after: number, handlers: StreamHandlers): () => void {
  let lastId = after;
  let source: EventSource | null = null;
  let timer: number | undefined;
  let silence: number | undefined;
  let failures = 0;
  let stopped = false;

  const drop = (): void => {
    // Reconnecting is done here, not by the browser, so the address always carries the newest id.
    window.clearTimeout(silence);
    source?.close();
    source = null;
    if (stopped) return;
    handlers.onConnection(false);
    retry();
  };
  /** Something arrived, so the stream is alive. A connection can die without the browser noticing, on a phone above all. */
  const alive = (): void => {
    window.clearTimeout(silence);
    silence = window.setTimeout(drop, SILENCE_MS);
  };

  const connect = (): void => {
    if (stopped) return;
    // With nothing received yet there is no id to resume from, and the stream starts at now.
    source = new EventSource(lastId > 0 ? `/api/stream?after=${lastId}` : "/api/stream", { withCredentials: true });
    source.onopen = () => {
      failures = 0;
      alive();
      handlers.onConnection(true);
    };
    source.addEventListener("heartbeat", alive);
    source.addEventListener("task", (message) => {
      alive();
      handlers.onTask?.(JSON.parse((message as MessageEvent<string>).data) as TaskAnnouncement);
    });
    source.addEventListener("run", (message) => {
      alive();
      handlers.onRun?.(JSON.parse((message as MessageEvent<string>).data) as RunAnnouncement);
    });
    source.addEventListener("approval", (message) => {
      alive();
      handlers.onApproval?.(JSON.parse((message as MessageEvent<string>).data) as ApprovalAnnouncement);
    });
    source.addEventListener("agent", (message) => {
      alive();
      handlers.onAgent?.(JSON.parse((message as MessageEvent<string>).data) as { driver: string; state: string });
    });
    source.onmessage = (message) => {
      alive();
      const event = JSON.parse(message.data as string) as StoredEvent;
      if (event.id <= lastId) return;
      lastId = event.id;
      handlers.onEvent(event);
    };
    source.onerror = drop;
    alive();
  };
  /** Wait, then reconnect if the session still stands. A server that cannot be reached is tried again. */
  const retry = (): void => {
    const wait = RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)]!;
    failures += 1;
    timer = window.setTimeout(() => {
      hasSession().then(
        (signedIn) => {
          if (stopped) return;
          if (signedIn) return connect();
          stopped = true;
          handlers.onSignedOut();
        },
        () => {
          if (!stopped) retry();
        },
      );
    }, wait);
  };

  connect();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearTimeout(silence);
    source?.close();
  };
}

/** The usage report: tokens by agent and model, for the last 7 days and all time, and by run. Never a dollar amount. */
export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}
export interface UsageAgent extends UsageTotals {
  driver: string;
  billing: "subscription" | "metered" | "unknown";
  models: (UsageTotals & { model: string | null })[];
}
export interface UsageScope extends UsageTotals {
  agents: UsageAgent[];
}
export interface UsageRun extends UsageTotals {
  id: number;
  kind: "planned" | "single";
  title: string;
  createdAt: string;
  planning: UsageTotals;
  tasks: (UsageTotals & { id: number; title: string })[];
}
export interface UsageReport {
  since: string;
  week: UsageScope;
  allTime: UsageScope;
  runs: { total: number; items: UsageRun[] };
}
/** The server asks the agent for its sign-in, which can take a few seconds. */
export const getUsage = (): Promise<UsageReport> => request("GET", "/api/usage", undefined, 20_000);

/** Notifications (unit 23): a device's subscription as the browser makes it (`PushSubscription.toJSON()`). */
export interface DeviceSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export const getPushKey = async (): Promise<string> => (await request<{ publicKey: string }>("GET", "/api/push", undefined, 10_000)).publicKey;
export const savePushSubscription = (subscription: DeviceSubscription): Promise<unknown> => request("POST", "/api/push/subscriptions", subscription, 10_000);
export const removePushSubscription = (endpoint: string): Promise<unknown> => request("POST", "/api/push/unsubscribe", { endpoint }, 10_000);
export const pushSubscribed = async (endpoint: string): Promise<boolean> => (await request<{ subscribed: boolean }>("POST", "/api/push/check", { endpoint }, 10_000)).subscribed;
export const sendTestNotification = (endpoint: string): Promise<unknown> => request("POST", "/api/push/test", { endpoint }, 20_000);

/** A device signed in to Botbench: its label from the browser it signed in with, and when it signed in and was last used. */
export interface SignedInDevice {
  id: number;
  device: string;
  signedInAt: string;
  lastUsedAt: string;
  /** The device this request came from. */
  current: boolean;
}
export const listDevices = async (): Promise<SignedInDevice[]> => (await request<{ devices: SignedInDevice[] }>("GET", "/api/devices", undefined, 10_000)).devices;
export const signOutDevice = (id: number): Promise<unknown> => request("POST", `/api/devices/${id}/sign-out`, {}, 10_000);
export const signOutOtherDevices = (): Promise<unknown> => request("POST", "/api/devices/sign-out-others", {}, 10_000);
