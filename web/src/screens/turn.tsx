import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, getDriver, getTranscript, interruptTurn, openEventStream, startTurn, type DriverState, type StoredEvent } from "../api/client.ts";
import { Mark } from "../app/shell.tsx";

/** The attempts that make up the conversation on this device, oldest first. Kept so a reload shows the transcript again. */
const CONVERSATION_KEY = "smelt.conversation";

function loadConversation(): number[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CONVERSATION_KEY) ?? "[]");
    return Array.isArray(parsed) && parsed.every((id) => Number.isSafeInteger(id) && id > 0) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
}

function saveConversation(ids: number[]): void {
  try {
    window.localStorage.setItem(CONVERSATION_KEY, JSON.stringify(ids));
  } catch {
    // Private browsing may refuse storage; the conversation then lasts until a reload.
  }
}

/** Add events to a list kept in id order, skipping any already there. */
function merge(have: StoredEvent[], more: StoredEvent[]): StoredEvent[] {
  if (more.length === 0) return have;
  const byId = new Map(have.map((e) => [e.id, e]));
  for (const event of more) byId.set(event.id, event);
  return byId.size === have.length ? have : [...byId.values()].sort((a, b) => a.id - b.id);
}

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function driverWords(driver: DriverState | null, failed: boolean): string {
  if (failed) return "Claude Code: state unknown";
  if (driver === null) return "Checking Claude Code";
  if (driver.problem !== null) return !driver.installed ? "Claude Code: not installed" : !driver.supported ? "Claude Code: unsupported version" : !driver.signedIn ? "Claude Code: signed out" : "Claude Code: unavailable";
  const billing = driver.billing === "subscription" ? "subscription" : driver.billing === "metered" ? "metered billing" : "billing unknown";
  return `Claude Code ${driver.version ?? ""} · signed in · ${billing}`;
}

function endWords(reason: "completed" | "interrupted" | "error", detail: string | null): string {
  if (reason === "completed") return "Turn completed.";
  if (reason === "interrupted") return "Turn stopped before it finished.";
  return detail === null ? "Turn ended with an error." : `Turn ended with an error: ${detail}`;
}

/** A one-line row: a label in words, then what it says. */
function Line({ kind, label, children }: { kind: string; label: string; children?: React.ReactNode }) {
  return (
    <li data-event={kind} className="flex gap-sm break-words px-md text-muted">
      <span className="shrink-0 font-medium uppercase">{label}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** Every piece of transcript text is rendered as a React child, so it is always text and never markup. */
function Row({ event }: { event: StoredEvent }) {
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
          {`${e.name} ${shorten(JSON.stringify(e.input) ?? "", 160)}`}
        </Line>
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

export function TurnScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [driver, setDriver] = useState<DriverState | null>(null);
  const [driverFailed, setDriverFailed] = useState(false);
  const [conversation, setConversation] = useState<number[]>(loadConversation);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  /** The turn the screen is waiting on. */
  const [active, setActive] = useState<{ attemptId: number; turn: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const startRef = useRef<Promise<{ attemptId: number; turn: number }> | null>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const logRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const checkDriver = useCallback((): void => {
    setDriver(null);
    setDriverFailed(false);
    getDriver().then(setDriver, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setDriverFailed(true);
    });
  }, [onSignedOut]);
  useEffect(checkDriver, [checkDriver]);

  /** Read the conversation's stored transcripts and fold them in. Returns the newest event id seen. */
  const refresh = useCallback(async (ids: number[]): Promise<number> => {
    let newest = 0;
    const known: number[] = [];
    for (const id of ids) {
      try {
        const transcript = await getTranscript(id);
        known.push(id);
        setEvents((have) => merge(have, transcript.events));
        newest = Math.max(newest, transcript.events.at(-1)?.id ?? 0);
        if (id === ids.at(-1)) {
          const turn = Math.max(0, ...transcript.events.map((e) => e.turn));
          // A turn started after this request was sent is newer than what it says, and is left alone.
          setActive((current) => (transcript.turnRunning ? { attemptId: id, turn } : current !== null && (current.attemptId !== id || current.turn > turn) ? current : null));
        }
      } catch (err) {
        // An attempt this server does not know (another data directory) drops out of the conversation.
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
    }
    if (known.length !== ids.length) {
      setConversation(known);
      saveConversation(known);
    }
    return newest;
  }, []);

  // Fetch what is stored, then follow the stream from there. After a drop, fetch again so nothing is missed.
  useEffect(() => {
    let close: (() => void) | undefined;
    let cancelled = false;
    let dropped = false;
    const open = (after: number): void => {
      if (cancelled) return;
      close = openEventStream(after, {
        onEvent: (event) => setEvents((have) => merge(have, [event])),
        onConnection: (isConnected) => {
          setConnected(isConnected);
          if (!isConnected) dropped = true;
          else if (dropped) {
            dropped = false;
            refresh(conversationRef.current).catch(() => {});
          }
        },
        onSignedOut,
      });
    };
    refresh(conversationRef.current).then(open, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      // The stored transcript could not be read. Follow the stream anyway, and read it as soon as the stream is up.
      dropped = true;
      open(0);
    });
    return () => {
      cancelled = true;
      close?.();
    };
  }, [refresh, onSignedOut]);

  const shown = useMemo(() => events.filter((e) => conversation.includes(e.attemptId)), [events, conversation]);
  const activeEnded = active !== null && events.some((e) => e.attemptId === active.attemptId && e.turn === active.turn && e.type === "turn_ended");
  const running = starting || (active !== null && !activeEnded);
  useEffect(() => {
    if (activeEnded) {
      setActive(null);
      setStopping(false);
    }
  }, [activeEnded]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [shown.length, running]);

  const send = (): void => {
    const text = prompt.trim();
    if (running) return;
    if (text === "") return promptRef.current?.focus();
    setError(null);
    setStarting(true);
    const started = startTurn(text, conversation.at(-1));
    startRef.current = started;
    started.then(
      ({ attemptId, turn }) => {
        const next = conversationRef.current.includes(attemptId) ? conversationRef.current : [...conversationRef.current, attemptId];
        setConversation(next);
        saveConversation(next);
        setActive({ attemptId, turn });
        setStarting(false);
        setPrompt("");
        // Events stored before the attempt was known here may have been missed by a stream that was reconnecting.
        getTranscript(attemptId).then((transcript) => setEvents((have) => merge(have, transcript.events)), () => {});
      },
      (err: unknown) => {
        setStarting(false);
        setStopping(false);
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (err instanceof ApiError && err.driver !== null) setDriver(err.driver);
        setError(err instanceof ApiError ? `The prompt was not sent. ${err.message}` : "The prompt was not sent: Smelt could not be reached.");
      },
    );
  };

  const stop = (): void => {
    if (stopping) return;
    setStopping(true);
    // A turn that is still being started is stopped as soon as its attempt is known.
    const target = active !== null ? Promise.resolve(active) : startRef.current;
    if (!target) return setStopping(false);
    target.then(
      ({ attemptId }) =>
        interruptTurn(attemptId).catch((err: unknown) => {
          setStopping(false);
          // 409: the turn ended on its own first, which the transcript already shows.
          if (err instanceof ApiError && err.status === 409) return;
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
          setError(err instanceof ApiError ? `The turn was not stopped. ${err.message}` : "The turn was not stopped: Smelt could not be reached.");
        }),
      // The turn never started, and `send` has already said why.
      () => setStopping(false),
    );
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (running) stop();
    else send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!running) send();
    }
  };

  const canSend = driver !== null && driver.problem === null;

  return (
    <div className="mx-auto flex h-screen max-w-transcript flex-col">
      <header className="flex flex-col gap-xs border-b px-lg py-md">
        <div className="flex items-baseline gap-md">
          <Mark />
          <nav aria-label="Screens" className="font-mono text-mono text-muted">
            <span aria-current="page">Turn</span>
          </nav>
        </div>
        <p data-testid="driver-state" className="font-mono text-mono text-muted">
          {driverWords(driver, driverFailed)}
        </p>
      </header>

      {!connected && (
        <p role="status" data-testid="stream-banner" className="border-b bg-border px-lg py-sm font-medium">
          Live updates are disconnected. Reconnecting.
        </p>
      )}

      <main ref={logRef} className="min-h-0 flex-1 overflow-y-auto p-lg" tabIndex={0} aria-label="Transcript">
        {shown.length === 0 ? (
          <p className="text-muted">No turns yet. A prompt goes to Claude Code, which works in an empty scratch directory inside Smelt's data directory.</p>
        ) : (
          <ol role="log" aria-live="polite" className="flex flex-col gap-sm font-mono text-mono">
            {shown.map((event) => (
              <Row key={event.id} event={event} />
            ))}
            {running && (
              <li role="status" className="px-md text-muted">
                {stopping ? "Stopping the turn." : "Claude Code is working."}
              </li>
            )}
          </ol>
        )}
      </main>

      <footer className="flex flex-col gap-sm border-t p-lg">
        {error !== null && (
          <p role="alert" className="font-medium">
            {error}
          </p>
        )}
        {canSend ? (
          <form onSubmit={submit} className="flex flex-col gap-sm">
            <label htmlFor="prompt" className="font-mono text-mono text-muted">
              Prompt
            </label>
            <textarea
              id="prompt"
              ref={promptRef}
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              className="max-h-input min-h-touch resize-none rounded-sm border bg-surface p-md"
            />
            <button type="submit" className="min-h-touch rounded-sm border border-accent bg-accent px-lg font-medium uppercase tracking-wide text-surface">
              {running ? "Stop" : "Send"}
            </button>
          </form>
        ) : driver !== null || driverFailed ? (
          <div className="flex flex-col gap-sm" data-testid="driver-problem">
            <p className="font-medium">{driverFailed ? "Smelt could not check Claude Code." : driver!.problem}</p>
            <p className="text-muted">Prompts cannot be sent until this is fixed.</p>
            <button type="button" onClick={checkDriver} className="min-h-touch self-start text-left underline underline-offset-xs">
              Check again
            </button>
          </div>
        ) : (
          <p role="status" className="text-muted">
            Checking that Claude Code can be driven.
          </p>
        )}
      </footer>
    </div>
  );
}
