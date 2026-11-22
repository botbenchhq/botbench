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
  /** What a tool returned, matched to its call by `id`. */
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  /** Tokens one turn used. No money: whether a turn costs dollars depends on the login, not on the CLI's printout. */
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  /** The CLI reported where the login stands against its limit. `limited` means the limit was hit. */
  | { type: "rate_limit"; limited: boolean; status: string; resetsAt: string | null }
  /** The turn is over. Always the last event of a turn. */
  | { type: "turn_ended"; reason: TurnEndReason; detail: string | null }
  /** Something went wrong in the driver or the CLI. `raw` holds the offending output, shortened. */
  | { type: "error"; message: string; raw: string | null };

export type DriverEventType = DriverEvent["type"];
