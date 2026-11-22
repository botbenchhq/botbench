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
const callWords = (name: string, input: unknown): string => `${name} ${shorten(JSON.stringify(input) ?? "", 160)}`;

function endWords(reason: "completed" | "interrupted" | "error", detail: string | null): string {
  if (reason === "completed") return "Turn completed.";
  if (reason === "interrupted") return "Turn stopped before it finished.";
  return detail === null ? "Turn ended with an error." : `Turn ended with an error: ${detail}`;
}

/** A one-line row: a label in words, then what it says. */
function Line({ kind, label, children }: { kind: string; label: string; children?: ReactNode }) {
  return (
    <li data-event={kind} className="flex gap-sm break-words px-md text-muted">
      <span className="shrink-0 font-medium uppercase">{label}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** Every piece of transcript text is rendered as a React child, so it is always text and never markup. */
function Row({ event, calls }: { event: StoredEvent; calls: Map<string, string> }) {
  const e = event.payload;
  switch (e.type) {
    case "user_prompt":
      return (
        <li data-event={e.type} className="flex flex-col gap-xs rounded-sm bg-border p-md">
          <span className="font-medium uppercase">You</span>
          <span className="whitespace-pre-wrap break-words">{e.text}</span>
        </li>
      );
    case "text":
      return (
        <li data-event={e.type} className="flex flex-col gap-xs rounded-sm border p-md">
          <span className="font-medium uppercase text-muted">Claude Code</span>
          <span className="whitespace-pre-wrap break-words">{e.text}</span>
        </li>
      );
    case "session_started":
      return (
        <Line kind={e.type} label="Session">
          {e.model === null ? "started" : `started on ${e.model}`}
        </Line>
      );
    case "tool_call":
      return (
        <Line kind={e.type} label="Tool call">
          {callWords(e.name, e.input)}
        </Line>
      );
    case "permission_denied":
      return (
        <li data-event={e.type} className="flex flex-col gap-xs rounded-sm border border-accent p-md">
          <span className="font-medium uppercase">Denied</span>
          <span className="whitespace-pre-wrap break-words">{`${calls.get(e.id) ?? e.name} was not run. It needs an approval, and nothing can give one in this version.`}</span>
        </li>
      );
    case "tool_result":
      return (
        <Line kind={e.type} label={e.isError ? "Tool error" : "Tool result"}>
          {shorten(e.output, 240)}
        </Line>
      );
    case "usage":
      return (
        <Line kind={e.type} label="Tokens">
          {`${e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens} in, ${e.outputTokens} out`}
        </Line>
      );
    case "rate_limit":
      // Claude Code reports its limit on every turn; only reaching it is worth a row.
      if (!e.limited) return null;
      return (
        <Line kind={e.type} label="Limit reached">
          {e.resetsAt === null ? "Claude Code's usage limit was reached." : `Claude Code's usage limit was reached. It resets at ${new Date(e.resetsAt).toLocaleString()}.`}
        </Line>
      );
    case "error":
      return (
        <li data-event={e.type} className="flex flex-col gap-xs rounded-sm border border-accent p-md">
          <span className="font-medium uppercase">Error</span>
          <span className="whitespace-pre-wrap break-words">{e.message}</span>
        </li>
      );
    case "turn_ended":
      return (
        <Line kind={e.type} label="End">
          {endWords(e.reason, e.detail)}
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
  return (
    <ol role="log" aria-live="polite" className="flex flex-col gap-sm font-mono text-mono">
      {events.map((event) => (
        <Row key={event.id} event={event} calls={calls} />
      ))}
      {working !== null && (
        <li role="status" className="px-md text-muted">
          {working}
        </li>
      )}
    </ol>
  );
}
