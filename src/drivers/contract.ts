import type { DatabaseSync } from "node:sqlite";
import type { Confinement } from "../confinement.ts";
import type { DriverEvent, TurnEndReason } from "./events.ts";
import type { SignInDefinition } from "./sign-in.ts";

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
  /** The CLI can be let edit files in its working directory under Botbench's rules (`allowEdits`). */
  edits: boolean;
  /**
   * Every shell command the CLI runs for an attempt runs inside the attempt's `confinement`, and the CLI refuses to start
   * rather than run one outside it. Only then may a command run without asking
   * (approvals/gate.ts). Left out, they are not known to.
   */
  confinedCommands?: boolean;
  /** False when the CLI is started with no tools at all and sees only what it is sent. Left out: it has tools. */
  tools?: boolean;
  /**
   * The CLI cannot ask Botbench before it acts, and in a chat it gets its own tools inside a sandbox Botbench draws
   * around it (`chatTools`): it reads, changes and runs commands in the chat's folder, and reads an attached repository
   * without changing it. Left out: in a chat it answers from the conversation alone, in a new empty folder.
   */
  chatTools?: boolean;
}

/** How the CLI is billed, taken from the CLI's own account of its login. */
export type BillingKind = "subscription" | "metered" | "unknown";

/** What a driver found out about its CLI on this machine, without reading any credential. */
export interface DriverProbe {
  installed: boolean;
  /** The version the CLI reports, or null when it is not installed or printed none. */
  version: string | null;
  /** This Botbench knows how to drive that version. */
  supported: boolean;
  signedIn: boolean;
  billing: BillingKind;
  /** One sentence for the owner when the CLI cannot be driven, else null. */
  problem: string | null;
}

/** One model the owner can choose. `id` is what the CLI takes; `label` is the CLI's own name for it, when it gives one. */
export interface ModelChoice {
  id: string;
  label?: string;
  /** The full model name `id` stands for, when the CLI says and it differs: the name a session then reports. */
  resolved?: string;
}

/** The models a driver offers, and where the list came from. Botbench never makes a list up. */
export interface DriverModels {
  /** "cli": the CLI itself reported the list. "config": it reported none, and the list is the owner's configuration. */
  source: "cli" | "config";
  models: ModelChoice[];
  /** The configured model, preselected for the owner. Null means the CLI's own default. */
  default: string | null;
  /** What the CLI says its own default is, in its words. Null when it does not say. */
  cliDefault: string | null;
}

export const MAX_MODEL_NAME = 100;
/** What a model name may be, in words. */
export const MODEL_NAME_RULE = `A model name starts with a letter or a digit, continues with letters, digits and . _ : / @ [ ] -, and is at most ${MAX_MODEL_NAME} characters long.`;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

/**
 * Why `value` cannot be used as a model name, or null when it can. A model name becomes an argument of the CLI,
 * so it must not be readable as a flag and holds no blank or control character. Whether the name is a model
 * that exists is not decided here: the CLI says so itself.
 */
export function modelNameProblem(value: unknown): string | null {
  if (typeof value === "string" && value.length <= MAX_MODEL_NAME && MODEL_NAME.test(value)) return null;
  return MODEL_NAME_RULE;
}

export interface StartAttemptOptions {
  /** The store the attempt row and its events are written to. */
  db: DatabaseSync;
  /** The directory the CLI works in. */
  cwd: string;
  /**
   * What the commands the attempt runs are kept from (U27): Botbench's data folder, apart from `cwd`, the owner's
   * secret places, every host but `allowedHosts`, and writes to `gitDir`. Required: no attempt runs unconfined.
   */
  confinement: Confinement;
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
   * The attempt changes nothing: the CLI is started without any tool that writes a file, and with `gate` every shell
   * command asks. For a role that only reads, in a worktree whose content comes from a repository, so the
   * repository's own CLI settings, rules and hooks are not loaded. Wins over `allowEdits`.
   */
  readOnly?: boolean;
  /**
   * Send this attempt's tool calls through the permission gate: the broker's socket and the secret that is this
   * attempt's alone. With it, what the CLI would ask a person arrives as `permission_request` events to be answered
   * with `respondToRequest`. Without it, everything the CLI would ask is denied.
   */
  gate?: { socketPath: string; secret: string };
  /**
   * A chat turn of a CLI with the `chatTools` capability: `cwd` is the chat's folder, which it may read, change and run
   * commands in, and `readable` the places it may read and never change (an attached repository and its git folder).
   * Its commands reach no network. Not with `readOnly`, `allowEdits` or `gate`.
   */
  chatTools?: { readable: readonly string[] };
  /**
   * The agent's own web search, which its provider runs on its own servers (Codex, Grok), as the owner's setting "Web
   * access in chat" allows it. It never gives the agent's commands a network. Off when left out.
   */
  webSearch?: boolean;
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
  /** The CLI's own sign-in and sign-out, run when the owner connects or disconnects the agent from Settings (U26). */
  readonly signIn?: SignInDefinition;
  probe(): Promise<DriverProbe>;
  /** The models the owner can choose from. Starts no turn. Never rejects: a CLI that reports nothing leaves the configured list. */
  models(): Promise<DriverModels>;
  /** Probe, then start the CLI. Rejects with `DriverUnavailableError` and starts nothing when the probe finds a problem. */
  startAttempt(options: StartAttemptOptions): Promise<DriverSession>;
}

/** The CLI cannot be driven right now: missing, an unsupported version, or signed out. */
export class DriverUnavailableError extends Error {
  readonly probe: DriverProbe;
  constructor(probe: DriverProbe) {
    super(probe.problem ?? "The agent cannot be used right now.");
    this.name = "DriverUnavailableError";
    this.probe = probe;
  }
}
