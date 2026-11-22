/*
 * The only module that talks to the Botbench server. Every request goes to the
 * origin the page came from and carries the session cookie.
 */

export type TurnEndReason = "completed" | "interrupted" | "error";

/** The normalized events a driver emits; the same union as the server's `DriverEvent`. */
export type DriverEvent =
  | { type: "user_prompt"; text: string }
  | { type: "session_started"; resumeCursor: string; model: string | null; keySource: string | null }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean; confined?: { hosts: string[]; files: boolean } }
  | { type: "permission_denied"; id: string; name: string; reason: string | null; code?: string | null }
  | { type: "permission_request"; id: string; toolCallId: string; name: string; input: unknown; reason: string | null }
  | { type: "permission_resolved"; id: string; toolCallId: string; decision: "allowed" | "preapproved" | "standing" | "declined" | "denied" | "cancelled"; note: string | null }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "rate_limit"; limited: boolean; status: string; resetsAt: string | null }
  | { type: "turn_ended"; reason: TurnEndReason; detail: string | null }
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

export interface Transcript {
  attemptId: number;
  status: string;
  turnRunning: boolean;
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

async function request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, timeoutMs?: number, giveUp?: AbortSignal): Promise<T> {
  const signals = [...(timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)]), ...(giveUp ? [giveUp] : [])];
  const res = await fetch(path, {
    method,
    ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
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

export async function interruptTurn(attemptId: number): Promise<void> {
  await request("POST", `/api/turns/${attemptId}/interrupt`, {});
}

export const getTranscript = (attemptId: number): Promise<Transcript> => request("GET", `/api/attempts/${attemptId}/events`);

export type TaskStatus = "queued" | "building" | "verifying" | "awaiting_decision" | "accepted" | "rejected" | "interrupted" | "failed" | "cancelled";

/** The owner's decision on a task, as it was recorded. */
export interface TaskDecision {
  decision: "accept" | "reject";
  /** What became of the task's branch. */
  branch: "kept" | "deleted";
  branchName: string;
  /** The files the checks left in the task's copy, removed with it. */
  leftovers: string[];
  decidedBy: "owner";
  decidedAt: string;
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
  /** The task's agent asked for permission and is paused until the owner answers. */
  waitingOnApproval: boolean;
  /** A request that waits for the owner was asked before Botbench restarted: the agent is stopped, and the answer resumes the task. */
  parked: boolean;
  /** The owner's answer to such a request is stored, and the task is being started again to receive it. */
  resuming: boolean;
  /** The run whose approved plan queued this task, or null for a task started on its own. */
  ofPlan: number | null;
  /** The commands this task may run without asking, as the owner listed them when starting it. */
  preapproved: string[];
  /** The owner's decision, once there is one. */
  decision: TaskDecision | null;
  /** For a stopped task Resume can take up again: what Resume will do, in words. Null when it cannot be resumed. */
  resumeNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  binary: boolean;
}

export interface TaskDetail extends TaskSummary {
  /** The files changed from the base commit to Botbench's commit; null until there is a commit, or when they cannot be read. */
  files: FileChange[] | null;
  filesProblem: string | null;
  /** The commands Botbench ran on the task, in the order they ran. */
  evidence: Evidence[];
  /** For a task that is ready for review: the files the checks left in its copy that are not on its branch. Null otherwise, or when they cannot be read. */
  leftovers: string[] | null;
  /** For a task that failed, was stopped or was cancelled: what it left, which Discard removes. Null otherwise, or when it cannot be read. */
  remains: TaskRemains | null;
  remainsProblem: string | null;
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
}
export const getRepoSettings = (path: string, giveUp: AbortSignal): Promise<RepoSettings> =>
  request("GET", `/api/repos/settings?path=${encodeURIComponent(path)}`, undefined, CHECK_REPO_LIMIT_MS, giveUp);
/** `preapproved` is exactly what this task's run may use without asking: the server grants nothing the request does not list. */
export const startTask = (repo: string, prompt: string, model: string | null | undefined, preapproved: string[]): Promise<{ taskId: number }> =>
  request("POST", "/api/tasks", { repo, prompt, ...withModel(model), preapproved }, 30_000);
export const listTasks = async (): Promise<TaskSummary[]> => (await request<{ tasks: TaskSummary[] }>("GET", "/api/tasks")).tasks;
export const getTask = (id: number): Promise<TaskDetail> => request("GET", `/api/tasks/${id}`);
/** Accept a task that is ready for review. `removeLeftovers` is the list of files its checks left, as the owner saw and confirmed them. */
export const acceptTask = (id: number, removeLeftovers: readonly string[]): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/accept`, { removeLeftovers }, 60_000);
/** Reject a task that is ready for review, keeping or deleting its branch. */
export const rejectTask = (id: number, branch: "keep" | "discard", removeLeftovers: readonly string[]): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/reject`, { branch, removeLeftovers }, 60_000);
/** Remove the copy and branch of a task that failed, was stopped or was cancelled. `removeFiles` is the list of files not on the branch, as the owner saw and confirmed it. */
export const discardTask = (id: number, removeFiles: readonly string[]): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/discard`, { removeFiles }, 60_000);
/** Take up a stopped task again. Refused (409, with the reason) for a task in any other state. */
export const resumeTask = (id: number): Promise<TaskDetail> => request("POST", `/api/tasks/${id}/resume`, {}, 30_000);
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
  createdAt: string;
  updatedAt: string;
}

export interface RunDetail extends Omit<RunSummary, "taskCount" | "finishedCount" | "readyCount" | "decidedCount"> {
  prompt: string | null;
  specPath: string | null;
  specText: string | null;
  /** The model asked for the planner; null is the CLI's own default. */
  requestedModel: string | null;
  plannerModel: string | null;
  baseCommit: string;
  /** The plan's version. A decision names the version it was made on, and is refused when the plan has changed since. */
  planVersion: number;
  plan: PlanTask[];
  /** The tasks made when the plan was approved, in plan order: where each stands, and the commands Botbench ran on it. */
  tasks: RunTask[];
  /** The commands the run's builders may use without asking, as the owner listed them when starting it. */
  preapproved: string[];
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
  waitingOnApproval: boolean;
  evidence: Evidence[];
  decision: TaskDecision | null;
  leftovers: string[] | null;
  /** For a stopped task Resume can take up again: what Resume will do, in words. Null when it cannot be resumed. */
  resumeNote: string | null;
}

/** A run reached a state or its plan changed. The run itself is read from its route. */
export interface RunAnnouncement {
  runId: number;
  status: RunStatus;
}

/** Exactly one of `prompt` and `specPath`. `preapproved` is exactly what the run's builders may use without asking. */
export const startRun = (o: { repo: string; prompt?: string; specPath?: string; model: string | null | undefined; preapproved: string[] }): Promise<{ runId: number }> =>
  request("POST", "/api/runs", { repo: o.repo, ...(o.prompt === undefined ? {} : { prompt: o.prompt }), ...(o.specPath === undefined ? {} : { specPath: o.specPath }), ...withModel(o.model), preapproved: o.preapproved }, 30_000);
export const listRuns = async (): Promise<RunSummary[]> => (await request<{ runs: RunSummary[] }>("GET", "/api/runs", undefined, 30_000)).runs;
/** One row of the board: a planned run, or a task started on its own (a run of one). */
export type BoardItem = ({ kind: "run" } & RunSummary) | { kind: "task"; id: number; repo: string; title: string; status: TaskStatus; reason: string | null; checks: ChecksMark | null; waitingOnApproval: boolean; resuming: boolean; createdAt: string; updatedAt: string };
export type BoardGroupName = "needs-you" | "running" | "finished";
/** One group of the board: its real count, and its items (Finished sends only its newest). */
export interface BoardGroup {
  name: BoardGroupName;
  total: number;
  items: BoardItem[];
}
/** The board's groups in order, the one that needs the owner first, each newest change first. */
export const getBoard = async (): Promise<BoardGroup[]> => (await request<{ groups: BoardGroup[] }>("GET", "/api/board", undefined, 30_000)).groups;
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
  /** The task whose agent asks; null when a run's planner asks. */
  taskId: number | null;
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
  | "owner_discarded";

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
