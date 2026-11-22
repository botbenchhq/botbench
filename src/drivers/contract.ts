import type { DatabaseSync } from "node:sqlite";
import type { DriverEvent, TurnEndReason } from "./events.ts";

/**
 * Where a later attempt picks a session up again. Only the driver that made it
 * knows what is inside; everything else stores it and hands it back unread.
 */
export type ResumeCursor = string;

/** What a driver's CLI can do. Callers check these instead of the driver's name. */
export interface DriverCapabilities {
  /** A later attempt can continue an earlier session from its resume cursor. */
  resume: boolean;
  /** A running turn can be stopped. */
  interrupt: boolean;
  /** The CLI's permission requests reach `respondToRequest`. */
  permissionRequests: boolean;
}

/** How the CLI is billed, taken from the CLI's own account of its login. */
export type BillingKind = "subscription" | "metered" | "unknown";

/** What a driver found out about its CLI on this machine, without reading any credential. */
export interface DriverProbe {
  installed: boolean;
  /** The version the CLI reports, or null when it is not installed or printed none. */
  version: string | null;
  /** This Smelt knows how to drive that version. */
  supported: boolean;
  signedIn: boolean;
  billing: BillingKind;
  /** One sentence for the owner when the CLI cannot be driven, else null. */
  problem: string | null;
}

export interface StartAttemptOptions {
  /** The store the attempt row and its events are written to. */
  db: DatabaseSync;
  /** The directory the CLI works in. */
  cwd: string;
  /** Model name or alias as the CLI takes it. The CLI's default when left out. */
  model?: string;
  /** Continue the session an earlier attempt recorded. */
  resumeCursor?: ResumeCursor;
  /**
   * The CLI may create and change files below `cwd` without asking. Nothing else is allowed by this:
   * commands, and edits anywhere else, still need an approval. Meant for a task's worktree, whose
   * content comes from a repository, so the repository's own CLI settings, rules and hooks are not loaded.
   */
  allowEdits?: boolean;
  /**
   * Send this attempt's tool calls through the permission gate: the broker's socket and the secret that is this
   * attempt's alone. With it, what the CLI would ask a person arrives as `permission_request` events to be answered
   * with `respondToRequest`. Without it, everything the CLI would ask is denied.
   */
  gate?: { socketPath: string; secret: string };
}

/** One CLI process working on one attempt. */
export interface DriverSession {
  /** The row in `attempts` this session writes to. */
  readonly attemptId: number;
  readonly capabilities: DriverCapabilities;
  /** The newest resume cursor the CLI has given, or null before the first turn. */
  resumeCursor(): ResumeCursor | null;
  /** Send one message and resolve with how its turn ended. Rejects if a turn is already running or the session is over. */
  sendTurn(prompt: string): Promise<TurnEndReason>;
  /** Stop the running turn. Resolves once the turn has ended as interrupted and no process is left. Does nothing when no turn is running. */
  interruptTurn(): Promise<void>;
  /** Answer a `permission_request` by its id with a `PermissionResponse`. Rejects when no such request is waiting. */
  respondToRequest(requestId: string, response: unknown): Promise<void>;
  /** Receive every event after it is stored. Returns a function that stops delivery. */
  onEvent(listener: (event: DriverEvent) => void): () => void;
  /** End the session and make sure no process is left. Safe to call more than once. */
  close(): Promise<void>;
}

export interface Driver {
  /** The value stored in `attempts.driver`. */
  readonly name: string;
  readonly capabilities: DriverCapabilities;
  probe(): Promise<DriverProbe>;
  /** Probe, then start the CLI. Rejects with `DriverUnavailableError` and starts nothing when the probe finds a problem. */
  startAttempt(options: StartAttemptOptions): Promise<DriverSession>;
}

/** The CLI cannot be driven right now: missing, an unsupported version, or signed out. */
export class DriverUnavailableError extends Error {
  readonly probe: DriverProbe;
  constructor(probe: DriverProbe) {
    super(probe.problem ?? "The CLI cannot be driven.");
    this.name = "DriverUnavailableError";
    this.probe = probe;
  }
}
