import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "../store/db.ts";
import { gate } from "./gate.ts";

/*
 * The permission broker. Everything an agent wants to do that is not an edit
 * inside its worktree ends here as an approval the owner answers.
 *
 * Two ways in, and they are not equal:
 *   request()   called inside Smelt when a CLI asks for permission. It writes
 *               the approval and waits for the owner. Only answer() resolves it,
 *               and answer() is reachable only through the signed-in API.
 *   the socket  used by the pre-tool hook Smelt gives the CLI. It carries one
 *               question, "what does the gate say about this call?", and the
 *               reply is pass, ask or deny. It cannot allow anything and
 *               cannot answer an approval.
 * Whatever goes wrong on either way, the outcome is a refusal.
 *
 * Across a restart: an approval that was pending when Smelt stopped stays pending and is marked parked. Nothing
 * waits for it in this process, so the owner's answer cannot be handed to anyone: it is stored on the approval.
 * The engine then re-drives the task, and the stored answer goes, once, to the first request of the resuming
 * attempt that asks for the same thing: same task, same role, same tool, same command, same directory. If that
 * attempt's first request is anything else, the stored answer is discarded and the request is asked afresh.
 */

export const SOCKET_FILE = "broker.sock";
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
export type LogRule = "asked_owner" | "owner_allowed" | "owner_declined" | "ended_unanswered" | "auto_worktree_edit" | "broker_failure_denied" | "stored_answer_applied" | "stored_answer_discarded";

export interface Approval {
  id: number;
  taskId: number;
  /** The first line of the task's prompt, so a card can say which task is asking. */
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
  /** When a start of Smelt found this approval pending from before: its agent is stopped, and answering re-drives the task. Null for one asked in this run. */
  parkedAt: string | null;
  /** The owner's answer to a parked approval, kept until the re-driven task asks again. The status stays `pending` until then. */
  storedDecision: Decision | null;
}

export interface LogEntry {
  id: number;
  ts: string;
  taskId: number | null;
  attemptId: number | null;
  approvalId: number | null;
  rule: LogRule;
  tool: string;
  command: string;
  cwd: string;
  detail: string | null;
}

export interface ApprovalRequest {
  taskId: number;
  attemptId: number;
  role: string;
  tool: string;
  command: string;
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
  /** Smelt is stopping while the attempt waits for the owner: the secret stops working and the attempt's pending approvals stay pending, parked, for the next start. */
  park(): void;
  /** The attempt is over: the secret stops working and nothing of it is left pending. */
  release(): void;
}

export interface Broker {
  readonly socketPath: string;
  /** Open the socket. Rejects when it cannot be opened; requests through it are then refused by the hook itself. */
  listen(): Promise<void>;
  /** `resumes` names the attempt this one continues after a restart: only then can it be given that attempt's stored answers. */
  admit(o: { taskId: number; role: string; worktree: string; resumes?: number }): Admission;
  /** Record a pending approval and wait for the owner. Never rejects: any failure is a decline. */
  request(request: ApprovalRequest): Promise<Answer>;
  /**
   * The owner's answer. Throws `ApprovalError` for an unknown approval or one that is no longer pending.
   * For a parked approval the answer is stored, the approval stays pending, and the listeners of `onStoredAnswer` are told.
   */
  answer(id: number, decision: Decision, note?: string | null): Approval;
  /** Be told when the owner's answer to a parked approval was stored, so its task can be re-driven. */
  onStoredAnswer(listener: (approval: Approval) => void): void;
  /** End every pending approval of a task that cannot go on, with the reason for the log. Stored answers among them are discarded. */
  endParked(taskId: number, why: string): void;
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
    taskId: Number(row.task_id),
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

const APPROVAL_COLUMNS = "a.*, t.prompt AS prompt FROM approvals a JOIN tasks t ON t.id = a.task_id";

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

/** The action log, oldest first; everything or one task's. The log is only ever read here and added to by the broker. */
export function actionLog(db: DatabaseSync, taskId?: number): LogEntry[] {
  const rows = taskId === undefined ? db.prepare("SELECT * FROM action_log ORDER BY id").all() : db.prepare("SELECT * FROM action_log WHERE task_id = ? ORDER BY id").all(taskId);
  return rows.map((row) => ({
    id: Number(row.id),
    ts: String(row.ts),
    taskId: int(row.task_id),
    attemptId: int(row.attempt_id),
    approvalId: int(row.approval_id),
    rule: String(row.rule) as LogRule,
    tool: String(row.tool),
    command: String(row.command),
    cwd: String(row.cwd),
    detail: text(row.detail),
  }));
}

interface LogWrite {
  taskId: number | null;
  attemptId: number | null;
  approvalId?: number | null;
  rule: LogRule;
  tool: string;
  command: string;
  cwd: string;
  detail?: string | null;
}

function appendLog(db: DatabaseSync, e: LogWrite): void {
  db.prepare("INSERT INTO action_log (ts, task_id, attempt_id, approval_id, rule, tool, command, cwd, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(now(), e.taskId, e.attemptId, e.approvalId ?? null, e.rule, e.tool, e.command, e.cwd, e.detail ?? null);
}

interface Ticket {
  taskId: number;
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

export function createBroker(options: { db: DatabaseSync; home: string; onChange: (approval: Approval) => void }): Broker {
  const { db } = options;
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
    for (const ids of [{ taskId: e.taskId, attemptId: e.attemptId }, { taskId: null, attemptId: null }]) {
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
          appendLog(db, { taskId: Number(row.task_id), attemptId: Number(row.attempt_id), approvalId: Number(row.id), rule: row.stored_decision === null ? "ended_unanswered" : "stored_answer_discarded", tool: String(row.tool), command: String(row.command), cwd: String(row.cwd), detail: why });
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

  const request = (r: ApprovalRequest): Promise<Answer> => {
    const ticket = [...tickets.values()].find((t) => t.attemptId === r.attemptId);
    const stillCarried = "task_id = ? AND attempt_id = ? AND stored_decision IS NOT NULL";
    const deny = (detail: string): Promise<Answer> => {
      refuse({ taskId: r.taskId, attemptId: r.attemptId, tool: String(r.tool), command: String(r.command), cwd: typeof r.cwd === "string" ? r.cwd : "", detail });
      // A request Smelt refuses is still the resuming attempt's request: stored answers do not wait for a later one.
      if (ticket && ticket.resumes !== null) supersedeWhere("After the restart the agent's first request was one Smelt refused, so the owner's stored answer was not used.", stillCarried, ticket.taskId, ticket.resumes);
      return Promise.resolve({ decision: "decline", note: null, approvalId: null, refused: detail });
    };
    if (closed) return deny("The broker is closed.");
    if (typeof r.tool !== "string" || r.tool === "" || typeof r.toolCallId !== "string" || r.toolCallId === "" || typeof r.command !== "string" || r.command === "" || typeof r.role !== "string" || r.role === "") {
      return deny("The request does not say what it is for.");
    }
    if (r.command.length > MAX_COMMAND) return deny(`The request is ${r.command.length} characters long, too long to show the owner in full.`);
    const cwd = r.cwd ?? ticket?.seen.get(r.toolCallId) ?? "";
    ticket?.seen.delete(r.toolCallId);
    // An attempt that resumes one from before a restart: the owner's stored answers to that attempt's requests are its to use.
    if (ticket && ticket.resumes !== null && ticket.taskId === r.taskId) {
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
    let id: number;
    try {
      id = transaction(db, () => {
        const inserted = db
          .prepare("INSERT INTO approvals (task_id, attempt_id, role, tool, command, cwd, reason, tool_call_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
          .run(r.taskId, r.attemptId, r.role, r.tool, r.command, cwd, typeof r.reason === "string" ? shorten(r.reason, MAX_REASON) : null, r.toolCallId, now());
        const approvalId = Number(inserted.lastInsertRowid);
        appendLog(db, { taskId: r.taskId, attemptId: r.attemptId, approvalId, rule: "asked_owner", tool: r.tool, command: r.command, cwd });
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
    if (decision !== "allow" && decision !== "decline") throw new ApprovalError(400, 'The decision must be "allow" or "decline".');
    const kept = typeof note === "string" && note.trim() !== "" ? note.trim().slice(0, MAX_NOTE) : null;
    const status: ApprovalStatus = decision === "allow" ? "allowed" : "declined";
    // The decision and its log entry are one write: neither exists without the other.
    const stored = transaction(db, () => {
      const current = getApproval(db, id);
      if (!current) throw new ApprovalError(404, "No such approval.");
      if (current.status !== "pending") throw new ApprovalError(409, `This approval is already ${current.status}.`);
      if (current.storedDecision !== null) throw new ApprovalError(409, `This approval already has your answer (${current.storedDecision}); Smelt is resuming its task.`);
      const entry = { taskId: current.taskId, attemptId: current.attemptId, approvalId: id, rule: decision === "allow" ? "owner_allowed" : "owner_declined", tool: current.tool, command: current.command, cwd: current.cwd, detail: kept } as const;
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
      return denied("Smelt's permission gate was sent a message that is not JSON.");
    }
    if (!isObject(message) || typeof message.secret !== "string") return denied("Smelt's permission gate was sent a message it cannot read.");
    // Looked up by hash, so the secret itself is never compared a byte at a time.
    const ticket = tickets.get(hashOf(message.secret));
    if (!ticket) return denied("Smelt's permission gate does not know this attempt.");
    if (ticket.attemptId === null) return denied("Smelt's permission gate has no attempt for this secret yet.", { taskId: ticket.taskId });
    const about = { taskId: ticket.taskId, attemptId: ticket.attemptId };
    const { tool, input, toolCallId, cwd } = message;
    if (typeof tool !== "string" || tool === "" || typeof toolCallId !== "string" || toolCallId === "" || typeof cwd !== "string" || !path.isAbsolute(cwd) || !isObject(input)) {
      return denied("Smelt's permission gate was sent a tool call it cannot read.", { ...about, tool: typeof tool === "string" ? tool : "" });
    }
    const verdict = gate({ tool, input, worktree: ticket.worktree, cwd });
    const relative = path.relative(ticket.worktree, cwd);
    const from = relative === "" ? "." : relative;
    if (verdict.verdict === "ask") {
      if (ticket.seen.size >= MAX_SEEN) ticket.seen.delete(ticket.seen.keys().next().value!);
      ticket.seen.set(toolCallId, from);
      return { verdict: "ask", reason: "Smelt asks the owner before this runs." };
    }
    if (verdict.rule !== null) {
      const file = String(input.file_path ?? input.notebook_path);
      try {
        appendLog(db, { ...about, rule: verdict.rule, tool, command: path.relative(ticket.worktree, path.resolve(cwd, file)), cwd: from });
      } catch (err) {
        // What cannot be logged does not run.
        return denied(`Smelt could not record this edit, so it was not let through: ${words(err)}`, { ...about, tool });
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
      refuseUnread("Smelt's permission gate was sent no complete message in time.");
      setTimeout(() => socket.destroy(), 1000).unref();
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > MAX_MESSAGE) return refuseUnread("Smelt's permission gate was sent a message that is too long.");
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      let answer: Reply;
      try {
        answer = decide(buffer.slice(0, end));
      } catch (err) {
        answer = { verdict: "deny", reason: `Smelt's permission gate failed: ${words(err)}` };
      }
      reply(answer);
    });
    socket.on("end", () => refuseUnread("Smelt's permission gate was sent a message with no end."));
  };

  const listen = (): Promise<void> =>
    inUse().then(
      (taken) =>
        new Promise<void>((resolve, reject) => {
          if (taken) return reject(new Error(`Another Smelt is already running on this data directory (its permission broker answers at ${socketPath}). Stop it first, or give this one its own SMELT_HOME.`));
          // What a Smelt that stopped left pending stays pending, marked as asked before this start. Nothing waits for it
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

  /** Whether a live broker already answers on the socket: then this data directory belongs to a running Smelt. */
  const inUse = (): Promise<boolean> =>
    new Promise((resolve) => {
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

  const listenNow = (resolve: () => void, reject: (err: Error) => void): void => {
    const opening = net.createServer({ allowHalfOpen: true }, onConnection);
    opening.once("error", (err) => reject(new Error(`The permission broker's socket could not be opened at ${socketPath}: ${words(err)}. Until it can, every command a task asks for is denied.`)));
    opening.listen(socketPath, () => {
      try {
        // The directory already keeps other accounts out; the socket says so itself as well.
        fs.chmodSync(socketPath, 0o600);
      } catch (err) {
        opening.close();
        return reject(new Error(`The permission broker's socket could not be made owner-only: ${words(err)}`));
      }
      opening.on("error", (err) => console.error(`The permission broker's socket failed: ${words(err)}`));
      server = opening;
      resolve();
    });
  };

  const admit = (o: { taskId: number; role: string; worktree: string; resumes?: number }): Admission => {
    const secret = randomBytes(32).toString("hex");
    const key = hashOf(secret);
    // The CLI reports directories with links followed, so the worktree is kept the same way.
    let worktree = path.resolve(o.worktree);
    try {
      worktree = fs.realpathSync(worktree);
    } catch {
      // A worktree that is not there yet is compared as written.
    }
    const ticket: Ticket = { taskId: o.taskId, role: o.role, worktree, attemptId: null, resumes: o.resumes ?? null, seen: new Map() };
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
        waiters.get(id)?.({ decision: "decline", note: null, approvalId: id, refused: "Smelt is stopping. The request waits for the owner until Smelt runs again." });
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
        if (ticket.resumes !== null) supersedeWhere("The resumed turn ended without asking for this again, so the owner's stored answer was not used.", "task_id = ? AND attempt_id = ? AND stored_decision IS NOT NULL", ticket.taskId, ticket.resumes);
      },
    };
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    tickets.clear();
    // Only what this broker is waiting on: the store may be shared with a Smelt that is still running.
    for (const id of [...waiters.keys()]) supersedeWhere(null, "id = ?", id);
    // Should the rows not have been writable, still nobody is left waiting: a request with no broker is declined.
    for (const [id, resolve] of waiters) resolve({ decision: "decline", note: null, approvalId: id, refused: null });
    waiters.clear();
    const open = server;
    server = null;
    for (const socket of sockets) socket.destroy();
    // Only a broker that opened the socket removes it: the file may be a running Smelt's.
    if (!open) return;
    await new Promise<void>((resolve) => open.close(() => resolve()));
    fs.rmSync(socketPath, { force: true });
  };

  const endParked = (taskId: number, why: string): void => supersedeWhere(why, "task_id = ?", taskId);

  return { socketPath, listen, admit, request, answer, onStoredAnswer: (listener) => void storedListeners.push(listener), endParked, pending: () => listApprovals(db, "pending"), close };
}
