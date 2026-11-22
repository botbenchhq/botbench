/*
 * The only module that talks to the Smelt server. Every request goes to the
 * origin the page came from and carries the session cookie.
 */

export type TurnEndReason = "completed" | "interrupted" | "error";

/** The normalized events a driver emits; the same union as the server's `DriverEvent`. */
export type DriverEvent =
  | { type: "user_prompt"; text: string }
  | { type: "session_started"; resumeCursor: string; model: string | null; keySource: string | null }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | { type: "permission_denied"; id: string; name: string; reason: string | null }
  | { type: "permission_request"; id: string; toolCallId: string; name: string; input: unknown; reason: string | null }
  | { type: "permission_resolved"; id: string; toolCallId: string; decision: "allowed" | "declined" | "denied" | "cancelled"; note: string | null }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "rate_limit"; limited: boolean; status: string; resetsAt: string | null }
  | { type: "turn_ended"; reason: TurnEndReason; detail: string | null }
  | { type: "error"; message: string; raw: string | null };

/** One stored event, from the stream or from a transcript request. */
export interface StoredEvent {
  attemptId: number;
  id: number;
  turn: number;
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

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number, giveUp?: AbortSignal): Promise<T> {
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
  models: { id: string; label?: string }[];
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

export type TaskStatus = "queued" | "building" | "awaiting_decision" | "interrupted" | "failed";

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
  /** The task's agent asked for permission and is paused until the owner answers. */
  waitingOnApproval: boolean;
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
  /** The files changed from the base commit to Smelt's commit; null until there is a commit, or when they cannot be read. */
  files: FileChange[] | null;
  filesProblem: string | null;
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
export const startTask = (repo: string, prompt: string, model?: string | null): Promise<{ taskId: number }> => request("POST", "/api/tasks", { repo, prompt, ...withModel(model) }, 30_000);
export const listTasks = async (): Promise<TaskSummary[]> => (await request<{ tasks: TaskSummary[] }>("GET", "/api/tasks")).tasks;
export const getTask = (id: number): Promise<TaskDetail> => request("GET", `/api/tasks/${id}`);
export const getTaskDiff = (id: number, file: string): Promise<{ file: string; diff: string; truncated: boolean }> =>
  request("GET", `/api/tasks/${id}/diff?file=${encodeURIComponent(file)}`);

export type ApprovalStatus = "pending" | "allowed" | "declined" | "superseded";

/** One request an agent made that the owner answers. */
export interface Approval {
  id: number;
  taskId: number;
  /** The first line of the task's prompt. */
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
}

/** The approvals waiting for an answer, oldest first. */
export const listPendingApprovals = async (): Promise<Approval[]> => (await request<{ approvals: Approval[] }>("GET", "/api/approvals?status=pending")).approvals;
export const answerApproval = (id: number, decision: "allow" | "decline", note?: string): Promise<{ approval: Approval }> =>
  request("POST", `/api/approvals/${id}`, note === undefined || note.trim() === "" ? { decision } : { decision, note }, 30_000);

/** An approval was asked for or answered. The approvals themselves are read from their route. */
export interface ApprovalAnnouncement {
  approvalId: number;
  taskId: number;
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
