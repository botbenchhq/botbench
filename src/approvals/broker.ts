import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DriverSession } from "../drivers/contract.ts";
import type { PermissionResponse } from "../drivers/events.ts";
import { askEveryCommand, isRunMode, type RunMode } from "../engine/modes.ts";
import { stepWords } from "../engine/roles.ts";
import { now, transaction } from "../store/db.ts";
import type { FloorEntry } from "./floor.ts";
import { askWords, ESCALATION_REFUSED, fullAutonomyRefusal, gate, namesAFile, READ_ONLY_TOOLS, real, requestTarget, summarize, type AskWhy, type FloorSettings } from "./gate.ts";
import { firstLine } from "../shorten.ts";
import { approvalCount, findStanding, insertRevocation, insertStanding, listStanding, runGrants, showWords, standingGrants, standingProblem, type Grant, type StandingGrant } from "./grants.ts";
import { answerProblem, AUTONOMOUS_ANSWER, parseStoredQuestion, QUESTION_TOOL, readQuestion, storedQuestion, type Question } from "./question.ts";
import { asRefusalKind, refusalBlocksAccept, refusalKind, type RefusalKind } from "./refusals.ts";
import { splitPlain } from "./shell.ts";
import { chatWebAccess, publicWebAddress, WEB_ACCESS_WORDS, WEB_OFF, WEB_TOOLS } from "./web-access.ts";

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
 * Approvals are for actions and changes, not for using a tool. In every mode a shell command that runs confined, and
 * that the floor does not name, is allowed in request() and logged under `mode_allowed`, unless the owner's setting
 * "Ask before every command" is on and the run is manual (a task of no run is manual). The run's mode and that setting
 * are read in request() only, from the store, for each request (engine/modes.ts). In a fully autonomous run whatever
 * would ask the owner is refused there and logged under `mode_refused`, and the agent is told why. A command is taken
 * as confined only when the attempt was admitted as one whose driver runs every shell command in its sandbox, and the
 * request is exactly the call its hook reported. Claude Code's web tools follow the owner's setting Web access, in a
 * task and a run as in a chat, except in a run that read outside text, where they ask; its bookkeeping tools pass.
 *
 * A request for a file tool is put to the same gate in request() as on the socket, with the input an allow hands back:
 * an edit or read inside the worktree, and a Read of the CLI's saved output of the attempt's own session, run without
 * asking in every mode (the CLI asks about some itself, its own edit rule being narrower than the worktree). Every call
 * the hook hears has its directory recorded, so a request is tied to the call that was checked whatever was said about it.
 * An approval carries why it asks (`asks_because`) and, for a file tool, where it is aimed (`target`), for its card.
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
 * A chat's Claude Code is admitted too (`chat`), in the chat's own folder: it is asked about like a semi-autonomous
 * run's builder (a confined command the floor does not name runs, logged as `chat_confined`), with no grant of any kind, and its web tools follow the owner's setting Web access (web-access.ts).
 * A chat's approval has no task and no run; nothing re-drives a chat, so one left pending by a Botbench that stopped is
 * ended, unanswered, when the next one starts.
 *
 * A question the agent puts to the owner (Claude Code's AskUserQuestion, approvals/question.ts), of a task or a run's
 * planner, is an approval of its own kind: one Botbench cannot show as a card is refused with the reason for the agent; in
 * a fully autonomous run nobody is asked, and the agent is told to decide itself, in one log entry (`question_unasked`);
 * otherwise it waits for `answerQuestion`, whose answer goes back keyed by the question's text. It is never answered
 * with Allow or Deny. After a restart its stored answer goes to the first request that asks the same question.
 *
 * Across a restart: an approval that was pending when Botbench stopped stays pending and is marked parked. Nothing
 * waits for it in this process, so the owner's answer cannot be handed to anyone: it is stored on the approval.
 * The engine then re-drives the task, and the stored answer goes, once, to the first request of the resuming
 * attempt that asks for the same thing: same task, same role, same tool, same command, same directory. If that
 * attempt's first request is anything else, the stored answer is discarded and the request is asked afresh.
 */

export const SOCKET_FILE = "broker.sock";
/** The role a chat's Claude Code asks as. */
export const CHAT_ROLE = "chat";
/**
 * Claude Code's own planning and bookkeeping tools, which reach nothing outside the CLI: loading a tool's description
 * before its first use (seen on 2.1.322: a chat's first fetch is a ToolSearch for WebFetch) and its to-do list. For
 * every agent the hook lets them pass, so the CLI's own rules decide, as they do when it is used directly; should the
 * CLI still ask, request() lets them run without asking, in every mode.
 */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(["ToolSearch", "TodoWrite"]);
/** Why a chat's approval left pending by a Botbench that stopped was ended, in the log. */
export const CHAT_RESTARTED = "Botbench restarted before you answered, so this request of a chat ended without an answer. It was not run.";

/** How long after a first answer the socket is asked again, to tell a live broker from one that is dying. */
const RECHECK_MS = 250;

/**
 * Whether a live broker answers on the socket at `socketPath`: then its data directory belongs to a running process.
 * It must answer twice, a moment apart. A Botbench that was killed just after it started a process (a CLI, a setup
 * command) can leave its socket taking connections for a few milliseconds, until that process has replaced itself
 * with the program it runs; asked once, that socket looks like a running Botbench, and the next start refused to run.
 */
export async function socketAnswers(socketPath: string): Promise<boolean> {
  if (!(await answersOnce(socketPath))) return false;
  await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
  return answersOnce(socketPath);
}

function answersOnce(socketPath: string): Promise<boolean> {
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
  | "owner_discarded"
  /** A confined command that the floor does not name ran without asking, in any mode. */
  | "mode_allowed"
  /** A fully autonomous run refused what would have asked the owner: a request the safety floor names, or one that is not a confined command. */
  | "mode_refused"
  /** A fully autonomous run accepted a task without the owner. The entry names the task's branch and why it qualified. */
  | "mode_accepted"
  /** A step of delivering an accepted task: pushing its branch and opening its pull request, or why that failed. */
  | "delivery"
  /** A web tool of a chat, allowed or refused by the owner's setting "Web access in chat". */
  | "chat_web_access"
  /** A confined command of a chat, which the floor does not name, ran without asking. */
  | "chat_confined"
  /** A web tool of a task or a run ran without asking, because the owner's setting Web access is Allow. */
  | "web_allowed"
  /** A web tool of a task or a run was refused without asking, because the owner's setting Web access is Off. */
  | "web_refused"
  /**
   * A tool call of an agent that cannot ask (Codex, Grok: capability `permissionRequests: false`), which ran without
   * asking, kept only by its sandbox (threat model, B18). What the sandbox refused is in the agent's own transcript.
   */
  | "sandboxed"
  /** One of the CLI's own bookkeeping tools (its to-do list, loading a tool) ran without asking, in any mode. */
  | "bookkeeping"
  /** Botbench's own step on an issue claim (engine/claims.ts): a claim branch pushed, given up for an earlier claim, or released when the run ended. */
  | "issue_claim"
  /** The owner answered an agent's question; `detail` holds the answer as given. */
  | "owner_answered"
  /** A fully autonomous run's agent asked a question nobody was asked: the question in `command`, what the agent was told in `detail`. */
  | "question_unasked"
  /** A task was handed to another agent (engine/handoff.ts): `command` names the agents, `detail` the line the owner reads. */
  | "handoff";
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
  /** The task whose agent asks. Null when a run's planner or a chat asks. */
  taskId: number | null;
  /** True when a chat's Claude Code asks: then neither a task nor a run is named, and the chat's screen shows the card. */
  chat: boolean;
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
  /** The request comes from a run that read text from outside the project (a GitHub issue): no grant applied to it. */
  outsideText: boolean;
  /** Why it asks the owner, in one plain line for its card. Null for an approval asked before this was recorded. */
  asksBecause: string | null;
  /**
   * Where a file tool's request is aimed: relative to the worktree when inside it, a full path when not. Null for a
   * shell command, a tool that names no path, or a relative path whose starting folder was not reported.
   */
  target: string | null;
  /** Set when this is an agent's question to the owner (approvals/question.ts), not a request to run something: what its card shows. */
  question: Question | null;
  /** The owner's answer to a question, as given; null until there is one. */
  answer: string | null;
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
  /** What kind of request a fully autonomous run refused (src/approvals/refusals.ts), on a `mode_refused` entry; null on any other, and on one from before kinds were recorded. */
  refusal: RefusalKind | null;
}

export interface ApprovalRequest {
  /** The task whose agent asks, or null when a run's planner does. */
  taskId: number | null;
  /** The run whose planner asks. Left out for a task's request. */
  runId?: number | null;
  /** True when a chat's Claude Code asks; then `taskId` is null and no run is named. */
  chat?: boolean;
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
  /**
   * The agent asks to run this outside its own sandbox (a Codex approval request, src/drivers/codex-app-server.ts). It
   * is put to the owner every time, or refused in a fully autonomous run; no grant, mode or stored answer applies.
   */
  escalation?: boolean;
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
  /** Set when a confined command that the floor does not name ran without asking: the mode of its run. */
  byMode?: RunMode;
  /** Set when a file tool's request was allowed without asking, in any mode: a read or an edit inside the worktree, or a read of the CLI's own saved output of this attempt. */
  files?: true;
  /** Set when a web tool was allowed by the owner's setting Web access, without asking. */
  web?: true;
  /** Set when one of the CLI's own bookkeeping tools ran, which never asks. */
  bookkeeping?: true;
  /** Set when a chat's command ran without asking: confined, and not named by the floor. */
  chat?: true;
  /** Set when the owner answered an agent's question: the answer, keyed by the question's text, as the CLI takes it. */
  answers?: Record<string, string>;
}

/** The answer as a driver's `respondToRequest` takes it. */
export function permissionResponse(answer: Answer): PermissionResponse {
  return {
    decision: answer.decision,
    note: answer.note,
    refused: answer.refused,
    preapproved: answer.preapproved !== undefined,
    standing: answer.standing !== undefined,
    mode: answer.byMode !== undefined,
    files: answer.files !== undefined,
    web: answer.web !== undefined,
    bookkeeping: answer.bookkeeping !== undefined,
    chat: answer.chat !== undefined,
    ...(answer.answers === undefined ? {} : { answers: answer.answers }),
  };
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
  /**
   * `confined`: the attempt's driver runs every shell command it asks for in its sandbox (`confinedCommands`). Only then
   * can a command run without asking.
   */
  admit(o: { taskId?: number; runId?: number; chat?: boolean; role: string; worktree: string; resumes?: number; readOnly?: boolean; confined?: boolean }): Admission;
  /** Record a pending approval and wait for the owner. Never rejects: any failure is a decline. */
  request(request: ApprovalRequest): Promise<Answer>;
  /**
   * The owner's answer. Throws `ApprovalError` for an unknown approval or one that is no longer pending.
   * For a parked approval the answer is stored, the approval stays pending, and the listeners of `onStoredAnswer` are told.
   */
  answer(id: number, decision: Decision, note?: string | null): Approval;
  /**
   * The owner's answer to an agent's question: one of its choices or the owner's own words, at most `MAX_ANSWER`
   * characters, stored as given. Throws `ApprovalError`: 400 for an answer that cannot be sent, 404 for an unknown
   * approval, 409 for one that is not a question or already has an answer. For a parked question the answer is stored
   * and the listeners of `onStoredAnswer` are told, as for any parked approval.
   */
  answerQuestion(id: number, answer: string): Approval;
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

function toApproval(row: Record<string, unknown>): Approval {
  return {
    id: Number(row.id),
    taskId: int(row.task_id),
    chat: row.chat === 1,
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
    outsideText: row.outside_text !== 0,
    asksBecause: text(row.asks_because),
    target: text(row.target),
    question: parseStoredQuestion(row.question),
    answer: text(row.answer),
  };
}

/** An approval with what its card is titled by: its task's prompt, or what its run was given (the prompt, or the spec file's path). */
const APPROVAL_COLUMNS = "a.*, COALESCE(t.prompt, r.prompt, r.spec_path, (SELECT 'Issue #' || f.number || ': ' || f.title FROM issue_fetches f WHERE f.id = r.issue_fetch_id)) AS prompt, CASE WHEN a.chat = 1 THEN 0 ELSE COALESCE(tr.outside_text, r.outside_text, 1) END AS outside_text FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN runs tr ON tr.id = t.run_id LEFT JOIN runs r ON r.id = a.run_id";

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
  refusal: asRefusalKind(row.refusal),
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
  /** Only with `mode_refused`: what kind of request was refused. */
  refusal?: RefusalKind | null;
}

/** Add one entry to the action log. The broker writes every entry but the owner's decisions on tasks (engine/decision.ts). */
export function appendLog(db: DatabaseSync, e: LogWrite): void {
  db.prepare("INSERT INTO action_log (ts, task_id, run_id, attempt_id, approval_id, grant_id, rule, tool, command, cwd, detail, refusal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(now(), e.taskId, e.runId ?? null, e.attemptId, e.approvalId ?? null, e.grantId ?? null, e.rule, e.tool, e.command, e.cwd, e.detail ?? null, e.refusal ?? null);
}

/**
 * Write each tool call `session` reports to the action log, once per call, as one that ran without asking under the
 * agent's own sandbox (`sandboxed`): for an agent that cannot ask Botbench before it acts (B18), whose calls never pass
 * through the broker. `where` names the place its sandbox kept it to, in words for the log.
 */
export function logSandboxedCalls(db: DatabaseSync, session: Pick<DriverSession, "attemptId" | "onEvent">, o: { agent: string; taskId: number | null; runId?: number | null; cwd: string; where: string }): () => void {
  const seen = new Set<string>();
  return session.onEvent((event) => {
    if (event.type !== "tool_call" || seen.has(event.id)) return;
    seen.add(event.id);
    logSandboxedCall(db, event, { taskId: o.taskId, runId: o.runId ?? null, attemptId: session.attemptId, cwd: o.cwd, detail: `${o.agent} cannot ask you, so it ran this without asking, kept by its own sandbox to ${o.where}.` });
  });
}

/** Write one tool call an agent ran under its own sandbox, never put to the broker, to the action log (`sandboxed`). */
export function logSandboxedCall(db: DatabaseSync, call: { name: string; input: unknown }, o: { taskId: number | null; runId?: number | null; attemptId: number; cwd: string; detail: string }): void {
  const input = call.input;
  const named = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  const command = typeof named?.command === "string" ? named.command : typeof named?.query === "string" ? named.query : JSON.stringify(input ?? null);
  appendLog(db, { taskId: o.taskId, runId: o.runId ?? null, attemptId: o.attemptId, rule: "sandboxed", tool: shorten(call.name, 200), command: shorten(command, MAX_COMMAND), cwd: o.cwd, detail: o.detail });
}

interface Ticket {
  taskId: number | null;
  /** A chat's Claude Code, in the chat's own folder. */
  chat: boolean;
  runId: number | null;
  /** The attempt changes nothing: every edit is refused and no grant applies. */
  readOnly: boolean;
  /** The attempt's driver runs every shell command in its sandbox. */
  confined: boolean;
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

/** What the record of a refusal adds when the refusal does not stop the task being accepted (docs/product/voice.md). */
const HARMLESS_WORDS: Partial<Record<RefusalKind, string>> = {
  read_only: "It only reads files in the task's copy, so it does not stop the task being accepted.",
  other: "It is not a command, a file or the network, so it does not stop the task being accepted.",
};

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
  /**
   * The folder where an attempt's CLI saves the long output of that session's own tool calls, given the attempt's driver,
   * its session (the resume cursor the CLI reported) and the worktree it started in; null when it keeps none Botbench knows.
   * A Read inside it is allowed without asking (gate.ts). Left out, there is none.
   */
  sessionOutput?: (o: { driver: string; session: string; worktree: string }) => string | null;
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

  type RequestVerdict =
    | { verdict: "ask"; floor?: string; why: AskWhy }
    | { verdict: "deny"; reason: string }
    | { verdict: "refuse"; reason: string; floor?: string; why: AskWhy }
    | { verdict: "allow"; rule: "preapproved" | "standing"; grant: Grant }
    | { verdict: "allow"; rule: "mode"; mode: RunMode }
    | { verdict: "allow"; rule: "files"; edit: boolean }
    /** A web tool, decided by the owner's setting: run without asking, or refused. */
    | { verdict: "web"; allowed: boolean }
    /** One of the CLI's own bookkeeping tools: it runs, as when the CLI is used directly. */
    | { verdict: "allow"; rule: "bookkeeping" };

  /** Where the attempt's CLI keeps the saved output of its own session's calls, read from the attempt's row; undefined when it is not known. */
  const sessionOutputOf = (attemptId: number | null, worktree: string): string | undefined => {
    if (attemptId === null || options.sessionOutput === undefined) return undefined;
    try {
      const row = db.prepare("SELECT driver, resume_cursor FROM attempts WHERE id = ?").get(attemptId);
      if (row === undefined || typeof row.resume_cursor !== "string" || row.resume_cursor === "") return undefined;
      return options.sessionOutput({ driver: String(row.driver), session: row.resume_cursor, worktree }) ?? undefined;
    } catch (err) {
      // Not known: such a read asks, as any read outside the worktree does.
      console.error(`Where attempt ${attemptId} keeps its saved output could not be read: ${words(err)}`);
      return undefined;
    }
  };

  /** The mode of the run a request belongs to, read from the store; manual for a task of no run. Throws when it cannot be read. */
  const modeOfRequest = (r: ApprovalRequest): RunMode => {
    // A chat has no run. Its Claude Code is not made more tedious than when it is used directly: as in a semi-autonomous
    // run, a command that runs confined (in the chat's folder, no network) and that the floor does not name runs.
    if (r.chat === true) return "semi";
    const row = r.taskId !== null ? db.prepare("SELECT r.mode FROM tasks t LEFT JOIN runs r ON r.id = t.run_id WHERE t.id = ?").get(r.taskId) : db.prepare("SELECT mode FROM runs WHERE id = ?").get(r.runId ?? null);
    if (row === undefined) throw new Error("its task or run is not in the store");
    if (row.mode === null) return "manual";
    if (!isRunMode(row.mode)) throw new Error(`its run has a mode Botbench does not know (${String(row.mode)})`);
    return row.mode;
  };

  /**
   * The gate's word on a permission request of the CLI. Only a shell command can come out allowed, and only when
   * everything about it is known: the attempt's own admission, the directory its hook reported, the input an allow
   * would let run, and the task's run and repository. Anything missing or unreadable means the owner is asked; in a
   * fully autonomous run, which asks nobody, it means a refusal.
   */
  const decideRequest = (r: ApprovalRequest, ticket: Ticket | undefined, cwd: string): RequestVerdict => {
    let mode: RunMode;
    try {
      mode = modeOfRequest(r);
    } catch (err) {
      // Not known to be anything but manual: the owner decides.
      console.error(`The mode of the run of a request could not be read: ${words(err)}`);
      return { verdict: "ask", why: "unknown" };
    }
    const nobody = (reason: string, why: AskWhy): RequestVerdict => (mode === "full" ? { verdict: "refuse", reason, why } : { verdict: "ask", why });
    if (!ticket || ticket.taskId !== r.taskId || ticket.runId !== (r.runId ?? null) || ticket.chat !== (r.chat === true) || ticket.role !== r.role) return nobody("This run is fully autonomous, and Botbench could not tell which of its agents asked, so it was refused. It was not run.", "unknown");
    if (r.escalation === true) return escalationRequestVerdict(r, ticket, cwd, mode);
    if (BOOKKEEPING_TOOLS.has(r.tool)) return { verdict: "allow", rule: "bookkeeping" };
    if (WEB_TOOLS.has(r.tool)) {
      try {
        // A run that read outside text (engine/intake.ts) has no standing choice of the owner's applied to it, as it has
        // no grant: each web tool asks. One whose mark cannot be read counts as marked; a task of no run read none.
        const row = ticket.chat ? undefined : r.taskId !== null ? db.prepare("SELECT t.run_id, r.outside_text FROM tasks t LEFT JOIN runs r ON r.id = t.run_id WHERE t.id = ?").get(r.taskId) : db.prepare("SELECT id AS run_id, outside_text FROM runs WHERE id = ?").get(r.runId ?? null);
        const outside = !ticket.chat && (row === undefined || (row.run_id !== null && row.outside_text !== 0));
        if (!outside) {
          const setting = chatWebAccess(db);
          if (setting === "off") return { verdict: "web", allowed: false };
          // Allow is for the public web: a fetch of this Mac or the local network is put to the owner.
          if (setting === "allow" && r.tool === "WebFetch" && !publicWebAddress(isObject(r.input) ? r.input.url : undefined)) return nobody(fullAutonomyRefusal(r.tool), "local_address");
          if (setting === "allow") return { verdict: "web", allowed: true };
        }
      } catch (err) {
        // Not known to be anything but Ask: the owner decides.
        console.error(`The setting Web access could not be read: ${words(err)}`);
      }
      return nobody(fullAutonomyRefusal(r.tool), "other_tool");
    }
    if (r.tool !== "Bash") return fileRequestVerdict(r, ticket, cwd, mode);
    try {
      // The input the CLI would run is the one its card would show, and the directory is the one its hook reported:
      // only then is the request exactly the call that was checked, and only then may a mode or a grant apply.
      const exact = cwd !== "" && isObject(r.input) && summarize(r.tool, r.input) === r.command;
      // Grants are looked up only for such a request. Without them the gate still asks the floor, at the worktree's top,
      // so that the record says why this asks. A read-only attempt, and one that belongs to no task, is never looked up:
      // every command of a planner asks, unless the run's mode lets a confined one run.
      const known = !ticket.readOnly && r.taskId !== null && exact;
      const at = path.resolve(ticket.worktree, cwd === "" ? "." : cwd);
      const input = exact ? r.input : { command: r.command };
      const task = r.taskId === null ? undefined : db.prepare("SELECT t.repo_path, t.run_id, r.outside_text FROM tasks t LEFT JOIN runs r ON r.id = t.run_id WHERE t.id = ?").get(r.taskId);
      const runId = known && task && typeof task.run_id === "number" ? task.run_id : null;
      // Who asks and where: only then can a grant apply. The repository is the task's, by the real path stored when
      // the task was started, so a standing permission earned in one task's worktree is the same one in the next task's.
      const scope = known && task ? { role: r.role, repo: String(task.repo_path), runId } : undefined;
      // Read from the store for this request: a standing permission taken back a moment ago is not among them.
      const grants = scope === undefined ? [] : [...(runId === null ? [] : runGrants(db, runId)), ...standingGrants(db, scope)];
      // A run that read outside text (engine/intake.ts) has no grant; one whose mark cannot be read counts as marked.
      const outsideText = task === undefined || task.outside_text !== 0;
      // The owner's "Ask before every command" is for a manual run's agents, not a chat's; one that cannot be read counts as on.
      let everyCommand = false;
      if (!ticket.chat && mode === "manual") {
        try {
          everyCommand = askEveryCommand(db);
        } catch (err) {
          console.error(`The setting Ask before every command could not be read: ${words(err)}`);
          everyCommand = true;
        }
      }
      const verdict = gate({ tool: r.tool, input, worktree: ticket.worktree, cwd: at, mode, confined: ticket.confined && exact, askEveryCommand: everyCommand, outsideText, ...(scope === undefined ? {} : { scope }) }, grants, floorSettings);
      // A confined attempt's command that only asks because it could not be tied to the call that was checked says so.
      if (verdict.verdict === "ask" && verdict.why === "not_confined" && ticket.confined && !exact) return { ...verdict, why: "not_checked" };
      if (verdict.verdict === "ask" || verdict.verdict === "deny" || verdict.verdict === "refuse") return verdict;
      if (verdict.rule === "mode_confined") return { verdict: "allow", rule: "mode", mode };
      if (verdict.rule !== "preapproved" && verdict.rule !== "standing") return nobody(fullAutonomyRefusal(r.tool), "unknown");
      const grant = grants.find((g) => g.id === verdict.grantId);
      return grant ? { verdict: "allow", rule: verdict.rule, grant } : nobody(fullAutonomyRefusal(r.tool), "unknown");
    } catch (err) {
      // The gate could not be asked: nothing is allowed on it, and the owner decides, or nobody does.
      console.error(`The gate could not decide about a request of task ${r.taskId}: ${words(err)}`);
      return nobody("This run is fully autonomous, and Botbench could not check this request, so it was refused. It was not run.", "unknown");
    }
  };

  /**
   * The gate's word on a request to run outside the agent's sandbox: in a manual or semi-autonomous run the owner
   * decides, every time, and in a fully autonomous one it is refused. The floor is read for a command so that the card,
   * or the refusal, names its rule; nothing else is looked up. Anything that fails on the way asks, or refuses.
   */
  const escalationRequestVerdict = (r: ApprovalRequest, ticket: Ticket, cwd: string, mode: RunMode): RequestVerdict => {
    try {
      // The floor reads the shell command itself, not the card's text, which is the whole input when the request
      // carries more than the command (network, more permissions).
      const input = r.tool === "Bash" ? { command: isObject(r.input) && typeof r.input.command === "string" && r.input.command !== "" ? r.input.command : r.command } : isObject(r.input) ? r.input : {};
      const verdict = gate({ tool: r.tool, input, worktree: ticket.worktree, cwd: path.resolve(ticket.worktree, cwd === "" ? "." : cwd), mode, escalation: true }, [], floorSettings);
      return verdict.verdict === "allow" ? (mode === "full" ? { verdict: "refuse", reason: ESCALATION_REFUSED, why: "escalation" } : { verdict: "ask", why: "escalation" }) : verdict;
    } catch (err) {
      console.error(`The gate could not decide about an escalation of task ${r.taskId}: ${words(err)}`);
      return mode === "full" ? { verdict: "refuse", reason: ESCALATION_REFUSED, why: "escalation" } : { verdict: "ask", why: "escalation" };
    }
  };

  /**
   * The gate's word on a request of the CLI for any tool but the shell, the same in every mode: a read or an edit inside
   * the worktree, and a Read of the CLI's own saved output of this attempt, run without asking (the CLI may ask about one
   * when its own rule is narrower, as after the agent moved into a sub-folder); anything else asks, or is refused in a
   * fully autonomous run. The path checked is the path that runs: an allow hands the CLI back this same input.
   */
  const fileRequestVerdict = (r: ApprovalRequest, ticket: Ticket, cwd: string, mode: RunMode): RequestVerdict => {
    const asked = (why: AskWhy): RequestVerdict => (mode === "full" ? { verdict: "refuse", reason: fullAutonomyRefusal(r.tool), why } : { verdict: "ask", why });
    try {
      const input = isObject(r.input) ? r.input : null;
      if (input === null || !(namesAFile(r.tool) || r.tool === "Glob" || r.tool === "Grep")) return asked("other_tool");
      // A path that is not a full one, or a search with none, starts at the folder the agent stands in: it must be known.
      const where = input.file_path ?? input.notebook_path ?? input.path;
      if (cwd === "" && !(typeof where === "string" && path.isAbsolute(where))) return asked("not_checked");
      const at = path.resolve(ticket.worktree, cwd === "" ? "." : cwd);
      const sessionOutput = sessionOutputOf(ticket.attemptId, ticket.worktree);
      const verdict = gate({ tool: r.tool, input, worktree: ticket.worktree, cwd: at, mode, ...(sessionOutput === undefined ? {} : { sessionOutput }) }, [], floorSettings);
      if (verdict.verdict === "allow") return verdict.rule === "auto_worktree_edit" || verdict.rule === "worktree_read" || verdict.rule === "session_output_read" ? { verdict: "allow", rule: "files", edit: verdict.rule === "auto_worktree_edit" } : asked("unknown");
      return verdict;
    } catch (err) {
      console.error(`The gate could not decide about a ${shorten(r.tool, 100)} request of task ${r.taskId}: ${words(err)}`);
      return mode === "full" ? { verdict: "refuse", reason: "This run is fully autonomous, and Botbench could not check this request, so it was refused. It was not run.", why: "unknown" } : { verdict: "ask", why: "unknown" };
    }
  };

  /**
   * An agent's question, already read as one Botbench can show. In a fully autonomous run nobody is asked: the question
   * and what the agent is told are one log entry, and the agent is told to decide itself and say what it chose. In any
   * other mode it is a pending approval of its own kind, with no command on it, and waits for the owner's answer
   * (`answerQuestion`). A mode that cannot be read counts as one with an owner to ask, as for any request.
   */
  const askQuestion = (r: ApprovalRequest, question: Question, ticket: Ticket | undefined, cwd: string, deny: (detail: string) => Promise<Answer>): Promise<Answer> => {
    let mode: RunMode | null = null;
    try {
      mode = modeOfRequest(r);
    } catch (err) {
      console.error(`The mode of the run of a question could not be read: ${words(err)}`);
    }
    if (mode === "full") {
      try {
        appendLog(db, { taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, rule: "question_unasked", tool: r.tool, command: question.text, cwd, detail: AUTONOMOUS_ANSWER });
      } catch (err) {
        return deny(`This question could not be recorded, so it was refused: ${words(err)}`);
      }
      if (ticket && ticket.resumes !== null && ticket.taskId !== null) supersedeWhere("After the restart the agent's first request was a question nobody is asked in a fully autonomous run, so the owner's stored answer was not used.", "task_id = ? AND attempt_id = ? AND stored_decision IS NOT NULL", ticket.taskId, ticket.resumes);
      return Promise.resolve({ decision: "decline", note: null, approvalId: null, refused: AUTONOMOUS_ANSWER });
    }
    let id: number;
    try {
      id = transaction(db, () => {
        const inserted = db
          .prepare("INSERT INTO approvals (task_id, run_id, chat, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at, question) VALUES (?, ?, 0, ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?)")
          .run(r.taskId, r.runId ?? null, r.attemptId, r.role, r.tool, question.text, cwd, r.toolCallId, now(), storedQuestion(question));
        const approvalId = Number(inserted.lastInsertRowid);
        appendLog(db, { taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, approvalId, rule: "asked_owner", tool: r.tool, command: question.text, cwd, detail: null });
        return approvalId;
      });
    } catch (err) {
      return deny(`The question could not be recorded: ${words(err)}`);
    }
    const waiting = new Promise<Answer>((resolve) => waiters.set(id, resolve));
    announce(id);
    return waiting;
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
    if ((r.taskId !== null ? 1 : 0) + (r.runId === undefined || r.runId === null ? 0 : 1) + (r.chat === true ? 1 : 0) !== 1) return deny("The request names none of a task, a run and a chat, or more than one.");
    if (typeof r.tool !== "string" || r.tool === "" || typeof r.toolCallId !== "string" || r.toolCallId === "" || typeof r.command !== "string" || r.command === "" || typeof r.role !== "string" || r.role === "") {
      return deny("The request does not say what it is for.");
    }
    if (r.command.length > MAX_COMMAND) return deny(`The request is ${r.command.length} characters long, too long to show the owner in full.`);
    // Also when the CLI asks without its hook having been heard: a read-only attempt's request for any other tool is never the owner's to allow.
    if (ticket?.readOnly && !READ_ONLY_TOOLS.has(r.tool)) return deny(`The ${stepWords(ticket.role)} only reads and may not use ${shorten(r.tool, 100)}.`);
    const cwd = r.cwd ?? ticket?.seen.get(r.toolCallId) ?? "";
    ticket?.seen.delete(r.toolCallId);
    // An agent's question to the owner (approvals/question.ts), of a task or a planner: one Botbench cannot show as a card
    // is refused here, with the reason for the agent, and makes no card. A chat's is asked about as any other tool is.
    const asked = r.tool === QUESTION_TOOL && r.chat !== true ? readQuestion(r.input) : null;
    if (asked !== null && "problem" in asked) return deny(asked.problem);
    const question = asked as Question | null;
    // An attempt that resumes one from before a restart: the owner's stored answers to that attempt's requests are its to use.
    // An escalation is never answered with an answer given before: it is asked afresh each time.
    if (ticket && ticket.resumes !== null && ticket.taskId !== null && ticket.taskId === r.taskId && r.escalation !== true) {
      const carried = db.prepare(`SELECT ${APPROVAL_COLUMNS} WHERE a.task_id = ? AND a.attempt_id = ? AND a.status = 'pending' AND a.stored_decision IS NOT NULL ORDER BY a.id`).all(ticket.taskId, ticket.resumes).map(toApproval);
      // The same thing asked again: same role, tool, command and directory. A directory nobody reported is not known to be the same.
      // A question is the same when its text and its choices, labels and the agent's lines about them, in order, are: the
      // owner answered those choices as they were put. Where the agent stood says nothing about it.
      const labels = (q: Question): string => JSON.stringify(q.choices.map((c) => [c.label, c.description]));
      const match =
        question !== null
          ? carried.find((a) => a.role === r.role && a.tool === r.tool && a.question !== null && a.question.text === question.text && labels(a.question) === labels(question) && a.answer !== null)
          : cwd === ""
            ? undefined
            : carried.find((a) => a.role === r.role && a.tool === r.tool && a.question === null && a.command === r.command && a.cwd === cwd);
      if (match) {
        const decision = match.storedDecision!;
        const ownerRule = match.question !== null ? "owner_answered" : decision === "allow" ? "owner_allowed" : "owner_declined";
        try {
          // Used up before it is handed over: whatever happens next, this answer is never given a second time.
          transaction(db, () => {
            const used = db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending' AND stored_decision = ?").run(decision === "allow" ? "allowed" : "declined", now(), match.id, decision);
            if (Number(used.changes) !== 1) throw new Error("the stored answer was no longer there");
            // The owner's own decision is on record for this approval, or it is not applied.
            if (!db.prepare("SELECT 1 FROM action_log WHERE approval_id = ? AND rule = ?").get(match.id, ownerRule)) throw new Error("the log holds no decision of the owner's for it");
            appendLog(db, { taskId: r.taskId, attemptId: r.attemptId, approvalId: match.id, rule: "stored_answer_applied", tool: r.tool, command: question?.text ?? r.command, cwd, detail: `The owner's answer from before the restart (${match.question !== null ? "an answer to the question" : decision}) was given to tool call ${shorten(r.toolCallId, 200)}.` });
          });
        } catch (err) {
          return deny(`The owner's stored answer could not be applied: ${words(err)}`);
        }
        announce(match.id);
        // A question's answer goes back keyed by the text the agent asked this time, which is the stored one.
        return Promise.resolve({ decision, note: match.note, approvalId: match.id, refused: null, ...(question !== null && match.answer !== null ? { answers: { [question.text]: match.answer } } : {}) });
      }
      if (carried.length > 0) {
        supersedeWhere(`After the restart the agent asked for something else first (${shorten(r.tool, 100)}: ${shorten(r.command, 300)}), so the owner's stored answer was not used.`, stillCarried, ticket.taskId, ticket.resumes);
      }
    }
    if (question !== null) return askQuestion(r, question, ticket, cwd, deny);
    // What Botbench itself decides about the request, now that it is the CLI's own: the floor, then the run's pre-approved list and the standing permissions.
    const verdict = decideRequest(r, ticket, cwd);
    if (verdict.verdict === "deny") return deny(verdict.reason);
    if (verdict.verdict === "allow" && verdict.rule === "bookkeeping") {
      try {
        // What cannot be logged does not run.
        appendLog(db, { taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, rule: "bookkeeping", tool: r.tool, command: r.command, cwd, detail: "Ran without asking you: one of Claude Code's own bookkeeping tools, which reaches nothing outside it." });
      } catch (err) {
        return deny(`This could not be recorded, so it was not let through: ${words(err)}`);
      }
      return Promise.resolve({ decision: "allow", note: null, approvalId: null, refused: null, bookkeeping: true });
    }
    if (verdict.verdict === "web") {
      const detail = verdict.allowed ? `Ran without asking you: Web access is set to ${WEB_ACCESS_WORDS.allow} in Settings.` : WEB_OFF;
      try {
        // What cannot be logged does not run.
        const chat = ticket?.chat === true;
        appendLog(db, chat ? { taskId: null, attemptId: r.attemptId, rule: "chat_web_access", tool: r.tool, command: r.command, cwd, detail } : { taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, rule: verdict.allowed ? "web_allowed" : "web_refused", tool: r.tool, command: r.command, cwd, detail });
      } catch (err) {
        return deny(`This could not be recorded, so it was not let through: ${words(err)}`);
      }
      return Promise.resolve(verdict.allowed ? { decision: "allow", note: null, approvalId: null, refused: null, web: true } : { decision: "decline", note: null, approvalId: null, refused: WEB_OFF });
    }
    if (verdict.verdict === "refuse") {
      let refusal: RefusalKind = "unconfined";
      try {
        // Read as the CLI would run it, from where its agent stood; a request of no known attempt has no copy to read it in.
        refusal = refusalKind({ tool: r.tool, input: isObject(r.input) ? r.input : { command: r.command }, worktree: ticket?.worktree ?? null, cwd: ticket === undefined ? "" : path.resolve(ticket.worktree, cwd === "" ? "." : cwd), why: verdict.why, ...(verdict.floor === undefined ? {} : { floor: verdict.floor }) });
      } catch (err) {
        // Not known to be harmless: it counts as unconfined, and so blocks the accept.
        console.error(`What kind of request was refused could not be worked out: ${words(err)}`);
      }
      // The agent is told the refusal; the record also says, in words, when it does not stop the task being accepted.
      const harmless = refusalBlocksAccept(refusal) ? undefined : HARMLESS_WORDS[refusal];
      const detail = harmless === undefined ? verdict.reason : `${verdict.reason} ${harmless}`;
      const about = { taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, tool: r.tool, command: r.command, cwd, detail, refusal };
      try {
        appendLog(db, { ...about, rule: "mode_refused" });
      } catch (err) {
        // The refusal stands whether or not it could be recorded under its own rule.
        return deny(`${verdict.reason} It could not be recorded as such: ${words(err)}`);
      }
      if (ticket && ticket.resumes !== null && ticket.taskId !== null) supersedeWhere("After the restart the agent's first request was one Botbench refused, so the owner's stored answer was not used.", stillCarried, ticket.taskId, ticket.resumes);
      return Promise.resolve({ decision: "decline", note: null, approvalId: null, refused: verdict.reason });
    }
    if (verdict.verdict === "allow" && verdict.rule === "files") {
      if (verdict.edit) {
        try {
          // What cannot be logged does not run. A read is not logged, as a read inside the worktree never is.
          appendLog(db, { taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, rule: "auto_worktree_edit", tool: r.tool, command: requestTarget(r.tool, r.input, ticket!.worktree, cwd === "" ? null : path.resolve(ticket!.worktree, cwd)) ?? r.command, cwd, detail: ticket!.chat ? "Claude Code asked about this change; it is inside the chat's own folder, so it ran without asking you." : "Claude Code asked about this change; it is inside the task's copy, so it ran without asking you." });
        } catch (err) {
          return deny(`Botbench could not record this edit, so it was not let through: ${words(err)}`);
        }
      }
      return Promise.resolve({ decision: "allow", note: null, approvalId: null, refused: null, files: true });
    }
    if (verdict.verdict === "allow" && verdict.rule === "mode") {
      try {
        // What cannot be logged does not run.
        const chat = ticket?.chat === true;
        appendLog(db, { taskId: r.taskId, runId: r.runId ?? null, attemptId: r.attemptId, rule: chat ? "chat_confined" : "mode_allowed", tool: r.tool, command: r.command, cwd, detail: chat ? "Ran without asking you: in a chat a command runs when it is kept in the chat's folder, away from your sign-ins and the network." : "Ran without asking you: it ran kept in the task's copy, away from your sign-ins and the network, and nothing in it is on the always-ask list." });
      } catch (err) {
        return deny(`This command could not be recorded, so it was not let through: ${words(err)}`);
      }
      return Promise.resolve(ticket?.chat === true ? { decision: "allow", note: null, approvalId: null, refused: null, chat: true } : { decision: "allow", note: null, approvalId: null, refused: null, byMode: verdict.mode });
    }
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
    const escalation = r.escalation === true;
    const always = [escalation ? "Codex asked to run this outside its sandbox." : null, verdict.floor !== undefined ? `Always asks: ${verdict.floor}.` : null].filter((line) => line !== null).join(" ") || null;
    const asksBecause = askWords(verdict.why, { tool: r.tool, chat: ticket?.chat === true, ...(verdict.floor === undefined ? {} : { floor: verdict.floor }) });
    let target: string | null = null;
    try {
      target = ticket === undefined ? null : requestTarget(r.tool, r.input, ticket.worktree, cwd === "" ? null : path.resolve(ticket.worktree, cwd));
    } catch (err) {
      // The card then says the file was not reported; the request still asks.
      console.error(`Where a ${shorten(r.tool, 100)} request is aimed could not be worked out: ${words(err)}`);
    }
    let id: number;
    try {
      id = transaction(db, () => {
        const inserted = db
          .prepare("INSERT INTO approvals (task_id, run_id, chat, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at, asks_because, target, escalation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)")
          .run(r.taskId, r.runId ?? null, r.chat === true ? 1 : 0, r.attemptId, r.role, r.tool, r.command, cwd, typeof r.reason === "string" ? shorten(r.reason, MAX_REASON) : null, r.toolCallId, now(), asksBecause, target, escalation ? 1 : 0);
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
      if (current.question !== null) throw new ApprovalError(409, "This is a question from Claude Code: answer it with one of its choices or your own words.");
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
    if (stored) tellStored(approval);
    return approval;
  };

  const answerQuestion = (id: number, given: string): Approval => {
    const problem = answerProblem(given);
    if (problem !== null) throw new ApprovalError(400, problem);
    // The answer and its log entry are one write: neither exists without the other. It is stored as given, and is only ever text for the agent.
    const { stored, question } = transaction(db, () => {
      const current = getApproval(db, id);
      if (!current) throw new ApprovalError(404, "No such approval.");
      if (current.question === null) throw new ApprovalError(409, "This request is not a question. Answer it with Allow once or Deny.");
      if (current.status !== "pending" || current.answer !== null || current.storedDecision !== null) throw new ApprovalError(409, current.status === "superseded" ? "This question is no longer waiting for an answer." : "This question already has your answer.");
      const entry = { taskId: current.taskId, runId: current.runId, attemptId: current.attemptId, approvalId: id, rule: "owner_answered", tool: current.tool, command: current.command, cwd: current.cwd, detail: given } as const;
      if (waiters.has(id)) {
        db.prepare("UPDATE approvals SET status = 'allowed', answer = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(given, now(), id);
        appendLog(db, entry);
        return { stored: false, question: current.question };
      }
      if (current.parkedAt === null) throw new ApprovalError(409, "This question is no longer waiting for an answer.");
      // Asked before a restart: kept on the approval until the re-driven task asks it again.
      db.prepare("UPDATE approvals SET stored_decision = 'allow', stored_at = ?, answer = ? WHERE id = ? AND status = 'pending' AND stored_decision IS NULL").run(now(), given, id);
      appendLog(db, entry);
      return { stored: true, question: current.question };
    });
    if (!stored) {
      waiters.get(id)!({ decision: "allow", note: null, approvalId: id, refused: null, answers: { [question.text]: given } });
      waiters.delete(id);
    }
    announce(id);
    const approval = getApproval(db, id)!;
    if (stored) tellStored(approval);
    return approval;
  };

  /** Tell the listeners of `onStoredAnswer` that the owner's answer to a parked approval was stored. */
  const tellStored = (approval: Approval): void => {
    for (const listener of storedListeners) {
      try {
        listener(approval);
      } catch (err) {
        // The answer is stored and stands; the next start says what became of it.
        console.error(`A stored answer could not be passed on for its task to be resumed: ${words(err)}`);
      }
    }
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
    // What Codex asks to run outside its sandbox is asked every time; no grant would ever answer it.
    if (db.prepare("SELECT escalation FROM approvals WHERE id = ?").get(approval.id)?.escalation !== 0) return "Codex asks to run it outside its sandbox, and that is asked every time";
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
      // What a stranger's text may have led to is asked about every time.
      if (approval.outsideText) return "its run read a GitHub issue, which people outside the project wrote";
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
    const sessionOutput = tool === "Read" ? sessionOutputOf(ticket.attemptId, ticket.worktree) : undefined;
    const verdict = gate({ tool, input, worktree: ticket.worktree, cwd, ...(sessionOutput === undefined ? {} : { sessionOutput }) }, [], floorSettings);
    // With links followed: a directory that is a link out of the worktree is recorded as where it leads.
    const relative = path.relative(ticket.worktree, real(cwd));
    const from = relative === "" ? "." : relative;
    // Asked without a mode, the gate never refuses here; were it to, the call would not run.
    if (verdict.verdict === "deny" || verdict.verdict === "refuse") return denied(`Botbench's permission check refused this call: ${verdict.reason}`, { ...about, tool, cwd: from });
    // A read-only attempt has reading and the shell and nothing else: any other tool is refused, not asked about.
    if (ticket.readOnly && !READ_ONLY_TOOLS.has(tool)) return denied(`Botbench's permission check refused this call: the ${stepWords(ticket.role)} only reads and may not use ${shorten(tool, 100)}.`, { ...about, tool, command: String(input.file_path ?? input.notebook_path ?? ""), cwd: from });
    // Where this very call was made from, whatever is said about it: the CLI may still ask about a call the check let
    // pass (an edit after the agent moved into a sub-folder), and its card then says the folder of this call, not of another.
    if (ticket.seen.size >= MAX_SEEN && !ticket.seen.has(toolCallId)) ticket.seen.delete(ticket.seen.keys().next().value!);
    ticket.seen.set(toolCallId, from);
    if (BOOKKEEPING_TOOLS.has(tool)) {
      try {
        // What cannot be logged does not run.
        appendLog(db, { ...about, rule: "bookkeeping", tool, command: shorten(JSON.stringify(input), MAX_COMMAND), cwd: from, detail: "Ran without asking you: one of Claude Code's own bookkeeping tools, which reaches nothing outside it." });
      } catch (err) {
        return denied(`Botbench could not record this call, so it was not let through: ${words(err)}`, { ...about, tool });
      }
      return { verdict: "pass", reason: "" };
    }
    if (verdict.verdict === "ask" || verdict.rule === "preapproved" || verdict.rule === "standing" || verdict.rule === "mode_confined") {
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
            // Nothing re-drives a chat: its requests from before this start end here, unanswered, and say why.
            supersedeWhere(CHAT_RESTARTED, "chat = 1");
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

  const admit = (o: { taskId?: number; runId?: number; chat?: boolean; role: string; worktree: string; resumes?: number; readOnly?: boolean; confined?: boolean }): Admission => {
    if ((o.taskId === undefined ? 0 : 1) + (o.runId === undefined ? 0 : 1) + (o.chat === true ? 1 : 0) !== 1) throw new Error("A permission ticket is for a task, a run's planner or a chat, one of the three.");
    const secret = randomBytes(32).toString("hex");
    const key = hashOf(secret);
    // The CLI reports directories with links followed, so the worktree is kept the same way.
    let worktree = path.resolve(o.worktree);
    try {
      worktree = fs.realpathSync(worktree);
    } catch {
      // A worktree that is not there yet is compared as written.
    }
    const ticket: Ticket = { taskId: o.taskId ?? null, chat: o.chat === true, runId: o.runId ?? null, readOnly: o.readOnly === true, confined: o.confined === true, role: o.role, worktree, attemptId: null, resumes: o.resumes ?? null, seen: new Map() };
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

  return { endRunApprovals, socketPath, offerStandingAfter, standingOffer, grantStanding, revokeStanding, listen, admit, request, answer, answerQuestion, onStoredAnswer: (listener) => void storedListeners.push(listener), endParked, pending: () => listApprovals(db, "pending"), close };
}
