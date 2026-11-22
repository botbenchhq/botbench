import { useMemo, type ReactNode } from "react";
import type { StoredEvent } from "../api/client.ts";

/** Add events to a list kept in id order, skipping any already there. */
export function mergeEvents(have: StoredEvent[], more: StoredEvent[]): StoredEvent[] {
  if (more.length === 0) return have;
  const byId = new Map(have.map((e) => [e.id, e]));
  for (const event of more) byId.set(event.id, event);
  return byId.size === have.length ? have : [...byId.values()].sort((a, b) => a.id - b.id);
}

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
const argumentWords = (input: unknown): string => shorten(JSON.stringify(input) ?? "", 160);
const callWords = (name: string, input: unknown): string => `${name} ${argumentWords(input)}`;

function endWords(reason: "completed" | "interrupted" | "error", detail: string | null): string {
  if (reason === "completed") return "Turn completed.";
  if (reason === "interrupted") return "Turn stopped before it finished.";
  return detail === null ? "Turn ended with an error." : `Turn ended with an error: ${detail}`;
}

/** What a row's look says about it. The label in words carries the kind; the look only repeats it. */
const LOOK = {
  agent: "gw-message",
  user: "gw-message gw-message--user",
  refused: "gw-message gw-message--denied",
  quiet: "gw-message gw-message--usage",
  end: "gw-message gw-message--turn-end",
} as const;

/** A row of the transcript: its kind in words, then what it says, one paragraph for each part. */
function Line({ kind, look, label, children }: { kind: string; look: keyof typeof LOOK; label: string; children: ReactNode }) {
  return (
    <li data-event={kind} className={LOOK[look]}>
      <span className="gw-message__label">{label}</span>
      {children}
    </li>
  );
}

const Body = ({ children }: { children: string }) => <p className="gw-message__body">{children}</p>;

/** Every piece of transcript text is rendered as a React child, so it is always text and never markup. */
function Row({ event, calls, preapproved }: { event: StoredEvent; calls: Map<string, string>; preapproved: Set<string> }) {
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
        <Line kind={e.type} look="quiet" label="Session">
          <Body>{e.model === null ? "started" : `started on ${e.model}`}</Body>
        </Line>
      );
    case "tool_call":
      return (
        <li data-event={e.type} className="gw-message gw-message--tool-call">
          <span className="gw-message__label">Tool call</span>
          <span className="gw-message__tool">{e.name}</span> <code className="gw-message__command">{argumentWords(e.input)}</code>
        </li>
      );
    case "permission_denied":
      return (
        <Line kind={e.type} look="refused" label="Denied">
          <Body>{`${calls.get(e.id) ?? e.name} was not run. It needed an approval, and this turn had no way to ask you for one.`}</Body>
        </Line>
      );
    case "permission_request":
      // A request Smelt answered itself, from the pre-approved list or a standing permission, never waited for the owner: its outcome row says what happened.
      if (preapproved.has(e.toolCallId)) return null;
      return (
        <Line kind={e.type} look="agent" label="Asked you">
          <Body>{`${calls.get(e.toolCallId) ?? e.name} needs your answer before it runs.`}</Body>
        </Line>
      );
    case "permission_resolved": {
      const what = calls.get(e.toolCallId) ?? "the request";
      const said = {
        allowed: `You allowed ${what}.`,
        preapproved: `${what} ran without asking you: it is on this task's pre-approved list.`,
        standing: `${what} ran without asking you: you gave it standing permission. Trust lists it, and takes it back.`,
        declined: `You declined ${what}. It was not run.`,
        denied: `Smelt denied ${what} without asking you. It was not run.`,
        cancelled: `The request for ${what} ended without an answer. It was not run.`,
      }[e.decision];
      const label = { allowed: "Allowed", preapproved: "Pre-approved", standing: "Standing permission", declined: "Declined", denied: "Denied by Smelt", cancelled: "Not answered" }[e.decision];
      const ran = e.decision === "allowed" || e.decision === "preapproved" || e.decision === "standing";
      return (
        <Line kind={e.type} look={ran ? "agent" : "refused"} label={label}>
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
        <Line kind={e.type} look="refused" label="Limit reached">
          <Body>{e.resetsAt === null ? "Claude Code's usage limit was reached." : `Claude Code's usage limit was reached. It resets at ${new Date(e.resetsAt).toLocaleString()}.`}</Body>
        </Line>
      );
    case "error":
      return (
        <Line kind={e.type} look="refused" label="Error">
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
  // A denial names the call it refused, so the row can say what was not run.
  const calls = useMemo(() => {
    const byId = new Map<string, string>();
    for (const { payload } of events) if (payload.type === "tool_call") byId.set(payload.id, callWords(payload.name, payload.input));
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
