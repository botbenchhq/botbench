import { createContext, Fragment, useCallback, useContext, useId, useMemo, useState, type ReactNode } from "react";
import type { DriverEvent, StoredEvent } from "../api/client.ts";
import { DiffLine } from "./diff.tsx";
import { duration as took } from "./evidence.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { callLine, callReason, callTarget, confinedWords, duration, editChange, stepsSummary, writtenText, type CallState } from "./tool-summary.ts";

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
  /** When each call and each result was stored, by the call's id: the only times a call's duration is taken from. */
  calledAt: Map<string, string>;
  returnedAt: Map<string, string>;
  /** The calls a request to the owner was made for. */
  asked: Set<string>;
  /** How each request ended, by its call. */
  answers: Map<string, Of<"permission_resolved">["decision"]>;
  /** The calls refused with nobody to ask. */
  refused: Set<string>;
  /** The calls Claude Code's rule on reads refused, outside the folder the agent works in (U27). */
  outside: Set<string>;
  /** The exchanges that have ended, as "attempt:exchange". */
  ended: Set<string>;
  /** When each exchange began, and the tokens the agent reported for it. */
  exchanges: Map<string, { from: string; tokensIn: number; tokensOut: number; counted: boolean }>;
}

const exchangeOf = (event: StoredEvent): string => `${event.attemptId}:${event.turn}`;

function readStory(events: readonly StoredEvent[], live: boolean): Story {
  const story: Story = { live, calls: new Map(), results: new Map(), calledAt: new Map(), returnedAt: new Map(), asked: new Set(), answers: new Map(), refused: new Set(), outside: new Set(), ended: new Set(), exchanges: new Map() };
  for (const event of events) {
    const e = event.payload;
    const key = exchangeOf(event);
    if (!story.exchanges.has(key)) story.exchanges.set(key, { from: event.ts, tokensIn: 0, tokensOut: 0, counted: false });
    if (e.type === "tool_call") (story.calls.set(e.id, e), story.calledAt.set(e.id, event.ts));
    else if (e.type === "tool_result") (story.results.set(e.id, e), story.returnedAt.set(e.id, event.ts));
    else if (e.type === "permission_request") story.asked.add(e.toolCallId);
    else if (e.type === "permission_resolved") story.answers.set(e.toolCallId, e.decision);
    else if (e.type === "permission_denied") {
      story.refused.add(e.id);
      if (e.code === "outside_reads_blocked") story.outside.add(e.id);
    }
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
  agent: "ds-message",
  user: "ds-message ds-message--user",
  asked: "ds-message ds-message--question",
  decision: "ds-message ds-message--decision",
  refused: "ds-message ds-message--denied",
  failed: "ds-message ds-message--error",
  end: "ds-message ds-message--turn-end",
} as const;

/** A row of the transcript: its kind in words, then what it says, one paragraph for each part. `icon` repeats the label of an answered request. */
function Line({ kind, look, label, icon, state, children }: { kind: string; look: keyof typeof LOOK; label: string; icon?: IconName; state?: "done"; children: ReactNode }) {
  return (
    <li data-event={kind} data-state={state} className={LOOK[look]}>
      <span className="ds-message__label">
        {icon !== undefined && <Icon name={icon} className="ds-message__icon" />}
        {label}
      </span>
      {children}
    </li>
  );
}

const Body = ({ children }: { children: ReactNode }) => <p className="ds-message__body">{children}</p>;
/** Text somebody else wrote (a person, the agent, a program): always text, never markup, and marked as theirs. */
const Theirs = ({ children }: { children: string }) => <span data-ds-content="">{children}</span>;
const Code = ({ children }: { children: string }) => (
  <pre data-ds-content="" className="ds-message__code">
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
        <span data-ds-content="" className="ds-message__tool">
          {name}
        </span>
      )}{" "}
      {target !== "" && (
        <code data-ds-content="" className="ds-message__command">
          {target}
        </code>
      )}
    </>
  );
}

/** Why Claude Code's rule on reads refused a call (U27). */
const OUTSIDE = "It was not run. The agent may read only the folder it works in.";

/** How the design system's tool call draws each state of a call, the state in words, and why it did not run or end well. */
interface Shown {
  state: "awaiting-approval" | "running" | "succeeded" | "failed" | "declined" | "cancelled";
  word: string;
  note: string | null;
}

/** What the row of a call shows of its state, from the events stored about it. The words follow the status set and the voice guide. */
function shownOf(story: Story, id: string, state: CallState): Shown {
  switch (state) {
    case "waiting":
      return { state: "awaiting-approval", word: "Needs input", note: null };
    case "running":
      return { state: "running", word: "Working", note: null };
    case "done":
      return { state: "succeeded", word: "Done", note: null };
    case "failed":
      return { state: "failed", word: "Failed", note: "It returned an error." };
    case "unfinished":
      // It may have run: nothing says it did not. It ended without a result, which is drawn as a failure, open.
      return { state: "failed", word: "Did not finish", note: "No result was recorded for it." };
    case "refused": {
      const answer = story.answers.get(id);
      if (answer === "cancelled") return { state: "cancelled", word: "Not answered", note: "The request ended without an answer. It was not run." };
      if (answer === "declined") return { state: "declined", word: "Denied", note: "You denied it. It was not run." };
      if (answer === "denied") return { state: "declined", word: "Denied", note: "Botbench denied it without asking you. It was not run." };
      if (story.outside.has(id)) return { state: "declined", word: "Denied", note: OUTSIDE };
      return { state: "declined", word: "Denied", note: "It needed your approval, and there was no way to ask you here." };
    }
  }
}

/**
 * Which calls the reader has opened or closed, by call id, kept by the transcript: a row keeps the reader's choice when
 * it moves into a step group as more calls arrive, and a row nobody touched opens and closes by its state.
 */
const Opened = createContext<{ opened: ReadonlyMap<string, boolean>; set: (id: string, open: boolean) => void }>({ opened: new Map(), set: () => {} });

/** How many of a long output's lines are shown at first: its last ones, as the design system's tool call shows them. */
const LAST_LINES = 12;

/** What a call returned, under a label that says what it is and how long: a long output shows its last lines, and all of them one press away. */
function Returned({ text, label }: { text: string; label: string }) {
  const [all, setAll] = useState(false);
  const labelId = useId();
  const lines = text.replace(/\n$/, "").split("\n");
  if (text === "")
    return (
      <>
        <p className="ds-tool-call__label">{label}</p>
        <p>Nothing was printed.</p>
      </>
    );
  if (lines.length <= LAST_LINES)
    return (
      <>
        <p className="ds-tool-call__label">{`${label}, ${lines.length} ${lines.length === 1 ? "line" : "lines"}`}</p>
        <Cut text={text} what="The output" />
      </>
    );
  return (
    <>
      <p id={labelId} className="ds-tool-call__label">
        {all ? `${label}, ${lines.length} lines` : `${label}, last ${LAST_LINES} of ${lines.length} lines`}
      </p>
      <div className="ds-tool-call__output" role="region" aria-labelledby={labelId} tabIndex={0}>
        {all ? (
          <Cut text={text} what="The output" />
        ) : (
          <pre data-ds-content="" className="ds-tool-call__code">
            {lines.slice(-LAST_LINES).join("\n")}
          </pre>
        )}
      </div>
      {!all && (
        <button type="button" onClick={() => setAll(true)} className="ds-button ds-button--quiet ds-show-more__all">
          {`Show all ${lines.length} lines`}
        </button>
      )}
    </>
  );
}

/**
 * One action of the agent, as the design system's tool call in a transcript row: its state in words (and the icon and
 * tone the stylesheet draws from it), then one plain line, a plain verb and the real object, and how long it took,
 * from the stored times of the call and its result. Behind the line, one tap away: the whole command or path, the
 * agent's own reason, the change or the text written, and the output. One level deeper: the tool's own name and its
 * raw arguments. A call that failed or that waits for an answer is open without a tap. `folded` is for a call whose row
 * already sits one level down (in a step group, or in a transcript behind a disclosure of its own): its raw arguments
 * then follow the rest, under their own words, with no further fold.
 */
function Action({ call, story, state, folded }: { call: Of<"tool_call">; story: Story; state: CallState; folded: boolean }) {
  const technical = (
    <>
      <p>
        {"Tool: "}
        <Theirs>{call.name}</Theirs>
      </p>
      <pre data-ds-content="" className="ds-tool-call__code">
        {JSON.stringify(call.input, null, 2) ?? ""}
      </pre>
    </>
  );
  const result = story.results.get(call.id);
  // What the sandbox kept a call that ran from, as its result reports it (U27): a failed row, open, its note in plain words.
  const kept = state === "done" || state === "failed" ? confinedWords(result?.confined) : null;
  const shown: Shown = kept === null ? shownOf(story, call.id, state) : { state: "failed", word: "Failed", note: `${kept.note[0]!.toUpperCase()}${kept.note.slice(1)}. ${kept.sentences.join(" ")}` };
  const line = callLine(call.name, call.input, state);
  const reason = callReason(call.input);
  const change = editChange(call.name, call.input);
  const written = writtenText(call.name, call.input);
  const calledAt = story.calledAt.get(call.id);
  const returnedAt = story.returnedAt.get(call.id);
  const ms = calledAt === undefined || returnedAt === undefined ? NaN : Date.parse(returnedAt) - Date.parse(calledAt);
  // Under a second in milliseconds, as the design system writes it ("38 ms"), so a quick call does not read "0 s".
  const time = !Number.isFinite(ms) || ms < 0 ? null : ms < 1000 ? { words: `${ms} ms`, iso: `PT${ms / 1000}S` } : took(ms);
  const { opened, set } = useContext(Opened);
  // Open without a tap: a call that failed, one that ended without a result, and one that waits for an answer.
  const open = opened.get(call.id) ?? (state === "failed" || state === "unfinished" || state === "waiting" || kept !== null);
  // While a command runs, the state says Working and the line is the command alone, as the design system has it.
  const verb = state === "running" && call.name === "Bash" && line.verb !== null ? null : line.verb;
  return (
    <li data-event="tool_call" className="ds-message ds-message--tool-call">
      <div data-state={shown.state} className="ds-tool-call ds-tool-call--row">
        <details open={open} onToggle={(e) => e.currentTarget.open !== open && set(call.id, e.currentTarget.open)} className="ds-tool-call__details">
          <summary className="ds-tool-call__summary">
            <span className="ds-tool-call__title">
              <span className="ds-tool-call__status">{shown.word}</span>{" "}
              {verb !== null ? `${verb} ` : line.verb === null ? (
                <>
                  <Theirs>{line.tool}</Theirs>{" "}
                </>
              ) : null}
              {line.object !== "" && (
                <code data-ds-content="" className="ds-tool-call__target">
                  {line.object}
                </code>
              )}
              {change !== null && state === "done" && ` +${change.added} −${change.removed}`}
              {written !== null && state === "done" && ` ${written.lines} ${written.lines === 1 ? "line" : "lines"}`}
            </span>
            {time !== null && (
              <span className="ds-tool-call__duration">
                <time dateTime={time.iso}>{time.words}</time>
              </span>
            )}
            {shown.note !== null && (
              <span data-testid={kept === null ? undefined : "confined"} className="ds-tool-call__note">
                {shown.note}
              </span>
            )}
          </summary>
          <div className="ds-tool-call__body">
            {reason !== null && (
              <p>
                {"Claude Code's description: "}
                <Theirs>{reason}</Theirs>
              </p>
            )}
            {line.whole !== "" && (
              <pre data-ds-content="" className="ds-tool-call__code">
                {line.whole}
              </pre>
            )}
            {change !== null && <p className="ds-tool-call__label">{state === "done" ? "The change it made" : "The change it asked for"}</p>}
            {change !== null && (
              <figure className="ds-diff">
                <pre tabIndex={0} role="group" data-ds-content-label="" aria-label={`The change to ${line.object}`} className="ds-diff__body">
                  <code data-ds-content="" className="ds-diff__lines">
                    {change.lines.map((changed, i) => (
                      <DiffLine key={i} line={changed} plain />
                    ))}
                  </code>
                </pre>
              </figure>
            )}
            {written !== null && <p className="ds-tool-call__label">{state === "done" ? "The text it wrote" : "The text it asked to write"}</p>}
            {written !== null && <Cut text={written.text} what="The text" />}
            {result !== undefined && (
              <div data-event="tool_result" className="ds-stack ds-gap-xs">
                {/* What came back from a call that was not run is what the agent was told, not output of the command. */}
                <Returned text={result.output} label={state === "refused" ? "What Claude Code was told" : result.isError ? "Error output" : "Output"} />
              </div>
            )}
            {folded ? (
              <>
                <p className="ds-tool-call__label">Technical details</p>
                {technical}
              </>
            ) : (
              <details className="ds-disclosure">
                <summary className="ds-disclosure__summary">Technical details</summary>
                <div className="ds-disclosure__content ds-stack ds-gap-sm">{technical}</div>
              </details>
            )}
          </div>
        </details>
      </div>
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
      // Claude Code sends each piece of its reply whole, never word by word, so a text row is a finished message the
      // moment it is stored: the message's streaming state, its caret and its stopped state have no event to come from.
      return (
        <Line kind={e.type} look="agent" label="Claude Code" state="done">
          <Body>
            <Theirs>{e.text}</Theirs>
          </Body>
        </Line>
      );
    case "session_started":
      // Which model answers, by the name Claude Code gives it; the exact id is one tap away. A session that names no model gets no row.
      if (e.model === null) return null;
      return (
        <li data-event={e.type} className="ds-message ds-message--session-start">
          <details className="ds-message__details">
            <summary className="ds-message__summary">
              <span className="ds-message__label">Model</span>
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
      return <Action call={e} story={story} state={stateOf(story, e.id, exchangeOf(event))} folded={folded} />;
    case "tool_result":
      // A result is shown with the call it answers. One whose call is not in this transcript stands alone.
      if (story.calls.has(e.id)) return null;
      return (
        <li data-event={e.type} className="ds-message ds-message--tool-result">
          <span className="ds-message__label">{e.isError ? "Error output" : "Output"}</span>
          <Cut text={e.output} what="The output" />
        </li>
      );
    case "permission_denied":
      return (
        <Line kind={e.type} look="refused" label="Denied">
          <What call={story.calls.get(e.id)} fallback={e.name} />
          <Body>{e.code === "outside_reads_blocked" ? OUTSIDE : "It was not run. It needed your approval, and there was no way to ask you here."}</Body>
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
        <p data-event="usage" className="ds-message__body">{`Tokens: ${exchange.tokensIn} in, ${exchange.tokensOut} out`}</p>
      );
      if (e.reason === "completed") {
        // A reply that finished needs no line saying so. What is known from stored times and counts sits here, quietly.
        const took = exchange === undefined ? null : duration(exchange.from, event.ts);
        if (took === null && tokens === false) return null;
        return (
          <li data-event={e.type} className={LOOK.end}>
            <details className="ds-message__details">
              <summary className="ds-message__summary">
                <span className="ds-message__label">{took === null ? "Usage" : `Worked for ${took}`}</span>
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
            <details className="ds-message__details">
              <summary className="ds-message__summary">Usage</summary>
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

/** The steps a step group holds: three or more tool calls in a row, with nothing else shown between them. */
const GROUP_FROM = 3;

/**
 * Consecutive tool calls folded under one line, as the design system's step group: the line counts what they did,
 * in plain words, and says in words of its own a call that failed, one at work and one waiting for an answer. Every
 * call stays a row inside it. The group opens with the transcript and stays open until the reader closes it: what the
 * agent did is kept in view, and the line only adds the count. (The system's rule closes a group whose steps all ended
 * well; Botbench keeps the calls in view, because seeing them builds trust.)
 */
function StepGroup({ steps, live, children }: { steps: { call: Of<"tool_call">; state: CallState }[]; live: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const failed = steps.filter((step) => step.state === "failed").length;
  const counted = stepsSummary(steps.map((step) => ({ name: step.call.name, state: step.state })));
  const callouts: { state: "failed" | "running" | "awaiting-approval"; words: string }[] = [];
  if (failed > 0) callouts.push({ state: "failed", words: `${failed} failed` });
  if (steps.some((step) => step.state === "running")) callouts.push({ state: "running", words: "Working" });
  if (steps.some((step) => step.state === "waiting")) callouts.push({ state: "awaiting-approval", words: "Needs input" });
  return (
    <li>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="ds-step-group">
        <summary className="ds-step-group__summary">
          <span className="ds-step-group__title">
            {counted !== "" && (live ? `${counted} so far` : counted)}
            {callouts.map((callout) => (
              <span key={callout.state} data-state={callout.state} className="ds-step-group__callout">
                {counted === "" && callout === callouts[0] ? callout.words : ` ${callout.words}`}
              </span>
            ))}
          </span>
        </summary>
        <ol className="ds-step-group__steps">{children}</ol>
      </details>
    </li>
  );
}

/**
 * The transcript of one or more attempts, oldest first. `working` is a note shown last while something is still
 * running. `modelName` gives the name Claude Code has for a model id, or the id itself when it has none. `promptBy`
 * says who wrote the prompts (the owner, unless Botbench wrote them, as it does for planning). `folded` is for a
 * transcript that sits behind a disclosure of its own, so its rows fold one level and not two, and its tool calls are
 * not grouped (a step group inside a disclosure would be a third level).
 */
export function Transcript({ events, working, modelName, promptBy = "You", folded = false }: { events: StoredEvent[]; working: string | null; modelName: (id: string) => string; promptBy?: string; folded?: boolean }) {
  const story = useMemo(() => readStory(events, working !== null), [events, working]);
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());
  const set = useCallback((id: string, open: boolean) => setOpened((have) => new Map(have).set(id, open)), []);
  const openedValue = useMemo(() => ({ opened, set }), [opened, set]);
  // The rows the transcript shows, in order: an event that is told by another row (a result with its call, a usage count) has none.
  const shown = events.map((event) => ({ event, row: Row({ event, story, modelName, promptBy, folded }) })).filter(({ row }) => row !== null);
  const rows: ReactNode[] = [];
  for (let at = 0; at < shown.length; ) {
    let end = at;
    while (end < shown.length && shown[end]!.event.payload.type === "tool_call") end++;
    if (folded || end - at < GROUP_FROM) {
      const { event, row } = shown[at]!;
      rows.push(<Fragment key={event.id}>{row}</Fragment>);
      at++;
      continue;
    }
    const run = shown.slice(at, end);
    const steps = run.map(({ event }) => {
      const call = event.payload as Of<"tool_call">;
      return { event, call, state: stateOf(story, call.id, exchangeOf(event)) };
    });
    // Still arriving while the exchange of its last call is going on.
    const live = story.live && !story.ended.has(exchangeOf(run.at(-1)!.event));
    rows.push(
      <StepGroup key={`group-${run[0]!.event.id}`} steps={steps} live={live}>
        {steps.map(({ event, call, state }) => (
          <Action key={event.id} call={call} story={story} state={state} folded />
        ))}
      </StepGroup>,
    );
    at = end;
  }
  return (
    <Opened.Provider value={openedValue}>
      <ol role="log" aria-live="polite" aria-label="Transcript" className="ds-stack ds-gap-sm">
        {rows}
        {working !== null && (
          <li className="ds-streaming ds-streaming--row">
            <span role="status">{working}</span>
          </li>
        )}
      </ol>
    </Opened.Provider>
  );
}
