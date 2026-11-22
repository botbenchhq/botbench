import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stepWords } from "../engine/roles.ts";
import { now, transaction } from "../store/db.ts";
import type { FloorEntry } from "./floor.ts";
import { gate, READ_ONLY_TOOLS, real, summarize, type FloorSettings } from "./gate.ts";
import { approvalCount, findStanding, insertRevocation, insertStanding, listStanding, runGrants, showWords, standingGrants, standingProblem, type Grant, type StandingGrant } from "./grants.ts";
import { splitPlain } from "./shell.ts";

/*
 * The permission broker. Everything an agent wants to do that is not an edit
 * inside its worktree ends here as an approval the owner answers.
 *
 * Two ways in, and they are not equal:
 *   request()   called inside Botbench when a CLI asks for permission. It writes
 *               the approval and waits for the owner. Only answer() resolves it,
 *               and answer() is reachable only through the signed-in API.
 *   the socket  used by the pre-tool hook Botbench gives the CLI. It carries one
 *               question, "what does the gate say about this call?", and the
 *               reply is pass, ask or deny. It cannot allow anything and
 *               cannot answer an approval.
 * Whatever goes wrong on either way, the outcome is a refusal.
 *
 * Grants are read in request() only. A command on its run's pre-approved list, or one the owner gave standing
 * permission, is allowed there without an approval, after the safety floor had its say, and logged with the grant
 * it ran on. The socket is never told of a grant: for every shell command, granted or not, the hook hears "ask",
 * and the CLI's request that follows is what request() answers.
 *
 * Standing permission is earned: once the owner has allowed the same command for the same role, repository and
 * directory the configured number of times, the next card for it may offer one. How often that was is counted
 * from the approvals and the log each time it is asked; nothing else holds the number. Only the owner's answer,
 * through the signed-in API, turns an offer into a grant, and only the owner takes one back.
 *
 * Across a restart: an approval that was pending when Botbench stopped stays pending and is marked parked. Nothing
 * waits for it in this process, so the owner's answer cannot be handed to anyone: it is stored on the approval.
 * The engine then re-drives the task, and the stored answer goes, once, to the first request of the resuming
 * attempt that asks for the same thing: same task, same role, same tool, same command, same directory. If that
 * attempt's first request is anything else, the stored answer is discarded and the request is asked afresh.
 */

export const SOCKET_FILE = "broker.sock";

/** Whether a live broker answers on the socket at `socketPath`: then its data directory belongs to a running process. */
export function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve(false);
    const probe = net.connect(socketPath);
    const done = (taken: boolean): void => {
      probe.destroy();
      resolve(taken);
    };
    probe.setTimeout(2000, () => done(true));
    probe.on("connect", () => done(true));
    probe.on("error", () => done(false));
  });
}
/** A command longer than this cannot be read in full on a card, so it is not put on one. */
export const MAX_COMMAND = 20_000;
export const MAX_NOTE = 2000;
/** One message on the socket: the hook sends a tool's name and where it is aimed, never file contents. */
const MAX_MESSAGE = 256 * 1024;
const SOCKET_READ_MS = 10_000;
/** The agent's own account of why is shown on the card; it is kept short. */
const MAX_REASON = 500;
/** How many tool calls' directories are remembered per attempt between the hook seeing a call and the CLI asking about it. */
const MAX_SEEN = 500;

export type ApprovalStatus = "pending" | "allowed" | "declined" | "superseded";
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ["pending", "allowed", "declined", "superseded"];
export type Decision = "allow" | "decline";
/** Why something ran or did not: the rule that decided. */
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
  /** A command ran on a standing permission; the owner gave one; the owner took one back. Each entry names its grant. */
  | "standing"
  | "standing_granted"
  | "standing_revoked"
  /** The owner accepted or rejected a task that was ready for review. The entry names the task's branch. */
  | "owner_accepted"
  | "owner_rejected"
  /** The owner discarded what a failed, stopped or cancelled task left behind. */
  | "owner_discarded";
/** How many approvals of the same command earn the offer of standing permission, when the owner's config does not say. */
export const OFFER_STANDING_AFTER = 3;

/** What a card offers when its command has been allowed often enough: the scope a standing permission would have, in the grant's own terms. */
export interface StandingOffer {
  /** The command, as one line that splits into the words that would be granted. */
  command: string;
  /** The source repository's real path. */
  repo: string;
  /** Relative to the worktree's top. */
  cwd: string;
  role: string;
  /** How many times the owner has allowed exactly this so far. */
  approvals: number;
}

export interface Approval {
  id: number;
  /** The task whose agent asks. Null when a run's planner asks: then `runId` names the run. */
  taskId: number | null;
  /** The run whose planner asks, when no task does. */
  runId: number | null;
  /** The first line of the task's prompt, or of what the run was given, so a card can say who is asking. */
  taskTitle: string;
  attemptId: number;
  role: string;
  tool: string;
  /** The shell command in full, or what the tool was aimed at. */
  command: string;
  /** The directory the agent stood in, relative to the worktree; "." is its top, "" when it is not known. */
  cwd: string;
  /** The agent's own account of why, when the CLI passes one on. */
  reason: string | null;
  toolCallId: string;
  status: ApprovalStatus;
  /** What the owner wrote for the agent when declining. */
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** When a start of Botbench found this approval pending from before: its agent is stopped, and answering re-drives the task. Null for one asked in this run. */
  parkedAt: string | null;
  /** The owner's answer to a parked approval, kept until the re-driven task asks again. The status stays `pending` until then. */
  storedDecision: Decision | null;
}

export interface LogEntry {
  id: number;
  ts: string;
  taskId: number | null;
  /** The run whose planner the entry is about, when it is about no task. */
  runId: number | null;
  attemptId: number | null;
  approvalId: number | null;
  /** The grant a pre-approved or standing command ran on, or the standing grant that was given or taken back. */
  grantId: number | null;
  rule: LogRule;
  tool: string;
  command: string;
  cwd: string;
  detail: string | null;
}

export interface ApprovalRequest {
  /** The task whose agent asks, or null when a run's planner does. */
  taskId: number | null;
  /** The run whose planner asks. Left out for a task's request. */
  runId?: number | null;
  attemptId: number;
  role: string;
  tool: string;
  command: string;
  /** The tool call's input as the CLI gave it. Only with it can a grant apply: a grant is matched on the input an allow would let run. */
  input?: unknown;
  /** Relative to the worktree. Left out, the broker uses the directory its hook saw for this tool call. */
  cwd?: string;
  reason: string | null;
  toolCallId: string;
}

/** How a request ended. `approvalId` is null when no approval could be recorded. */
export interface Answer {
  decision: Decision;
  note: string | null;
  approvalId: number | null;
  /** Set when the broker itself refused the request and the owner was never asked: why, in words. */
  refused: string | null;
  /** Set when the request was allowed on the run's pre-approved list and the owner was not asked: the grant it ran on. */
  preapproved?: { grantId: number };
  /** Set when the request was allowed on a standing permission and the owner was not asked: the grant it ran on. */
  standing?: { grantId: number };
}

/** An answer that cannot be taken; `status` is the HTTP answer for it. */
export class ApprovalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One attempt's right to use the socket. */
export interface Admission {
  socketPath: string;
  /** Known to this attempt's CLI process only, through its environment. */
  secret: string;
  /** Name the attempt once its row exists. Until then the secret is refused. */
  bind(attemptId: number): void;
  /** The CLI stopped waiting for these tool calls (all of the attempt's when none is named): their approvals end unanswered. */
  supersede(toolCallId?: string): void;
  /** Botbench is stopping while the attempt waits for the owner: the secret stops working and the attempt's pending approvals stay pending, parked, for the next start. */
  park(): void;
  /** The attempt is over: the secret stops working and nothing of it is left pending. */
  release(): void;
}

export interface Broker {
  readonly socketPath: string;
  /** Open the socket. Rejects when it cannot be opened; requests through it are then refused by the hook itself. */
  listen(): Promise<void>;
  /** `resumes` names the attempt this one continues after a restart: only then can it be given that attempt's stored answers. */
  /**
   * Admit an attempt of a task, or of a run's planner (`runId` and no `taskId`). `readOnly` is for a role that changes
   * nothing: the gate then refuses every edit, also inside the worktree, and no grant lets a command through.
   */
  admit(o: { taskId?: number; runId?: number; role: string; worktree: string; resumes?: number; readOnly?: boolean }): Admission;
  /** Record a pending approval and wait for the owner. Never rejects: any failure is a decline. */
  request(request: ApprovalRequest): Promise<Answer>;
  /**
   * The owner's answer. Throws `ApprovalError` for an unknown approval or one that is no longer pending.
   * For a parked approval the answer is stored, the approval stays pending, and the listeners of `onStoredAnswer` are told.
   */
  answer(id: number, decision: Decision, note?: string | null): Approval;
  /** How many approvals of the same command earn the offer of standing permission. */
  readonly offerStandingAfter: number;
  /**
   * What the card of a pending approval may offer as standing permission, or null when it may offer none: the
   * request is not one plain shell command, the floor always asks about it, its directory is not known, it was
   * asked before a restart, it already has standing permission, or it was not allowed often enough yet.
   */
  standingOffer(id: number): StandingOffer | null;
  /**
   * The owner's answer "allow, and stop asking for this": the approval is allowed and a standing grant with the
   * offered scope is stored, with both log entries, in one write. Throws `ApprovalError` for an unknown approval
   * (404) and for one that is not pending or may not be offered standing permission (409); nothing is written then.
   */
  grantStanding(id: number): { approval: Approval; grant: StandingGrant };
  /** The owner takes a standing permission back. Throws `ApprovalError`: 404 when there is none with this id, 409 when it was already taken back. */
  revokeStanding(id: number): StandingGrant;
  /** Be told when the owner's answer to a parked approval was stored, so its task can be re-driven. */
  onStoredAnswer(listener: (approval: Approval) => void): void;
  /** End every pending approval of a task that cannot go on, with the reason for the log. Stored answers among them are discarded. */
  endParked(taskId: number, why: string): void;
  /** End every pending approval of a run's planner, with the reason for the log. */
  endRunApprovals(runId: number, why: string): void;
  pending(): Approval[];
  /** Close the socket and end everything still pending as superseded. Safe to call twice. */
  close(): Promise<void>;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" ? v : null);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const firstLine = (s: string, max = 60): string => {
  const line = s.trim().split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

function toApproval(row: Record<string, unknown>): Approval {
  return {
    id: Number(row.id),
    taskId: int(row.task_id),
    runId: int(row.run_id),
    taskTitle: firstLine(String(row.prompt ?? "")),
    attemptId: Number(row.attempt_id),
    role: String(row.role),
    tool: String(row.tool),
    command: String(row.command),
    cwd: String(row.cwd),
    reason: text(row.reason),
    toolCallId: String(row.tool_call_id),
    status: String(row.status) as ApprovalStatus,
    note: text(row.note),
    createdAt: String(row.created_at),
    resolvedAt: text(row.resolved_at),
    parkedAt: text(row.parked_at),
    storedDecision: row.stored_decision === "allow" || row.stored_decision === "decline" ? row.stored_decision : null,
  };
}

/** An approval with what its card is titled by: its task's prompt, or what its run was given (the prompt, or the spec file's path). */
const APPROVAL_COLUMNS = "a.*, COALESCE(t.prompt, r.prompt, r.spec_path) AS prompt FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN runs r ON r.id = a.run_id";

/** Approvals, oldest first; all of them or those with one status. */
export function listApprovals(db: DatabaseSync, status?: ApprovalStatus): Approval[] {
  const rows = status === undefined ? db.prepare(`SELECT ${APPROVAL_COLUMNS} ORDER BY a.id`).all() : db.prepare(`SELECT ${APPROVAL_COLUMNS} WHERE a.status = ? ORDER BY a.id`).all(status);
  return rows.map(toApproval);
}

export function getApproval(db: DatabaseSync, id: number): Approval | null {
  const row = db.prepare(`SELECT ${APPROVAL_COLUMNS} WHERE a.id = ?`).get(id);
  return row ? toApproval(row) : null;
}

/** Whether the task has a request waiting for the owner's answer. One whose answer is stored and not yet applied no longer waits for the owner. */
export function waitingOnApproval(db: DatabaseSync, taskId: number): boolean {
  return db.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND status = 'pending' AND stored_decision IS NULL LIMIT 1").get(taskId) !== undefined;
}

/** A task's approvals that are still pending, oldest first: those waiting for the owner and those whose stored answer is not yet applied. */
export function pendingApprovals(db: DatabaseSync, taskId: number): Approval[] {
  return db.prepare(`SELECT ${APPROVAL_COLUMNS} WHERE a.task_id = ? AND a.status = 'pending' ORDER BY a.id`).all(taskId).map(toApproval);
}

const toLogEntry = (row: Record<string, unknown>): LogEntry => ({
  id: Number(row.id),
  ts: String(row.ts),
  taskId: int(row.task_id),
  runId: int(row.run_id),
  attemptId: int(row.attempt_id),
  approvalId: int(row.approval_id),
  grantId: int(row.grant_id),
  rule: String(row.rule) as LogRule,
  tool: String(row.tool),
  command: String(row.command),
  cwd: String(row.cwd),
  detail: text(row.detail),
});

/** The action log, oldest first; everything or one task's. The log is only ever read here and added to by `appendLog`. */
export function actionLog(db: DatabaseSync, taskId?: number): LogEntry[] {
  const rows = taskId === undefined ? db.prepare("SELECT * FROM action_log ORDER BY id").all() : db.prepare("SELECT * FROM action_log WHERE task_id = ? ORDER BY id").all(taskId);
  return rows.map(toLogEntry);
}

/** The most entries one page of the action log holds, and how many it holds when the reader does not say. */
export const MAX_LOG_PAGE = 200;
export const LOG_PAGE = 50;

/**
 * One page of the action log, newest first: at most `limit` entries older than the entry `before` (the newest
 * when left out), everything or one task's. `older` says whether entries older than the page exist. Entries are
 * only ever added, with rising ids, so a page named by `before` holds the same entries whenever it is read.
 */
export function actionLogPage(db: DatabaseSync, o: { before?: number; limit?: number; taskId?: number }): { entries: LogEntry[]; older: boolean } {
  const limit = Math.min(o.limit ?? LOG_PAGE, MAX_LOG_PAGE);
  const where = ["id < ?", ...(o.taskId === undefined ? [] : ["task_id = ?"])].join(" AND ");
  const rows = db.prepare(`SELECT * FROM action_log WHERE ${where} ORDER BY id DESC LIMIT ?`).all(o.before ?? Number.MAX_SAFE_INTEGER, ...(o.taskId === undefined ? [] : [o.taskId]), limit + 1);
  return { entries: rows.slice(0, limit).map(toLogEntry), older: rows.length > limit };
}

export interface LogWrite {
  taskId: number | null;
  runId?: number | null;
  attemptId: number | null;
  approvalId?: number | null;
  grantId?: number | null;
  rule: LogRule;
  tool: string;
  command: string;
  cwd: string;
  detail?: string | null;
}

/** Add one entry to the action log. The broker writes every entry but the owner's decisions on tasks (engine/decision.ts). */
export function appendLog(db: DatabaseSync, e: LogWrite): void {
  db.prepare("INSERT INTO action_log (ts, task_id, run_id, attempt_id, approval_id, grant_id, rule, tool, command, cwd, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(now(), e.taskId, e.runId ?? null, e.attemptId, e.approvalId ?? null, e.grantId ?? null, e.rule, e.tool, e.command, e.cwd, e.detail ?? null);
}

interface Ticket {
  taskId: number | null;
  runId: number | null;
  /** The attempt changes nothing: every edit is refused and no grant applies. */
  readOnly: boolean;
  role: string;
  worktree: string;
  attemptId: number | null;
  /** The attempt this one continues after a restart, whose stored answers it may be given. */
  resumes: number | null;
  /** Tool call id to the directory the hook saw it made from, relative to the worktree. */
  seen: Map<string, string>;
}

type Verdict = "pass" | "ask" | "deny";
interface Reply {
  verdict: Verdict;
  reason: string;
}

const hashOf = (secret: string): string => createHash("sha256").update(secret).digest("hex");
const shorten = (s: string, max = 500): string => (s.length > max ? `${s.slice(0, max)}…` : s);

export function createBroker(options: {
  db: DatabaseSync;
  home: string;
  onChange: (approval: Approval) => void;
  /** Entries the owner's config adds to the safety floor. */
  floor?: readonly FloorEntry[];
  /** How many approvals of the same command earn the offer of standing permission: a whole number of at least 1. */
  offerStandingAfter?: number;
}): Broker {
  const { db } = options;
  const offerStandingAfter = options.offerStandingAfter ?? OFFER_STANDING_AFTER;
  if (!Number.isSafeInteger(offerStandingAfter) || offerStandingAfter < 1) throw new Error(`offerStandingAfter must be a whole number of at least 1, not ${String(options.offerStandingAfter)}.`);
  const floorSettings: FloorSettings = { home: os.homedir(), dataDir: options.home, ...(options.floor ? { extra: options.floor } : {}) };
  const socketPath = path.join(options.home, SOCKET_FILE);
  /** Admissions by the hash of their secret: the secret itself is held only by the admission and the CLI child. */
  const tickets = new Map<string, Ticket>();
  const waiters = new Map<number, (answer: Answer) => void>();
  const storedListeners: ((approval: Approval) => void)[] = [];
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  let closed = false;

  /** A refusal goes on record. If the record itself cannot be written, the refusal still stands and the reason is printed. */
  const refuse = (e: Omit<LogWrite, "rule">): void => {
    for (const ids of [{ taskId: e.taskId, runId: e.runId ?? null, attemptId: e.attemptId }, { taskId: null, runId: null, attemptId: null }]) {
      try {
        appendLog(db, { ...e, ...ids, rule: "broker_failure_denied", tool: shorten(e.tool, 200), command: shorten(e.command, 2000) });
        return;
      } catch (err) {
        // The ids may be what cannot be stored (a task that does not exist): the entry is tried once more without them.
        if (ids.taskId === null && ids.attemptId === null) console.error(`A denied request could not be logged: ${words(err)} (${e.detail ?? ""})`);
      }
    }
  };

  /** Tell whoever listens. A listener that fails must not undo or hide a decision already written. */
  const announce = (id: number): void => {
    try {
      const approval = getApproval(db, id);
      if (approval) options.onChange(approval);
    } catch (err) {
      console.error(`An approval change could not be announced: ${words(err)}`);
    }
  };

  /**
   * End pending approvals as superseded, with `why` for the log. Their waiting requests are told "decline": nothing
   * runs on a superseded approval. One that carried the owner's stored answer is logged as that answer discarded.
   */
  const supersedeWhere = (why: string | null, where: string, ...values: (string | number)[]): void => {
    let ids: number[] = [];
    try {
      ids = transaction(db, () => {
        const rows = db.prepare(`SELECT * FROM approvals WHERE status = 'pending' AND ${where} ORDER BY id`).all(...values);
        db.prepare(`UPDATE approvals SET status = 'superseded', resolved_at = ? WHERE status = 'pending' AND ${where}`).run(now(), ...values);
        // The asking is in the log, so its end is too.
        for (const row of rows) {
          appendLog(db, { taskId: int(row.task_id), runId: int(row.run_id), attemptId: Number(row.attempt_id), approvalId: Number(row.id), rule: row.stored_decision === null ? "ended_unanswered" : "stored_answer_discarded", tool: String(row.tool), command: String(row.command), cwd: String(row.cwd), detail: why });
        }
        return rows.map((row) => Number(row.id));
      });
    } catch (err) {
      console.error(`Pending approvals could not be marked superseded: ${words(err)}`);
    }
    for (const id of ids) {
      waiters.get(id)?.({ decision: "decline", note: null, approvalId: id, refused: null });
      waiters.delete(id);
      announce(id);
    }
  };

  type RequestVerdict = { verdict: "ask"; floor?: string } | { verdict: "deny"; reason: string } | { verdict: "allow"; rule: "preapproved" | "standing"; grant: Grant };

  /**
   * The gate's word on a permission request of the CLI. Only a shell command can come out allowed, and only when
   * everything about it is known: the attempt's own admission, the directory its hook reported, the input an allow
   * would let run, and the task's run and repository. Anything missing or unreadable means the owner is asked.
   */
  const decideRequest = (r: ApprovalRequest, ticket: Ticket | undefined, cwd: string): RequestVerdict => {
    if (r.tool !== "Bash" || !ticket || ticket.taskId !== r.taskId || ticket.runId !== (r.runId ?? null) || ticket.role !== r.role) return { verdict: "ask" };
    try {
      // Grants are looked up only when the directory was reported and the input is the one the card would show.
      // Without them the gate still asks the floor, at the worktree's top, so that the record says why this asks.
      // A read-only attempt, and one that belongs to no task, is never looked up: every command of a planner asks.
      const known = !ticket.readOnly && r.taskId !== null && cwd !== "" && isObject(r.input) && summarize(r.tool, r.input) === r.command;
      const at = path.resolve(ticket.worktree, cwd === "" ? "." : cwd);
      const input = known ? r.input : { command: r.command };
      const task = db.prepare("SELECT repo_path, run_id FROM tasks WHERE id = ?").get(r.taskId);
      const runId = known && task && typeof task.run_id === "number" ? task.run_id : null;
      // Who asks and where: only then can a grant apply. The repository is the task's, by the real path stored when
      // the task was started, so a standing permission earned in one task's worktree is the same one in the next task's.
      const scope = known && task ? { role: r.role, repo: String(task.repo_path), runId } : undefined;
      // Read from the store for this request: a standing permission taken back a moment ago is not among them.
      const grants = scope === undefined ? [] : [...(runId === null ? [] : runGrants(db, runId)), ...standingGrants(db, scope)];
      const verdict = gate({ tool: r.tool, input, worktree: ticket.worktree, cwd: at, ...(scope === undefined ? {} : { scope }) }, grants, floorSettings);
      if (verdict.verdict !== "allow") return verdict;
      if (verdict.rule !== "preapproved" && verdict.rule !== "standing") return { verdict: "ask" };
      const grant = grants.find((g) => g.id === verdict.grantId);
      return grant ? { verdict: "allow", rule: verdict.rule, grant } : { verdict: "ask" };
    } catch (err) {
      // The gate could not be asked: nothing is allowed on it, and the owner decides.
      console.error(`The gate could not decide about a request of task ${r.taskId}: ${words(err)}`);
      return { verdict: "ask" };
    }
  };

  const request = (r: ApprovalRequest): Promise<Answer> => {
    const ticket = [...tickets.values()].find((t) => t.attemptId === r.attemptId);
    const stillCarried = "task_id = ? AND attempt_id = ? AND stored_decision IS NOT NULL";
    const deny = (detail: string): Promise<Answer> => {
      refuse({ taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, tool: String(r.tool), command: String(r.command), cwd: typeof r.cwd === "string" ? r.cwd : "", detail });
      // A request Botbench refuses is still the resuming attempt's request: stored answers do not wait for a later one.
      if (ticket && ticket.resumes !== null && ticket.taskId !== null) supersedeWhere("After the restart the agent's first request was one Botbench refused, so the owner's stored answer was not used.", stillCarried, ticket.taskId, ticket.resumes);
      return Promise.resolve({ decision: "decline", note: null, approvalId: null, refused: detail });
    };
    if (closed) return deny("Botbench is shutting down, so nothing more is allowed.");
    if ((r.taskId === null) === (r.runId === undefined || r.runId === null)) return deny("The request names neither a task nor a run, or both.");
    if (typeof r.tool !== "string" || r.tool === "" || typeof r.toolCallId !== "string" || r.toolCallId === "" || typeof r.command !== "string" || r.command === "" || typeof r.role !== "string" || r.role === "") {
      return deny("The request does not say what it is for.");
    }
    if (r.command.length > MAX_COMMAND) return deny(`The request is ${r.command.length} characters long, too long to show the owner in full.`);
    // Also when the CLI asks without its hook having been heard: a read-only attempt's request for any other tool is never the owner's to allow.
    if (ticket?.readOnly && !READ_ONLY_TOOLS.has(r.tool)) return deny(`The ${stepWords(ticket.role)} only reads and may not use ${shorten(r.tool, 100)}.`);
    const cwd = r.cwd ?? ticket?.seen.get(r.toolCallId) ?? "";
    ticket?.seen.delete(r.toolCallId);
    // An attempt that resumes one from before a restart: the owner's stored answers to that attempt's requests are its to use.
    if (ticket && ticket.resumes !== null && ticket.taskId !== null && ticket.taskId === r.taskId) {
      const carried = db.prepare(`SELECT ${APPROVAL_COLUMNS} WHERE a.task_id = ? AND a.attempt_id = ? AND a.status = 'pending' AND a.stored_decision IS NOT NULL ORDER BY a.id`).all(ticket.taskId, ticket.resumes).map(toApproval);
      // The same thing asked again: same role, tool, command and directory. A directory nobody reported is not known to be the same.
      const match = cwd === "" ? undefined : carried.find((a) => a.role === r.role && a.tool === r.tool && a.command === r.command && a.cwd === cwd);
      if (match) {
        const decision = match.storedDecision!;
        try {
          // Used up before it is handed over: whatever happens next, this answer is never given a second time.
          transaction(db, () => {
            const used = db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending' AND stored_decision = ?").run(decision === "allow" ? "allowed" : "declined", now(), match.id, decision);
            if (Number(used.changes) !== 1) throw new Error("the stored answer was no longer there");
            // The owner's own decision is on record for this approval, or it is not applied.
            if (!db.prepare("SELECT 1 FROM action_log WHERE approval_id = ? AND rule = ?").get(match.id, decision === "allow" ? "owner_allowed" : "owner_declined")) throw new Error("the log holds no decision of the owner's for it");
            appendLog(db, { taskId: r.taskId, attemptId: r.attemptId, approvalId: match.id, rule: "stored_answer_applied", tool: r.tool, command: r.command, cwd, detail: `The owner's answer from before the restart (${decision}) was given to tool call ${shorten(r.toolCallId, 200)}.` });
          });
        } catch (err) {
          return deny(`The owner's stored answer could not be applied: ${words(err)}`);
        }
        announce(match.id);
        return Promise.resolve({ decision, note: match.note, approvalId: match.id, refused: null });
      }
      if (carried.length > 0) {
        supersedeWhere(`After the restart the agent asked for something else first (${shorten(r.tool, 100)}: ${shorten(r.command, 300)}), so the owner's stored answer was not used.`, stillCarried, ticket.taskId, ticket.resumes);
      }
    }
    // What Botbench itself decides about the request, now that it is the CLI's own: the floor, then the run's pre-approved list and the standing permissions.
    const verdict = decideRequest(r, ticket, cwd);
    if (verdict.verdict === "deny") return deny(verdict.reason);
    if (verdict.verdict === "allow") {
      const grant = verdict.grant;
      const standing = verdict.rule === "standing";
      try {
        // What cannot be logged does not run.
        const detail = standing ? `Always allowed (permission ${grant.id}), which you chose on a request of task ${grant.taskId ?? "?"}: ${showWords(grant.words)}` : `Allowed for this task when it was started: ${showWords(grant.words)}`;
        appendLog(db, { taskId: r.taskId, attemptId: r.attemptId, grantId: grant.id, rule: verdict.rule, tool: r.tool, command: r.command, cwd, detail });
      } catch (err) {
        return deny(`This ${standing ? "always-allowed command" : "command allowed for this task"} could not be recorded, so it was not let through: ${words(err)}`);
      }
      return Promise.resolve({ decision: "allow", note: null, approvalId: null, refused: null, ...(standing ? { standing: { grantId: grant.id } } : { preapproved: { grantId: grant.id } }) });
    }
    const always = verdict.verdict === "ask" && verdict.floor !== undefined ? `Always asks: ${verdict.floor}.` : null;
    let id: number;
    try {
      id = transaction(db, () => {
        const inserted = db
          .prepare("INSERT INTO approvals (task_id, run_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
          .run(r.taskId, r.runId ?? null, r.attemptId, r.role, r.tool, r.command, cwd, typeof r.reason === "string" ? shorten(r.reason, MAX_REASON) : null, r.toolCallId, now());
        const approvalId = Number(inserted.lastInsertRowid);
        appendLog(db, { taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, approvalId, rule: "asked_owner", tool: r.tool, command: r.command, cwd, detail: always });
        return approvalId;
      });
    } catch (err) {
      return deny(`The approval could not be recorded: ${words(err)}`);
    }
    const waiting = new Promise<Answer>((resolve) => waiters.set(id, resolve));
    announce(id);
    return waiting;
  };

  const answer = (id: number, decision: Decision, note?: string | null): Approval => {
    // voice: not on screen. It names the API's own fields and values for a caller whose request was malformed; the client never sends one.
    if (decision !== "allow" && decision !== "decline") throw new ApprovalError(400, 'The decision must be "allow" or "decline".');
    const kept = typeof note === "string" && note.trim() !== "" ? note.trim().slice(0, MAX_NOTE) : null;
    const status: ApprovalStatus = decision === "allow" ? "allowed" : "declined";
    // The decision and its log entry are one write: neither exists without the other.
    const stored = transaction(db, () => {
      const current = getApproval(db, id);
      if (!current) throw new ApprovalError(404, "No such approval.");
      if (current.status !== "pending") throw new ApprovalError(409, `This approval is already ${current.status}.`);
      if (current.storedDecision !== null) throw new ApprovalError(409, `This approval already has your answer (${current.storedDecision}); Botbench is resuming its task.`);
      const entry = { taskId: current.taskId, runId: current.runId, attemptId: current.attemptId, approvalId: id, rule: decision === "allow" ? "owner_allowed" : "owner_declined", tool: current.tool, command: current.command, cwd: current.cwd, detail: kept } as const;
      if (waiters.has(id)) {
        db.prepare("UPDATE approvals SET status = ?, note = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(status, kept, now(), id);
        appendLog(db, entry);
        return false;
      }
      // An approval nothing is waiting for and that no start has parked cannot let anything run, so it is not answerable.
      if (current.parkedAt === null) throw new ApprovalError(409, "This approval is no longer waiting for an answer.");
      // Asked before a restart: nobody is waiting in this process, so the answer is kept on the approval until its task asks again.
      db.prepare("UPDATE approvals SET stored_decision = ?, stored_at = ?, note = ? WHERE id = ? AND status = 'pending' AND stored_decision IS NULL").run(decision, now(), kept, id);
      appendLog(db, entry);
      return true;
    });
    if (!stored) {
      waiters.get(id)!({ decision, note: kept, approvalId: id, refused: null });
      waiters.delete(id);
    }
    announce(id);
    const approval = getApproval(db, id)!;
    if (stored) {
      for (const listener of storedListeners) {
        try {
          listener(approval);
        } catch (err) {
          // The answer is stored and stands; the next start says what became of it.
          console.error(`A stored answer could not be passed on for its task to be resumed: ${words(err)}`);
        }
      }
    }
    return approval;
  };

  const whereWords = (cwd: string): string => (cwd === "." ? "the top folder of the task's copy" : cwd);

  /**
   * Whether a pending approval may be offered standing permission, decided from Botbench's own records and never from
   * what a client sends: the approval's row, its task, its attempt's admission, the floor, the grants and the log.
   * Answers the offer and the words to grant, or, as text, why there is none. Anything that cannot be read is a no.
   */
  const eligibility = (approval: Approval): { offer: StandingOffer; granted: string[] } | string => {
    if (approval.status !== "pending") return `it is already ${approval.status}`;
    // Asked before a restart: nothing waits for the answer here, and the task is resumed by an ordinary answer.
    if (approval.parkedAt !== null || approval.storedDecision !== null || !waiters.has(approval.id)) return "it was asked before Botbench restarted";
    // A grant for a tool's name would allow that tool with any input, and the floor reads command lines only.
    if (approval.tool !== "Bash") return "only a shell command can have one";
    // A planner's request belongs to no task, and a planner is read-only: what it asks is asked every time.
    if (approval.taskId === null) return "only a task's request can have one";
    const ticket = [...tickets.values()].find((t) => t.attemptId === approval.attemptId);
    if (!ticket || ticket.taskId !== approval.taskId || ticket.role !== approval.role) return "the agent that asked is no longer running";
    // The directory must be written the one way a directory inside the worktree is written, and be inside it with links followed.
    const outside = (relative: string): boolean => relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (approval.cwd === "" || path.normalize(approval.cwd) !== approval.cwd || outside(approval.cwd) || outside(path.relative(ticket.worktree, real(path.resolve(ticket.worktree, approval.cwd))))) {
      return "the folder it was asked from is not known to be inside the task's copy of the project";
    }
    try {
      const split = splitPlain(approval.command);
      // The floor is asked with the command as the card shows it: the same reading that makes it always ask.
      const verdict = gate({ tool: "Bash", input: { command: approval.command }, worktree: ticket.worktree, cwd: path.resolve(ticket.worktree, approval.cwd) }, [], floorSettings);
      if (verdict.verdict !== "ask" || verdict.floor !== undefined) return verdict.verdict === "ask" ? `Botbench always asks about it (${verdict.floor})` : "it is not a command Botbench asks about";
      if (split === null) return "it is not one plain command";
      const problem = standingProblem(split);
      if (problem !== null) return problem;
      const task = db.prepare("SELECT repo_path FROM tasks WHERE id = ?").get(approval.taskId);
      if (!task) return "its task is not known";
      const repo = String(task.repo_path);
      const same = JSON.stringify(split);
      if (standingGrants(db, { role: approval.role, repo }).some((grant) => grant.cwd === approval.cwd && JSON.stringify(grant.words) === same)) return "it already has one";
      const approvals = approvalCount(db, { role: approval.role, repo, cwd: approval.cwd, tool: approval.tool, words: split });
      if (approvals < offerStandingAfter) return `you have allowed it ${approvals} of the ${offerStandingAfter} times that earn one`;
      return { offer: { command: showWords(split), repo, cwd: approval.cwd, role: approval.role, approvals }, granted: split };
    } catch (err) {
      console.error(`Whether approval ${approval.id} may be offered standing permission could not be decided: ${words(err)}`);
      return "Botbench could not check it";
    }
  };

  const standingOffer = (id: number): StandingOffer | null => {
    const approval = getApproval(db, id);
    if (!approval) return null;
    const found = eligibility(approval);
    return typeof found === "string" ? null : found.offer;
  };

  const grantStanding = (id: number): { approval: Approval; grant: StandingGrant } => {
    // The answer, the grant and their log entries are one write: none exists without the others.
    const grantId = transaction(db, () => {
      const current = getApproval(db, id);
      if (!current) throw new ApprovalError(404, "No such approval.");
      if (current.status !== "pending") throw new ApprovalError(409, `This approval is already ${current.status}.`);
      const found = eligibility(current);
      if (typeof found === "string") throw new ApprovalError(409, `Always allow is not available for this request: ${found}. Nothing was allowed; answer it with Allow once or Deny.`);
      const answered = db.prepare("UPDATE approvals SET status = 'allowed', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now(), id);
      if (Number(answered.changes) !== 1) throw new ApprovalError(409, "This approval is no longer waiting for an answer.");
      const about = { taskId: current.taskId, attemptId: current.attemptId, approvalId: id, tool: current.tool, command: current.command, cwd: current.cwd };
      appendLog(db, { ...about, rule: "owner_allowed" });
      const granted = insertStanding(db, { role: found.offer.role, repo: found.offer.repo, cwd: found.offer.cwd, words: found.granted, taskId: current.taskId! });
      appendLog(db, { ...about, grantId: granted, rule: "standing_granted", detail: `For the ${stepWords(found.offer.role)} in ${found.offer.repo}, from ${whereWords(found.offer.cwd)}, after ${found.offer.approvals} approval${found.offer.approvals === 1 ? "" : "s"}: ${found.offer.command}` });
      return granted;
    });
    waiters.get(id)!({ decision: "allow", note: null, approvalId: id, refused: null });
    waiters.delete(id);
    announce(id);
    return { approval: getApproval(db, id)!, grant: listStanding(db).find((grant) => grant.id === grantId)! };
  };

  const revokeStanding = (id: number): StandingGrant =>
    transaction(db, () => {
      const found = findStanding(db, id);
      if (!found) throw new ApprovalError(404, "There is no such always-allowed command.");
      if (found.revoked) throw new ApprovalError(409, "This always-allowed command was already removed.");
      const { grant } = found;
      const listed = listStanding(db).find((g) => g.id === id);
      const command = showWords(grant.words);
      insertRevocation(db, id);
      // Taken back and on record together. No request is being decided in between: this process does one thing at a time.
      appendLog(db, { taskId: null, attemptId: null, grantId: id, rule: "standing_revoked", tool: "Bash", command, cwd: grant.cwd, detail: `Was for the ${stepWords(grant.role)} in ${grant.repo}, from ${whereWords(grant.cwd)}.` });
      return listed ?? { id, role: grant.role, repo: grant.repo, cwd: grant.cwd, command, taskId: grant.taskId, grantedAt: grant.createdAt, timesUsed: 0, lastUsedAt: null };
    });

  /** Answer one message from the socket. Everything that is not a well-formed question from a live attempt is denied. */
  const decide = (line: string): Reply => {
    const denied = (reason: string, about: Partial<LogWrite> = {}): Reply => {
      refuse({ taskId: null, attemptId: null, tool: "", command: "", cwd: "", ...about, detail: reason });
      return { verdict: "deny", reason };
    };
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return denied("Botbench's permission check was sent a message that is not JSON.");
    }
    if (!isObject(message) || typeof message.secret !== "string") return denied("Botbench's permission check was sent a message it cannot read.");
    // Looked up by hash, so the secret itself is never compared a byte at a time.
    const ticket = tickets.get(hashOf(message.secret));
    if (!ticket) return denied("Botbench's permission check does not know where this request came from.");
    if (ticket.attemptId === null) return denied("Botbench's permission check has no running agent for this request yet.", { taskId: ticket.taskId, runId: ticket.runId });
    const about = { taskId: ticket.taskId, runId: ticket.runId, attemptId: ticket.attemptId };
    const { tool, input, toolCallId, cwd } = message;
    if (typeof tool !== "string" || tool === "" || typeof toolCallId !== "string" || toolCallId === "" || typeof cwd !== "string" || !path.isAbsolute(cwd) || !isObject(input)) {
      return denied("Botbench's permission check was sent a tool call it cannot read.", { ...about, tool: typeof tool === "string" ? tool : "" });
    }
    // Asked without grants: nothing a grant allows is ever said over the socket. A shell command hears "ask" here, and
    // the CLI's own request for it is then decided in request(), with the grants, inside this process.
    const verdict = gate({ tool, input, worktree: ticket.worktree, cwd }, [], floorSettings);
    // With links followed: a directory that is a link out of the worktree is recorded as where it leads.
    const relative = path.relative(ticket.worktree, real(cwd));
    const from = relative === "" ? "." : relative;
    if (verdict.verdict === "deny") return denied(`Botbench's permission check refused this call: ${verdict.reason}`, { ...about, tool, cwd: from });
    // A read-only attempt has reading and the shell and nothing else: any other tool is refused, not asked about.
    if (ticket.readOnly && !READ_ONLY_TOOLS.has(tool)) return denied(`Botbench's permission check refused this call: the ${stepWords(ticket.role)} only reads and may not use ${shorten(tool, 100)}.`, { ...about, tool, command: String(input.file_path ?? input.notebook_path ?? ""), cwd: from });
    if (verdict.verdict === "ask" || verdict.rule === "preapproved" || verdict.rule === "standing") {
      if (ticket.seen.size >= MAX_SEEN) ticket.seen.delete(ticket.seen.keys().next().value!);
      ticket.seen.set(toolCallId, from);
      return { verdict: "ask", reason: "Botbench asks the owner before this runs." };
    }
    if (verdict.rule === "auto_worktree_edit") {
      const file = String(input.file_path ?? input.notebook_path);
      try {
        appendLog(db, { ...about, rule: verdict.rule, tool, command: path.relative(ticket.worktree, path.resolve(cwd, file)), cwd: from });
      } catch (err) {
        // What cannot be logged does not run.
        return denied(`Botbench could not record this edit, so it was not let through: ${words(err)}`, { ...about, tool });
      }
    }
    return { verdict: "pass", reason: "" };
  };

  const onConnection = (socket: net.Socket): void => {
    let buffer = "";
    let done = false;
    const reply = (r: Reply): void => {
      if (done) return;
      done = true;
      socket.end(`${JSON.stringify(r)}\n`);
    };
    const refuseUnread = (reason: string): void => {
      if (done) return;
      refuse({ taskId: null, attemptId: null, tool: "", command: "", cwd: "", detail: reason });
      reply({ verdict: "deny", reason });
    };
    socket.setEncoding("utf8");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A caller that says nothing, or never hangs up after its answer, is not kept.
    socket.setTimeout(SOCKET_READ_MS, () => {
      refuseUnread("Botbench's permission check was sent no complete message in time.");
      setTimeout(() => socket.destroy(), 1000).unref();
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > MAX_MESSAGE) return refuseUnread("Botbench's permission check was sent a message that is too long.");
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      let answer: Reply;
      try {
        answer = decide(buffer.slice(0, end));
      } catch (err) {
        answer = { verdict: "deny", reason: `Botbench's permission check failed: ${words(err)}` };
      }
      reply(answer);
    });
    socket.on("end", () => refuseUnread("Botbench's permission check was sent a message with no end."));
  };

  const listen = (): Promise<void> =>
    inUse().then(
      (taken) =>
        new Promise<void>((resolve, reject) => {
          if (taken) return reject(new Error(`Another Botbench is already running on this data directory (it answers permission requests at ${socketPath}). Stop it first, or give this one its own BOTBENCH_HOME.`));
          // What a Botbench that stopped left pending stays pending, marked as asked before this start. Nothing waits for it
          // in this process; the engine decides whether its task can be resumed. A store that cannot be written is no start.
          try {
            db.prepare("UPDATE approvals SET parked_at = ? WHERE status = 'pending' AND parked_at IS NULL").run(now());
          } catch (err) {
            return reject(new Error(`The approvals left pending by the last run could not be marked: ${words(err)}`));
          }
          // Its socket file, if it stopped without closing, is in the way and is nobody's any more.
          fs.rmSync(socketPath, { force: true });
          listenNow(resolve, reject);
        }),
    );

  /** Whether a live broker already answers on the socket: then this data directory belongs to a running Botbench. */
  const inUse = (): Promise<boolean> => socketAnswers(socketPath);

  const listenNow = (resolve: () => void, reject: (err: Error) => void): void => {
    const opening = net.createServer({ allowHalfOpen: true }, onConnection);
    opening.once("error", (err) => reject(new Error(`Botbench's permission socket could not be opened at ${socketPath}: ${words(err)}. Until it can, every command a task asks for is denied.`)));
    opening.listen(socketPath, () => {
      try {
        // The directory already keeps other accounts out; the socket says so itself as well.
        fs.chmodSync(socketPath, 0o600);
      } catch (err) {
        opening.close();
        return reject(new Error(`Botbench's permission socket could not be made owner-only: ${words(err)}`));
      }
      opening.on("error", (err) => console.error(`The permission broker's socket failed: ${words(err)}`));
      server = opening;
      resolve();
    });
  };

  const admit = (o: { taskId?: number; runId?: number; role: string; worktree: string; resumes?: number; readOnly?: boolean }): Admission => {
    if ((o.taskId === undefined) === (o.runId === undefined)) throw new Error("A permission ticket is for a task or for a run's planner, one of the two.");
    const secret = randomBytes(32).toString("hex");
    const key = hashOf(secret);
    // The CLI reports directories with links followed, so the worktree is kept the same way.
    let worktree = path.resolve(o.worktree);
    try {
      worktree = fs.realpathSync(worktree);
    } catch {
      // A worktree that is not there yet is compared as written.
    }
    const ticket: Ticket = { taskId: o.taskId ?? null, runId: o.runId ?? null, readOnly: o.readOnly === true, role: o.role, worktree, attemptId: null, resumes: o.resumes ?? null, seen: new Map() };
    tickets.set(key, ticket);
    const supersede = (toolCallId?: string): void => {
      if (ticket.attemptId === null) return;
      if (toolCallId === undefined) supersedeWhere(null, "attempt_id = ?", ticket.attemptId);
      else supersedeWhere(null, "attempt_id = ? AND tool_call_id = ?", ticket.attemptId, toolCallId);
    };
    const park = (): void => {
      tickets.delete(key);
      const attemptId = ticket.attemptId;
      if (attemptId === null) return;
      let ids: number[];
      try {
        ids = transaction(db, () => {
          const rows = db.prepare("SELECT id FROM approvals WHERE status = 'pending' AND attempt_id = ? ORDER BY id").all(attemptId);
          db.prepare("UPDATE approvals SET parked_at = ? WHERE status = 'pending' AND attempt_id = ? AND parked_at IS NULL").run(now(), attemptId);
          return rows.map((row) => Number(row.id));
        });
      } catch (err) {
        // What cannot be kept for the next start ends here, unanswered.
        console.error(`Pending approvals could not be parked: ${words(err)}`);
        return supersede();
      }
      for (const id of ids) {
        // Whoever waited in this process is let go with a refusal; the approval itself stays for the owner.
        waiters.get(id)?.({ decision: "decline", note: null, approvalId: id, refused: "Botbench is stopping. The request waits for the owner until Botbench runs again." });
        waiters.delete(id);
        announce(id);
      }
    };
    return {
      socketPath,
      secret,
      bind: (attemptId) => void (ticket.attemptId = attemptId),
      supersede,
      park,
      release: () => {
        tickets.delete(key);
        supersede();
        // Stored answers this attempt was to use and never asked for are not kept for anyone else.
        if (ticket.resumes !== null && ticket.taskId !== null) supersedeWhere("After the restart the agent finished without asking for this again, so the owner's stored answer was not used.", "task_id = ? AND attempt_id = ? AND stored_decision IS NOT NULL", ticket.taskId, ticket.resumes);
      },
    };
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    tickets.clear();
    // Only what this broker is waiting on: the store may be shared with a Botbench that is still running.
    for (const id of [...waiters.keys()]) supersedeWhere(null, "id = ?", id);
    // Should the rows not have been writable, still nobody is left waiting: a request with no broker is declined.
    for (const [id, resolve] of waiters) resolve({ decision: "decline", note: null, approvalId: id, refused: null });
    waiters.clear();
    const open = server;
    server = null;
    for (const socket of sockets) socket.destroy();
    // Only a broker that opened the socket removes it: the file may be a running Botbench's.
    if (!open) return;
    await new Promise<void>((resolve) => open.close(() => resolve()));
    fs.rmSync(socketPath, { force: true });
  };

  const endParked = (taskId: number, why: string): void => supersedeWhere(why, "task_id = ?", taskId);
  const endRunApprovals = (runId: number, why: string): void => supersedeWhere(why, "run_id = ?", runId);

  return { endRunApprovals, socketPath, offerStandingAfter, standingOffer, grantStanding, revokeStanding, listen, admit, request, answer, onStoredAnswer: (listener) => void storedListeners.push(listener), endParked, pending: () => listApprovals(db, "pending"), close };
}
