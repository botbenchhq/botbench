import { useMemo, type ReactNode } from "react";
import type { DriverEvent, StoredEvent } from "../api/client.ts";
import { DiffLine } from "./diff.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { callLine, callReason, callTarget, duration, editChange, writtenText, type CallState } from "./tool-summary.ts";

/** Add events to a list kept in id order, skipping any already there. */
export function mergeEvents(have: StoredEvent[], more: StoredEvent[]): StoredEvent[] {
  if (more.length === 0) return have;
  const byId = new Map(have.map((e) => [e.id, e]));
  for (const event of more) byId.set(event.id, event);
  return byId.size === have.length ? have : [...byId.values()].sort((a, b) => a.id - b.id);
}

type Of<T extends DriverEvent["type"]> = Extract<DriverEvent, { type: T }>;

/** How much of a tool's output or of a written file is shown before it is cut, with a line saying how much is left out. */
const MAX_SHOWN = 2000;

/** What the transcript knows about its events as a whole, so that a row can say what became of the call it is about. */
interface Story {
  /** Whether something is still running. When nothing is, a call with no result is not going to get one. */
  live: boolean;
  calls: Map<string, Of<"tool_call">>;
  results: Map<string, Of<"tool_result">>;
  /** The calls a request to the owner was made for. */
  asked: Set<string>;
  /** How each request ended, by its call. */
  answers: Map<string, Of<"permission_resolved">["decision"]>;
  /** The calls refused with nobody to ask. */
  refused: Set<string>;
  /** The exchanges that have ended, as "attempt:exchange". */
  ended: Set<string>;
  /** When each exchange began, and the tokens the agent reported for it. */
  exchanges: Map<string, { from: string; tokensIn: number; tokensOut: number; counted: boolean }>;
}

const exchangeOf = (event: StoredEvent): string => `${event.attemptId}:${event.turn}`;

function readStory(events: readonly StoredEvent[], live: boolean): Story {
  const story: Story = { live, calls: new Map(), results: new Map(), asked: new Set(), answers: new Map(), refused: new Set(), ended: new Set(), exchanges: new Map() };
  for (const event of events) {
    const e = event.payload;
    const key = exchangeOf(event);
    if (!story.exchanges.has(key)) story.exchanges.set(key, { from: event.ts, tokensIn: 0, tokensOut: 0, counted: false });
    if (e.type === "tool_call") story.calls.set(e.id, e);
    else if (e.type === "tool_result") story.results.set(e.id, e);
    else if (e.type === "permission_request") story.asked.add(e.toolCallId);
    else if (e.type === "permission_resolved") story.answers.set(e.toolCallId, e.decision);
    else if (e.type === "permission_denied") story.refused.add(e.id);
    else if (e.type === "turn_ended") story.ended.add(key);
    else if (e.type === "usage") {
      const exchange = story.exchanges.get(key)!;
      exchange.tokensIn += e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      exchange.tokensOut += e.outputTokens;
      exchange.counted = true;
    }
  }
  return story;
}

/** What became of a call, from the events stored about it and nothing else. */
function stateOf(story: Story, id: string, exchange: string): CallState {
  const answer = story.answers.get(id);
  if (story.refused.has(id) || answer === "declined" || answer === "denied" || answer === "cancelled") return "refused";
  const result = story.results.get(id);
  if (result !== undefined) return result.isError ? "failed" : "done";
  if (story.ended.has(exchange) || !story.live) return "unfinished";
  return story.asked.has(id) && answer === undefined ? "waiting" : "running";
}

/** What a row's look says about it. The label in words carries the kind; the look only repeats it. */
const LOOK = {
  agent: "gw-message",
  user: "gw-message gw-message--user",
  asked: "gw-message gw-message--question",
  decision: "gw-message gw-message--decision",
  refused: "gw-message gw-message--denied",
  failed: "gw-message gw-message--error",
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

const Body = ({ children }: { children: ReactNode }) => <p className="gw-message__body">{children}</p>;
/** Text somebody else wrote (a person, the agent, a program): always text, never markup, and marked as theirs. */
const Theirs = ({ children }: { children: string }) => <span data-gw-content="">{children}</span>;
const Code = ({ children }: { children: string }) => (
  <pre data-gw-content="" className="gw-message__code">
    {children}
  </pre>
);

/** A long text, shown up to a limit, with a line that says how much more there is. */
function Cut({ text, what }: { text: string; what: string }) {
  if (text.length <= MAX_SHOWN) return <Code>{text}</Code>;
  return (
    <>
      <Code>{text.slice(0, MAX_SHOWN)}</Code>
      <Body>{`${what} is cut here: ${text.length - MAX_SHOWN} more characters are not shown.`}</Body>
    </>
  );
}

/** The tool a row speaks of and, in mono, what it ran or was aimed at, whole. */
function What({ call, fallback }: { call: Of<"tool_call"> | undefined; fallback: string }) {
  const target = call === undefined ? "" : callTarget(call.input);
  const name = call?.name ?? fallback;
  // A shell command is said by the command alone; anything else by the tool's own name and what it was aimed at.
  return (
    <>
      {(name !== "Bash" || target === "") && (
        <span data-gw-content="" className="gw-message__tool">
          {name}
        </span>
      )}{" "}
      {target !== "" && (
        <code data-gw-content="" className="gw-message__command">
          {target}
        </code>
      )}
    </>
  );
}

/**
 * One action of the agent, as one line: a plain verb and the real object. Behind the line, one tap away: the whole
 * command or path, the agent's own reason, the change or the text written, and the output. One level deeper: the
 * tool's own name and its raw arguments. A call that failed or that waits for an answer is open without a tap.
 */
function Action({ call, state, result, folded }: { call: Of<"tool_call">; state: CallState; result: Of<"tool_result"> | undefined; folded: boolean }) {
  const technical = (
    <>
      <Body>
        {"Tool: "}
        <Theirs>{call.name}</Theirs>
      </Body>
      <Code>{JSON.stringify(call.input, null, 2) ?? ""}</Code>
    </>
  );
  const line = callLine(call.name, call.input, state);
  const reason = callReason(call.input);
  const change = editChange(call.name, call.input);
  const written = writtenText(call.name, call.input);
  return (
    <li data-event="tool_call" data-state={state} className="gw-message gw-message--tool-call">
      <details open={state === "failed" || state === "waiting"} className="gw-message__details">
        <summary className="gw-message__summary">
          {line.verb === null ? (
            <span data-gw-content="" className="gw-message__label">
              {line.tool}
            </span>
          ) : (
            <span className="gw-message__label">{line.verb}</span>
          )}{" "}
          {line.object !== "" && (
            <code data-gw-content="" className="gw-message__command">
              {line.object}
            </code>
          )}
          {change !== null && state === "done" && <span className="gw-message__tool">{` +${change.added} −${change.removed}`}</span>}
          {written !== null && state === "done" && <span className="gw-message__tool">{` ${written.lines} ${written.lines === 1 ? "line" : "lines"}`}</span>}
          {line.note !== "" && <span className="gw-message__tool">{` · ${line.note}`}</span>}
        </summary>
        {reason !== null && (
          <Body>
            {"Claude Code's description: "}
            <Theirs>{reason}</Theirs>
          </Body>
        )}
        {line.whole !== "" && <Code>{line.whole}</Code>}
        {change !== null && <Body>{state === "done" ? "The change it made" : "The change it asked for"}</Body>}
        {change !== null && (
          <figure className="gw-diff">
            <pre tabIndex={0} role="group" data-gw-content-label="" aria-label={`The change to ${line.object}`} className="gw-diff__body">
              <code data-gw-content="" className="gw-diff__lines">
                {change.lines.map((changed, i) => (
                  <DiffLine key={i} line={changed} plain />
                ))}
              </code>
            </pre>
          </figure>
        )}
        {written !== null && <Body>{state === "done" ? "The text it wrote" : "The text it asked to write"}</Body>}
        {written !== null && <Cut text={written.text} what="The text" />}
        {result !== undefined && (
          <div data-event="tool_result" className="gw-stack gw-gap-xs">
            {/* What came back from a call that was not run is what the agent was told, not output of the command. */}
            <Body>{state === "refused" ? "What Claude Code was told" : result.isError ? "Error output" : "Output"}</Body>
            {result.output === "" ? <Body>Nothing was printed.</Body> : <Cut text={result.output} what="The output" />}
          </div>
        )}
        {folded ? (
          // The whole transcript is already behind a tap of its own: the raw arguments follow the rest, under their own words, with no third fold.
          <>
            <Body>Technical details</Body>
            {technical}
          </>
        ) : (
          <details className="gw-message__details">
            <summary className="gw-message__summary">Technical details</summary>
            {technical}
          </details>
        )}
      </details>
    </li>
  );
}

/** Every piece of transcript text is rendered as a React child, so it is always text and never markup. */
function Row({ event, story, modelName, promptBy, folded }: { event: StoredEvent; story: Story; modelName: (id: string) => string; promptBy: string; folded: boolean }) {
  const e = event.payload;
  switch (e.type) {
    case "user_prompt":
      return (
        <Line kind={e.type} look="user" label={promptBy}>
          <Body>
            <Theirs>{e.text}</Theirs>
          </Body>
        </Line>
      );
    case "text":
      return (
        <Line kind={e.type} look="agent" label="Claude Code">
          <Body>
            <Theirs>{e.text}</Theirs>
          </Body>
        </Line>
      );
    case "session_started":
      // Which model answers, by the name Claude Code gives it; the exact id is one tap away. A session that names no model gets no row.
      if (e.model === null) return null;
      return (
        <li data-event={e.type} className="gw-message gw-message--session-start">
          <details className="gw-message__details">
            <summary className="gw-message__summary">
              <span className="gw-message__label">Model</span>
              <Theirs>{modelName(e.model)}</Theirs>
            </summary>
            <Body>
              {"Model id: "}
              <Theirs>{e.model}</Theirs>
            </Body>
          </details>
        </li>
      );
    case "tool_call":
      return <Action call={e} state={stateOf(story, e.id, exchangeOf(event))} result={story.results.get(e.id)} folded={folded} />;
    case "tool_result":
      // A result is shown with the call it answers. One whose call is not in this transcript stands alone.
      if (story.calls.has(e.id)) return null;
      return (
        <li data-event={e.type} className="gw-message gw-message--tool-result">
          <span className="gw-message__label">{e.isError ? "Error output" : "Output"}</span>
          <Cut text={e.output} what="The output" />
        </li>
      );
    case "permission_denied":
      return (
        <Line kind={e.type} look="refused" label="Denied">
          <What call={story.calls.get(e.id)} fallback={e.name} />
          <Body>It was not run. It needed your approval, and there was no way to ask you here.</Body>
        </Line>
      );
    case "permission_request": {
      // A request Botbench answered itself, because the command was allowed in advance, never waited for the owner: its outcome row says what happened.
      const answer = story.answers.get(e.toolCallId);
      // Nor did one Botbench refused by itself.
      if (answer === "preapproved" || answer === "standing" || answer === "denied") return null;
      return (
        <Line kind={e.type} look="asked" label="Asked you">
          <What call={story.calls.get(e.toolCallId)} fallback={e.name} />
          <Body>{answer === undefined ? "It needs your answer before it runs." : "Botbench asked you first."}</Body>
        </Line>
      );
    }
    case "permission_resolved": {
      const said = {
        allowed: "You allowed it once.",
        preapproved: "It was allowed without asking you: you listed this command when you started the task.",
        standing: "It was allowed without asking you: you chose Always allow for this command. Permissions lists it, and you can take it back there.",
        declined: "You denied it. It was not run.",
        denied: "Botbench denied it without asking you. It was not run.",
        cancelled: "The request ended without an answer. It was not run.",
      }[e.decision];
      const label = { allowed: "Allowed", preapproved: "Allowed for this task", standing: "Always allowed", declined: "Denied", denied: "Denied by Botbench", cancelled: "Not answered" }[e.decision];
      // The owner's own answers and the two standing rules are decisions; a refusal by Botbench and a request nobody answered are not.
      const icon = ({ allowed: "check", declined: "x", preapproved: "circle-check", standing: "circle-check" } as const)[e.decision as "allowed" | "declined" | "preapproved" | "standing"];
      return (
        <Line kind={e.type} look={icon === undefined ? "refused" : "decision"} label={label} icon={icon}>
          <What call={story.calls.get(e.toolCallId)} fallback="The request" />
          <Body>{said}</Body>
          {e.note !== null && (
            <Body>
              {/* A reason Botbench gives is Botbench's own sentence; a note is the owner's. */}
              {e.decision === "denied" ? `Why: ${e.note}` : "Your note: "}
              {e.decision !== "denied" && <Theirs>{e.note}</Theirs>}
            </Body>
          )}
        </Line>
      );
    }
    case "usage":
      // Token counts are under the row that ends the reply they belong to.
      return null;
    case "rate_limit":
      // Claude Code reports its limit with every reply; only reaching it is worth a row.
      if (!e.limited) return null;
      return (
        <Line kind={e.type} look="failed" label="Usage limit">
          <Body>{e.resetsAt === null ? "Claude Code's usage limit was reached." : `Claude Code's usage limit was reached. It resets at ${new Date(e.resetsAt).toLocaleString()}.`}</Body>
        </Line>
      );
    case "error":
      return (
        <Line kind={e.type} look="failed" label="Error">
          <Body>
            <Theirs>{e.message}</Theirs>
          </Body>
        </Line>
      );
    case "turn_ended": {
      const exchange = story.exchanges.get(exchangeOf(event));
      const tokens = exchange?.counted === true && (
        <p data-event="usage" className="gw-message__body">{`Tokens: ${exchange.tokensIn} in, ${exchange.tokensOut} out`}</p>
      );
      if (e.reason === "completed") {
        // A reply that finished needs no line saying so. What is known from stored times and counts sits here, quietly.
        const took = exchange === undefined ? null : duration(exchange.from, event.ts);
        if (took === null && tokens === false) return null;
        return (
          <li data-event={e.type} className={LOOK.end}>
            <details className="gw-message__details">
              <summary className="gw-message__summary">
                <span className="gw-message__label">{took === null ? "Usage" : `Worked for ${took}`}</span>
              </summary>
              {tokens === false ? <Body>Claude Code reported no token counts for this reply.</Body> : tokens}
            </details>
          </li>
        );
      }
      return (
        <Line kind={e.type} look="end" label={e.reason === "interrupted" ? "Stopped" : "Error"}>
          <Body>
            {e.reason === "interrupted" ? "Stopped before it finished." : e.detail === null ? "Ended with an error." : "Ended with an error: "}
            {e.reason === "error" && e.detail !== null && <Theirs>{e.detail}</Theirs>}
          </Body>
          {tokens !== false && (
            <details className="gw-message__details">
              <summary className="gw-message__summary">Usage</summary>
              {tokens}
            </details>
          )}
        </Line>
      );
    }
    default:
      return null;
  }
}

/**
 * The transcript of one or more attempts, oldest first. `working` is a note shown last while something is still
 * running. `modelName` gives the name Claude Code has for a model id, or the id itself when it has none. `promptBy`
 * says who wrote the prompts (the owner, unless Botbench wrote them, as it does for planning). `folded` is for a
 * transcript that sits behind a disclosure of its own, so its rows fold one level and not two.
 */
export function Transcript({ events, working, modelName, promptBy = "You", folded = false }: { events: StoredEvent[]; working: string | null; modelName: (id: string) => string; promptBy?: string; folded?: boolean }) {
  const story = useMemo(() => readStory(events, working !== null), [events, working]);
  return (
    <ol role="log" aria-live="polite" aria-label="Transcript" className="gw-stack gw-gap-sm">
      {events.map((event) => (
        <Row key={event.id} event={event} story={story} modelName={modelName} promptBy={promptBy} folded={folded} />
      ))}
      {working !== null && (
        <li className="gw-streaming gw-streaming--row">
          <span role="status">{working}</span>
        </li>
      )}
    </ol>
  );
}
