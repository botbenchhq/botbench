/**
 * The one event shape every driver emits, whatever its CLI's own protocol looks
 * like. A row in the `events` table is one of these: `type` goes in the type
 * column and the whole event, as JSON, in the payload column.
 */

/** Why a turn stopped. */
export type TurnEndReason = "completed" | "interrupted" | "error";

export type DriverEvent =
  /** What the person sent. Always the first event of a turn, recorded by the driver before the CLI sees it. */
  | { type: "user_prompt"; text: string }
  /** The CLI opened or resumed a session. `resumeCursor` continues it in a later attempt. */
  /** `keySource` is what the CLI says will pay for the turn: "none" means the signed-in login, anything else an API key. */
  | { type: "session_started"; resumeCursor: string; model: string | null; keySource: string | null }
  /** Text the model wrote for the person. */
  | { type: "text"; text: string }
  /** The model asked to run a tool. */
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /**
   * What a tool returned, matched to its call by `id`. `confined` is there when the output reports that the sandbox
   * kept the call from a file or from hosts (U27); it is read from the output, which the command also writes.
   */
  | { type: "tool_result"; id: string; output: string; isError: boolean; confined?: { hosts: string[]; files: boolean } }
  /**
   * The CLI refused a tool call: it needed an approval nobody gave, or a rule refused it. `id` is the call's; `reason` is
   * the CLI's own short account and `code` its name for the reason, such as "outside_reads_blocked", when it gives one.
   */
  | { type: "permission_denied"; id: string; name: string; reason: string | null; code: string | null }
  /**
   * The CLI is waiting for permission to run a tool call, and the turn stands still until `respondToRequest` answers `id`.
   * `reason` is the agent's own account of why, when the CLI passes one on.
   */
  | { type: "permission_request"; id: string; toolCallId: string; name: string; input: unknown; reason: string | null; /** The agent asks to run this outside its own sandbox (Codex's approval requests): the owner decides it every time. */ escalation?: true; /** The full path of the folder the agent says it runs this from, when it says (Codex's `cwd`). */ cwd?: string }
  /**
   * A permission request ended: the owner allowed or declined it (`note` is the owner's, for the agent), Botbench let it
   * run on the run's pre-approved list without asking the owner (`preapproved`) or on a standing permission the owner
   * gave earlier (`standing`), Botbench let a confined command run because of the run's mode (`mode`), Botbench let a
   * file tool run because it reads or changes a file inside the task's copy or reads the CLI's own saved output of this
   * session (`files`), Botbench let a web tool run because the owner's setting Web access is Allow (`web`), Botbench let a chat's confined command run that the floor does not name (`chat`), Botbench let one of the CLI's own bookkeeping tools run (`bookkeeping`), Botbench refused it without asking the owner (`denied`, `note` says why), or the CLI stopped
   * waiting (`cancelled`).
   */
  | { type: "permission_resolved"; id: string; toolCallId: string; decision: "allowed" | "preapproved" | "standing" | "mode" | "files" | "web" | "chat" | "bookkeeping" | "declined" | "denied" | "cancelled"; note: string | null }
  /** Tokens one turn used. No money: whether a turn costs dollars depends on the login, not on the CLI's printout. */
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  /** The CLI reported where the login stands against its limit. `limited` means the limit was hit. */
  | { type: "rate_limit"; limited: boolean; status: string; resetsAt: string | null }
  /**
   * The turn is over. Always the last event of a turn. `usageLimit` is there when the turn ended in error after the CLI
   * said, in that turn, that the login's usage limit was reached; `resetsAt` is the time it gave for the reset (ISO), or null.
   */
  | { type: "turn_ended"; reason: TurnEndReason; detail: string | null; usageLimit?: { resetsAt: string | null } }
  /** Something went wrong in the driver or the CLI. `raw` holds the offending output, shortened. */
  | { type: "error"; message: string; raw: string | null };

export type DriverEventType = DriverEvent["type"];

/** The answer to a `permission_request`, as `respondToRequest` takes it. Anything that is not an allow is a decline. */
export interface PermissionResponse {
  decision: "allow" | "decline";
  /** What the owner wrote for the agent when declining. */
  note?: string | null;
  /** Set when the owner was never asked: why the request was refused. The transcript then says so, and not that the owner declined. */
  refused?: string | null;
  /** True when an allow comes from the run's pre-approved list and the owner was not asked. The transcript then says so, and not that the owner allowed. */
  preapproved?: boolean;
  /** True when an allow comes from a standing permission and the owner was not asked this time. The transcript then says so, and not that the owner allowed. */
  standing?: boolean;
  /** True when an allow is for a confined command the floor does not name, in any mode, and the owner was not asked. */
  mode?: boolean;
  /** True when an allow is for a file tool inside the task's copy, or a read of the CLI's own saved output, and the owner was not asked. */
  files?: boolean;
  /** True when an allow is for a web tool, by the owner's setting Web access, and the owner was not asked this time. */
  web?: boolean;
  /** True when an allow is for one of the CLI's own planning and bookkeeping tools (its to-do list, loading a tool), which never asks. */
  bookkeeping?: boolean;
  /** True when an allow is for a chat's confined command that the floor does not name, and the owner was not asked. */
  chat?: boolean;
}
