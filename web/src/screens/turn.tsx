import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, getDriver, getTranscript, interruptTurn, openEventStream, startTurn, type DriverState, type StoredEvent } from "../api/client.ts";
import { Alert, Frame, PageHeader, StreamBanner } from "../components/header.tsx";
import { ModelPicker, modelWords, sessionModel, useModelChoice } from "../components/model-picker.tsx";
import { mergeEvents, Transcript } from "../components/transcript.tsx";

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

function driverWords(driver: DriverState | null, failed: boolean): string {
  if (failed) return "Claude Code: state unknown";
  if (driver === null) return "Checking Claude Code";
  if (driver.problem !== null) return !driver.installed ? "Claude Code: not installed" : !driver.supported ? "Claude Code: unsupported version" : !driver.signedIn ? "Claude Code: signed out" : "Claude Code: unavailable";
  const billing = driver.billing === "subscription" ? "subscription" : driver.billing === "metered" ? "metered billing" : "billing unknown";
  return `Claude Code ${driver.version ?? ""} · signed in · ${billing}`;
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
  const models = useModelChoice(onSignedOut);
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
        setEvents((have) => mergeEvents(have, transcript.events));
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
        onEvent: (event) => setEvents((have) => mergeEvents(have, [event])),
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
    const model = models.request();
    if (!model.ok) return setError(`The prompt was not sent. ${model.why}`);
    setError(null);
    setStarting(true);
    // A model other than the one the conversation is on continues it in a new attempt on that model.
    const started = startTurn(text, conversation.at(-1), model.model);
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
        getTranscript(attemptId).then((transcript) => setEvents((have) => mergeEvents(have, transcript.events)), () => {});
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
    // While a turn runs the form holds Stop, a button of its own, and sends nothing.
    if (!running) send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!running) send();
    }
  };

  const canSend = driver !== null && driver.problem === null;
  const session = useMemo(() => sessionModel(shown), [shown]);

  return (
    <Frame current="turn" fill banner={connected ? undefined : <StreamBanner />}>
      <main className="flex min-h-0 min-w-0 flex-col">
        <div className="gw-container py-md">
          <PageHeader title="Turn">
            <p data-testid="driver-state" className="gw-page-header__description">
              {driverWords(driver, driverFailed)}
            </p>
            {session !== null && (
              <p data-testid="turn-model" className="gw-page-header__description sm-wrap">
                {modelWords(session)}
              </p>
            )}
          </PageHeader>
        </div>

        <div ref={logRef} role="region" aria-label="Transcript" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
          <div className="gw-container pb-lg">
            {shown.length === 0 ? (
              <div className="gw-empty-state gw-empty-state--compact">
                <h2 className="gw-empty-state__title">No turns yet</h2>
                <p className="gw-empty-state__body">A prompt goes to Claude Code, which works in an empty scratch directory inside Smelt's data directory.</p>
              </div>
            ) : (
              <Transcript events={shown} working={running ? (stopping ? "Stopping the turn." : "Claude Code is working.") : null} />
            )}
          </div>
        </div>

        {canSend ? (
          <form onSubmit={submit} aria-busy={running && error === null} className="gw-composer gw-composer--sticky">
            <ModelPicker state={models} />
            <label htmlFor="prompt" className="gw-composer__label">
              Prompt
            </label>
            <div className="gw-composer__row">
              <textarea id="prompt" name="prompt" ref={promptRef} rows={1} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKeyDown} aria-describedby={error === null ? undefined : "prompt-error"} className="gw-composer__input" />
              {running ? (
                <button type="button" onClick={stop} aria-busy={stopping} className="gw-button">
                  Stop
                </button>
              ) : (
                <button type="submit" className="gw-button gw-button--primary">
                  Send
                </button>
              )}
            </div>
            {error !== null && (
              <p id="prompt-error" role="alert" className="gw-composer__error">
                {error}
              </p>
            )}
          </form>
        ) : (
          <div className="gw-container gw-stack py-md">
            {error !== null && (
              <Alert tone="error" role="alert">
                {error}
              </Alert>
            )}
            {driver !== null || driverFailed ? (
              <Alert
                tone="warning"
                testId="driver-problem"
                title={driverFailed ? "Smelt could not check Claude Code." : (driver!.problem ?? undefined)}
                action={
                  <button type="button" onClick={checkDriver} className="gw-button gw-button--small">
                    Check again
                  </button>
                }
              >
                Prompts cannot be sent until this is fixed.
              </Alert>
            ) : (
              <p role="status" className="gw-spinner">
                Checking that Claude Code can be driven.
              </p>
            )}
          </div>
        )}
      </main>
    </Frame>
  );
}
