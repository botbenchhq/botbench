import { useMemo, type ReactNode } from "react";
import type { StoredEvent } from "../api/client.ts";
import { Icon, type IconName } from "./icon.tsx";

/** Add events to a list kept in id order, skipping any already there. */
export function mergeEvents(have: StoredEvent[], more: StoredEvent[]): StoredEvent[] {
  if (more.length === 0) return have;
  const byId = new Map(have.map((e) => [e.id, e]));
  for (const event of more) byId.set(event.id, event);
  return byId.size === have.length ? have : [...byId.values()].sort((a, b) => a.id - b.id);
}

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A tool call as the transcript keeps it for the rows that speak of it later. */
interface Call {
  name: string;
  input: unknown;
}

/** The fields that say what a call was aimed at, in the order they are looked for: the command, then a file, then what was searched for. */
const TARGET_FIELDS = ["command", "file_path", "notebook_path", "pattern", "url", "query", "path"] as const;

/** What a call ran or was aimed at, taken from its own arguments: empty when none of them says. */
export function callTarget(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const fields = input as Record<string, unknown>;
  for (const field of TARGET_FIELDS) {
    const value = fields[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** The agent's own sentence about why it made a call, when its arguments carry one. */
function callReason(input: unknown): string | null {
  const description = typeof input === "object" && input !== null ? (input as Record<string, unknown>).description : undefined;
  return typeof description === "string" && description.trim() !== "" ? description.trim() : null;
}

function endWords(reason: "completed" | "interrupted" | "error", detail: string | null): string {
  if (reason === "completed") return "Turn completed.";
  if (reason === "interrupted") return "Turn stopped before it finished.";
  return detail === null ? "Turn ended with an error." : `Turn ended with an error: ${detail}`;
}

/** What a row's look says about it. The label in words carries the kind; the look only repeats it. */
const LOOK = {
  agent: "gw-message",
  user: "gw-message gw-message--user",
  session: "gw-message gw-message--session-start",
  asked: "gw-message gw-message--question",
  decision: "gw-message gw-message--decision",
  refused: "gw-message gw-message--denied",
  failed: "gw-message gw-message--error",
  quiet: "gw-message gw-message--usage",
  end: "gw-message gw-message--turn-end",
} as const;

/** A row of the transcript: its kind in words, then what it says, one paragraph for each part. `icon` repeats the label of an answered request. */
function Line({ kind, look, label, icon, children }: { kind: string; look: keyof typeof LOOK; label: string; icon?: IconName; children: ReactNode }) {
  return (
    <li data-event={kind} className={LOOK[look]}>
      <span className="gw-message__label">
        {icon !== undefined && <Icon name={icon} className="gw-message__icon" />}
        {label}
      </span>
      {children}
    </li>
  );
}

const Body = ({ children }: { children: string }) => <p className="gw-message__body">{children}</p>;

/** The tool a row speaks of and, in mono, what it ran or was aimed at. */
function What({ call, fallback }: { call: Call | undefined; fallback: string }) {
  const target = call === undefined ? "" : callTarget(call.input);
  return (
    <>
      <span className="gw-message__tool">{call?.name ?? fallback}</span>
      {target !== "" && (
        <>
          {" "}
          <code className="gw-message__command">{target}</code>
        </>
      )}
    </>
  );
}

/** Every piece of transcript text is rendered as a React child, so it is always text and never markup. */
function Row({ event, calls, preapproved }: { event: StoredEvent; calls: Map<string, Call>; preapproved: Set<string> }) {
  const e = event.payload;
  switch (e.type) {
    case "user_prompt":
      return (
        <Line kind={e.type} look="user" label="You">
          <Body>{e.text}</Body>
        </Line>
      );
    case "text":
      return (
        <Line kind={e.type} look="agent" label="Claude Code">
          <Body>{e.text}</Body>
        </Line>
      );
    case "session_started":
      return (
        <Line kind={e.type} look="session" label="Session">
          <Body>{e.model === null ? "started" : `started on ${e.model}`}</Body>
        </Line>
      );
    case "tool_call": {
      const reason = callReason(e.input);
      return (
        <li data-event={e.type} className="gw-message gw-message--tool-call">
          <span className="gw-message__label">Tool call</span>
          <What call={e} fallback={e.name} />
          {reason !== null && <Body>{reason}</Body>}
          <details className="gw-message__details">
            <summary className="gw-message__summary">Show the full arguments</summary>
            <pre className="gw-message__code">{JSON.stringify(e.input, null, 2) ?? ""}</pre>
          </details>
        </li>
      );
    }
    case "permission_denied":
      return (
        <Line kind={e.type} look="refused" label="Denied">
          <What call={calls.get(e.id)} fallback={e.name} />
          <Body>It was not run. It needed an approval, and this turn had no way to ask you for one.</Body>
        </Line>
      );
    case "permission_request":
      // A request Smelt answered itself, from the pre-approved list or a standing permission, never waited for the owner: its outcome row says what happened.
      if (preapproved.has(e.toolCallId)) return null;
      return (
        <Line kind={e.type} look="asked" label="Asked you">
          <What call={calls.get(e.toolCallId)} fallback={e.name} />
          <Body>It needs your answer before it runs.</Body>
        </Line>
      );
    case "permission_resolved": {
      const said = {
        allowed: "You allowed it.",
        preapproved: "It ran without asking you: it is on this task's pre-approved list.",
        standing: "It ran without asking you: you gave it standing permission. Trust lists it, and takes it back.",
        declined: "You declined it. It was not run.",
        denied: "Smelt denied it without asking you. It was not run.",
        cancelled: "The request ended without an answer. It was not run.",
      }[e.decision];
      const label = { allowed: "Allowed", preapproved: "Pre-approved", standing: "Standing permission", declined: "Declined", denied: "Denied by Smelt", cancelled: "Not answered" }[e.decision];
      // The owner's own answers and the two standing rules are decisions; a refusal by Smelt and a request nobody answered are not.
      const icon = ({ allowed: "check", declined: "x", preapproved: "circle-check", standing: "circle-check" } as const)[e.decision as "allowed" | "declined" | "preapproved" | "standing"];
      return (
        <Line kind={e.type} look={icon === undefined ? "refused" : "decision"} label={label} icon={icon}>
          <What call={calls.get(e.toolCallId)} fallback="The request" />
          <Body>{said}</Body>
          {e.note !== null && <Body>{e.decision === "denied" ? `Why: ${e.note}` : `Your note: ${e.note}`}</Body>}
        </Line>
      );
    }
    case "tool_result":
      return (
        <li data-event={e.type} className="gw-message gw-message--tool-result">
          <span className="gw-message__label">{e.isError ? "Tool error" : "Tool result"}</span>
          <pre className="gw-message__code">{shorten(e.output, 240)}</pre>
        </li>
      );
    case "usage":
      return (
        <Line kind={e.type} look="quiet" label="Tokens">
          <Body>{`${e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens} in, ${e.outputTokens} out`}</Body>
        </Line>
      );
    case "rate_limit":
      // Claude Code reports its limit on every turn; only reaching it is worth a row.
      if (!e.limited) return null;
      return (
        <Line kind={e.type} look="failed" label="Limit reached">
          <Body>{e.resetsAt === null ? "Claude Code's usage limit was reached." : `Claude Code's usage limit was reached. It resets at ${new Date(e.resetsAt).toLocaleString()}.`}</Body>
        </Line>
      );
    case "error":
      return (
        <Line kind={e.type} look="failed" label="Error">
          <Body>{e.message}</Body>
        </Line>
      );
    case "turn_ended":
      return (
        <Line kind={e.type} look="end" label="End">
          <Body>{endWords(e.reason, e.detail)}</Body>
        </Line>
      );
    default:
      return null;
  }
}

/** The transcript of one or more attempts, oldest first. `working` is a note shown last while something is still running. */
export function Transcript({ events, working }: { events: StoredEvent[]; working: string | null }) {
  // A request, its answer and a denial each name the call they are about, so the row can say what was or was not run.
  const calls = useMemo(() => {
    const byId = new Map<string, Call>();
    for (const { payload } of events) if (payload.type === "tool_call") byId.set(payload.id, payload);
    return byId;
  }, [events]);
  const preapproved = useMemo(() => new Set(events.flatMap(({ payload }) => (payload.type === "permission_resolved" && (payload.decision === "preapproved" || payload.decision === "standing") ? [payload.toolCallId] : []))), [events]);
  return (
    <ol role="log" aria-live="polite" aria-label="Transcript" className="gw-stack gw-gap-sm">
      {events.map((event) => (
        <Row key={event.id} event={event} calls={calls} preapproved={preapproved} />
      ))}
      {working !== null && (
        <li className="gw-streaming gw-streaming--row">
          <span role="status">{working}</span>
        </li>
      )}
    </ol>
  );
}
