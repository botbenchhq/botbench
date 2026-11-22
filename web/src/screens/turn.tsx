import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, getDefaultMode, getDriver, getTranscript, getVoice, interruptTurn, openEventStream, startRun, startTask, startTurn, type Delivery, type DriverState, type RunMode, type StoredEvent } from "../api/client.ts";
import { arrive, blocked as blockedBy, commandsWords, issueWords, readRemembered, repoName, rowsFor, sendFor, writeRemembered, type Facts, type Kind, type RepoPick, type Row } from "../app/composer.ts";
import { cannotRecord, createDictation, insertAt, type Dictation, type DictationState } from "../app/dictation.ts";
import { ContextSheet, type SheetView } from "../components/composer-sheet.tsx";
import { Frame, PageHeader, StreamBanner } from "../components/header.tsx";
import { jumpCount } from "../components/follow.ts";
import { Icon, SPRITE } from "../components/icon.tsx";
import { MODES } from "../components/mode-choice.tsx";
import { choiceName, modelName, useModelChoice } from "../components/model-picker.tsx";
import { useKnownRepositories, useRepository } from "../components/repository.tsx";
import { useIssueChoice } from "../components/issue-choice.tsx";
import { useReviewChoice } from "../components/review-choice.tsx";
import { mergeEvents, Transcript } from "../components/transcript.tsx";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { useTranscript } from "../../vendor/design-system/react/use-transcript.ts";

/** The attempts that make up the conversation on this device, oldest first. Kept so a reload shows the transcript again. */
const CONVERSATION_KEY = "botbench.conversation";
/** The same entry under the product's old name (Smelt), read for one release while the new one has never been written. */
const OLD_CONVERSATION_KEY = "smelt.conversation";

function loadConversation(): number[] {
  try {
    const parsed: unknown = JSON.parse((window.localStorage.getItem(CONVERSATION_KEY) ?? window.localStorage.getItem(OLD_CONVERSATION_KEY)) ?? "[]");
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

/** What is wrong with the agent, or null: while it is being checked and when all is well, the header says nothing. */
function driverProblem(driver: DriverState | null, failed: boolean): string | null {
  if (failed) return "Claude Code: could not be checked";
  if (driver === null || driver.problem === null) return null;
  return !driver.installed ? "Claude Code: not installed" : !driver.supported ? "Claude Code: unsupported version" : !driver.signedIn ? "Claude Code: signed out" : "Claude Code: unavailable";
}

/** What the composer remembers on this device: the repository, what to do, mode, review and delivery. */
const COMPOSER_KEY = "botbench.composer";

function loadComposer(): string | null {
  try {
    return window.localStorage.getItem(COMPOSER_KEY);
  } catch {
    return null;
  }
}

function saveComposer(value: string): void {
  try {
    window.localStorage.setItem(COMPOSER_KEY, value);
  } catch {
    // Private browsing may refuse storage; the choices then last until a reload.
  }
}

const inRepository = (repo: RepoPick): repo is { kind: "known" | "other"; path: string } => repo.kind === "known" || repo.kind === "other";

/**
 * The home screen: the conversation, and under it the one composer that starts anything. With no repository it sends
 * a chat prompt; with a repository it starts a task or plans a run, and opens its screen. `start` comes from New task
 * and New run, which arrive with that kind chosen.
 */
export function TurnScreen({ start, onSignedOut }: { start: Kind | null; onSignedOut: () => void }) {
  const [driver, setDriver] = useState<DriverState | null>(null);
  const [driverFailed, setDriverFailed] = useState(false);
  const [conversation, setConversation] = useState<number[]>(loadConversation);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  /** The chat turn the screen is waiting on. */
  const [active, setActive] = useState<{ attemptId: number; turn: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const startRef = useRef<Promise<{ attemptId: number; turn: number }> | null>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // What the composer holds, starting from what this device remembers.
  const [remembered] = useState(() => readRemembered(loadComposer()));
  const arrived = useMemo(() => arrive(remembered, start), [remembered, start]);
  const [repo, setRepo] = useState<RepoPick>(arrived.repo);
  const [otherPath, setOtherPath] = useState(remembered.repo.kind === "other" ? remembered.repo.path : "");
  const [kind, setKind] = useState<Kind>(arrived.kind);
  /** The mode the owner chose here; until then the default from Settings. */
  const [chosenMode, setChosenMode] = useState<RunMode | null>(remembered.mode);
  const [defaultMode, setDefaultMode] = useState<RunMode | null>(null);
  const mode = chosenMode ?? defaultMode;
  const [delivery, setDelivery] = useState<Delivery>(remembered.delivery);
  const [specPath, setSpecPath] = useState("");
  const [sameBuild, setSameBuild] = useState(true);
  const models = useModelChoice(onSignedOut);
  const buildModels = useModelChoice(onSignedOut, "botbench.buildModel");
  // Only a run has a reviewer: the agents are asked once a run is being set up.
  const [runWanted, setRunWanted] = useState(false);
  const review = useReviewChoice(onSignedOut, remembered.review, runWanted);
  const known = useKnownRepositories(onSignedOut);
  const repository = useRepository(inRepository(repo) ? repo.path.trim() : "", onSignedOut);
  // Only a run can start from an issue, and only in a usable repository whose remote is on GitHub.
  const issue = useIssueChoice(inRepository(repo) && repository.status.state === "usable" ? repo.path.trim() : "", runWanted, onSignedOut);

  useEffect(() => {
    if (repo.kind === "needed") return;
    saveComposer(writeRemembered({ repo, kind, mode: chosenMode, review: review.value, delivery }));
  }, [repo, kind, chosenMode, review.value, delivery]);
  // Coming from New task or New run, the address goes back to the composer's own, so a reload keeps what was chosen since.
  useEffect(() => {
    if (start !== null) window.history.replaceState(null, "", "#/turn");
  }, [start]);
  useEffect(() => {
    let live = true;
    getDefaultMode().then(
      (found) => live && setDefaultMode(found),
      (err: unknown) => {
        if (live && err instanceof ApiError && err.status === 401) onSignedOut();
      },
    );
    return () => {
      live = false;
    };
  }, [onSignedOut]);

  /** The Add context sheet and the view it shows. */
  const sheetRef = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<SheetView>("rows");
  const openSheet = (on: SheetView): void => {
    setView(on);
    if (sheetRef.current !== null && !sheetRef.current.open) sheetRef.current.showModal();
  };

  /** Dictation: offered only when the Mac can transcribe and this browser can record. */
  const [canDictate, setCanDictate] = useState(false);
  const [dictation, setDictation] = useState<DictationState>({ kind: "idle" });
  const dictationRef = useRef<Dictation | null>(null);
  useEffect(() => {
    if (cannotRecord() !== null) return;
    let live = true;
    // When the Mac cannot be asked, there is no button: a control is shown only once its behaviour is there.
    getVoice().then((voice) => live && setCanDictate(voice.available), () => {});
    const recorder = createDictation(setDictation, onSignedOut);
    dictationRef.current = recorder;
    return () => {
      live = false;
      recorder.cancel();
    };
  }, [onSignedOut]);
  const toggleDictation = (): void => {
    const recorder = dictationRef.current;
    if (recorder === null || dictation.kind === "transcribing") return;
    if (dictation.kind !== "listening") return void recorder.start();
    // The words go where the cursor was, and are only put in the box: nothing is sent.
    const box = promptRef.current;
    const from = box?.selectionStart ?? prompt.length;
    const to = box?.selectionEnd ?? from;
    void recorder.stop().then((text) => {
      if (text === null) return;
      let cursor = 0;
      setPrompt((current) => {
        const put = insertAt(current, Math.min(from, current.length), Math.min(to, current.length), text);
        cursor = put.cursor;
        return put.value;
      });
      requestAnimationFrame(() => {
        promptRef.current?.focus();
        promptRef.current?.setSelectionRange(cursor, cursor);
      });
    });
  };

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
    const kept: number[] = [];
    for (const id of ids) {
      try {
        const transcript = await getTranscript(id);
        kept.push(id);
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
    if (kept.length !== ids.length) {
      setConversation(kept);
      saveConversation(kept);
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
  const running = (starting && !inRepository(repo)) || (active !== null && !activeEnded);
  useEffect(() => {
    if (activeEnded) {
      setActive(null);
      setStopping(false);
    }
  }, [activeEnded]);

  // The transcript follows its newest row while the reader is at the bottom (the design system's own hook). It counts
  // the rows the log shows, read from the page once React has put them there.
  const logBox = useRef<HTMLDivElement | null>(null);
  const [rowCount, setRowCount] = useState(0);
  useLayoutEffect(() => {
    setRowCount(logBox.current?.querySelector('ol[role="log"]')?.querySelectorAll(":scope > li:not(.ds-streaming)").length ?? 0);
  });
  const { scrollerRef, logRef, newCount, jumpToLatest, jumpButtonProps } = useTranscript({ rowCount });
  const setLog = useCallback(
    (el: HTMLDivElement | null) => {
      logBox.current = el;
      logRef(el);
    },
    [logRef],
  );

  const builder: Facts["builder"] = driverFailed ? { state: "problem", words: "Botbench could not check Claude Code." } : driver === null ? { state: "checking" } : driver.problem !== null ? { state: "problem", words: driver.problem } : { state: "ready" };
  const facts: Facts = {
    text: prompt,
    repo,
    repoStatus: repository.status,
    kind,
    specPath,
    mode,
    builder,
    model: models.request(),
    buildModel: sameBuild ? null : buildModels.request(),
    commandTyped: repository.listed !== null && repository.adding.trim() !== "",
    hasChecks: repository.listed?.hasChecks ?? null,
    issue: kind === "run" ? issue.attached : null,
  };
  const stopReason = blockedBy(facts);
  const chatting = !inRepository(repo);
  /** While a chat reply runs and the composer would send a chat, the button is Stop. */
  const showStop = chatting && running;

  const sendChat = (text: string, model: string | null | undefined): void => {
    setError(null);
    setStarting(true);
    // Whoever sends wants to see the answer: the transcript follows again.
    jumpToLatest();
    // A model other than the one the conversation is on continues it in a new attempt on that model.
    const started = startTurn(text, conversation.at(-1), model);
    startRef.current = started;
    started.then(
      ({ attemptId, turn }) => {
        const next = conversationRef.current.includes(attemptId) ? conversationRef.current : [...conversationRef.current, attemptId];
        setConversation(next);
        saveConversation(next);
        setAsked((have) => ({ ...have, [attemptId]: model }));
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
        setError(err instanceof ApiError ? `The message was not sent. ${err.message}` : "The message was not sent: Botbench could not be reached.");
      },
    );
  };

  /** Start a task or a run, and open its screen. The server checks everything again itself. */
  const startWork = (what: "task" | "run", begin: () => Promise<string>): void => {
    setError(null);
    setStarting(true);
    begin().then(
      (address) => {
        window.location.hash = address;
      },
      (err: unknown) => {
        setStarting(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setError(err instanceof ApiError ? `The ${what} was not started. ${err.message}` : `The ${what} was not started: Botbench could not be reached.`);
      },
    );
  };

  const send = (): void => {
    if (starting || showStop) return;
    // Only the commands shown in the list are sent, and the server grants nothing else.
    const action = sendFor(facts, { preapproved: repository.listed?.commands ?? [], reviewer: review.choice(), delivery });
    if (action.do === "focus") return promptRef.current?.focus();
    if (action.do === "blocked") return;
    if (action.do === "chat") return sendChat(action.prompt, action.model);
    if (action.do === "task") return startWork("task", () => startTask(action.repo, action.prompt, action.model, action.preapproved).then(({ taskId }) => `#/tasks/${taskId}`));
    const { do: _, ...run } = action;
    startWork("run", () => startRun(run).then(({ runId }) => `#/runs/${runId}`));
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
          setError(err instanceof ApiError ? `Claude Code was not stopped. ${err.message}` : "Claude Code was not stopped: Botbench could not be reached.");
        }),
      // The turn never started, and `send` has already said why.
      () => setStopping(false),
    );
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };

  /** Begin again: the transcript is put away on this device (Botbench keeps what was stored), and the next prompt starts afresh. */
  const newChat = (): void => {
    if (running) return;
    setConversation([]);
    saveConversation([]);
    setActive(null);
    setError(null);
    jumpToLatest();
    promptRef.current?.focus();
  };

  const nameOf = useCallback((id: string) => modelName(models.list, id), [models.list]);
  const problem = driverProblem(driver, driverFailed);
  /** The model each chat attempt was asked for, as this screen sent it; an attempt from before a reload has none recorded. */
  const [asked, setAsked] = useState<Record<number, string | null | undefined>>({});
  /** The name of the model asked for when the one that answered is a different one; null when it is the same or the ask is not known. */
  const differs = useCallback(
    (attemptId: number, answered: string): string | null => {
      const wanted = asked[attemptId];
      if (typeof wanted !== "string") return null;
      const entry = models.list?.models.find((m) => m.id === wanted || m.resolved === wanted);
      return answered === wanted || (entry !== undefined && (answered === entry.id || answered === entry.resolved)) ? null : nameOf(wanted);
    },
    [asked, models.list, nameOf],
  );

  const run = inRepository(repo) && kind === "run";
  useEffect(() => {
    if (run) setRunWanted(true);
  }, [run]);
  const builds = run && !sameBuild ? buildModels : models;
  const values: Record<Row, string> = {
    repository: repoName(repo, known),
    kind: kind === "task" ? "One task" : "Plan a run",
    spec: specPath.trim() === "" ? "None" : (specPath.trim().split("/").at(-1) ?? specPath.trim()),
    mode: kind === "task" ? "Manual" : (MODES.find((m) => m.mode === mode)?.name ?? "Reading"),
    review: review.offer.state === "checking" ? "Checking" : review.words,
    delivery: delivery === "branch" ? "Keep the branch" : "Open a pull request",
    commands: commandsWords(repository.listed?.commands.length ?? 0),
    models: run && !sameBuild ? `${choiceName(models)}, then ${choiceName(buildModels)}` : choiceName(models),
    issue: issueWords(issue.attached),
  };
  const rows = rowsFor({ repo, kind, reviewOffered: !(review.offer.state === "not-offered" && review.offer.none), commandsKnown: repository.listed !== null, issueOffered: issue.source.state === "offered" });
  const label = chatting ? "Message Claude Code" : kind === "task" ? "Describe the task" : "Describe what to plan";
  const describedBy = [stopReason !== null ? "composer-reason" : null, error !== null ? "composer-error" : null].filter((id) => id !== null).join(" ") || undefined;
  const builderDown = builder.state !== "ready";
  const name = repoName(repo, known);

  return (
    <Frame current="turn" fill banner={connected ? undefined : <StreamBanner />}>
      <main className="flex min-h-0 min-w-0 flex-col">
        <div className="ds-container py-md">
          <PageHeader
            title="Chat"
            action={
              conversation.length > 0 ? (
                <button type="button" disabled={running} onClick={newChat} className="ds-button">
                  New chat
                </button>
              ) : undefined
            }
          >
            {problem !== null && (
              <p data-testid="driver-state" className="ds-page-header__description">
                {problem}
              </p>
            )}
          </PageHeader>
        </div>

        <div ref={scrollerRef} role="region" aria-label="Transcript" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
          <div ref={setLog} className="ds-container pb-lg">
            {shown.length > 0 ? (
              <Transcript events={shown} working={running ? (stopping ? "Stopping Claude Code." : "Claude Code is working.") : null} modelName={nameOf} modelDiffers={differs} />
            ) : chatting ? (
              <div className="ds-empty-state ds-empty-state--compact">
                <h2 className="ds-empty-state__title">Ask Claude Code anything</h2>
              </div>
            ) : (
              <div className="ds-empty-state ds-empty-state--compact" data-testid="composer-about">
                <h2 className="ds-empty-state__title">{kind === "task" ? `New task in ${name}` : `New run in ${name}`}</h2>
                <p className="ds-empty-state__body">
                  {kind === "task"
                    ? "Claude Code works on a new branch, in a separate copy of the repository (a git worktree). Your own files and your branch are not touched."
                    : `Claude Code plans tasks first, reading a copy it cannot change. ${mode === "full" ? "Building starts on the plan without your approval." : "Nothing is built until you approve the plan."}${delivery === "pull_request" ? " Each accepted task is then opened as a pull request." : ""}`}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="ds-jump-to-latest" hidden={newCount === 0}>
          <button type="button" className="ds-jump-to-latest__button" {...jumpButtonProps}>
            <span className="ds-jump-to-latest__count">{jumpCount(newCount)}</span> Jump to latest
          </button>
        </div>

        <form onSubmit={submit} aria-busy={showStop || undefined} className="ds-composer ds-composer--sticky" noValidate>
          <div className="ds-composer__box">
            <textarea id="prompt" name="prompt" ref={promptRef} rows={1} aria-label={label} placeholder={label} value={prompt} disabled={builderDown} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKeyDown} aria-describedby={describedBy} className="ds-composer__input" />
            <div className="ds-composer__bar">
              <BusyButton icon="plus" spriteHref={SPRITE} className="ds-icon-button" aria-label="Add context" aria-haspopup="dialog" onClick={() => openSheet("rows")}>
                {null}
              </BusyButton>
              <div className="ds-composer__controls">
                {stopReason?.required === "repository" ? (
                  <BusyButton size="small" className="ds-composer__chip" aria-haspopup="dialog" aria-describedby="composer-reason" onClick={() => openSheet("repository")}>
                    <span className="ds-composer__value">
                      <span className="ds-visually-hidden">Choose a </span>Repository
                    </span>
                  </BusyButton>
                ) : (
                  <BusyButton variant="quiet" size="small" className="ds-composer__chip" aria-haspopup="dialog" onClick={() => openSheet("models")}>
                    <span className="ds-composer__value">
                      <span className="ds-visually-hidden">Model: </span>
                      {choiceName(builds)}
                      <span className="ds-visually-hidden">, </span>
                      {" "}
                      <span className="ds-composer__qualifier">Claude Code</span>
                    </span>
                  </BusyButton>
                )}
              </div>
              {canDictate && (
                <button
                  type="button"
                  onClick={toggleDictation}
                  aria-label="Dictate"
                  aria-pressed={dictation.kind === "listening"}
                  aria-busy={dictation.kind === "transcribing" || undefined}
                  aria-describedby={dictation.kind === "error" ? "dictation-error" : dictation.kind === "idle" ? undefined : "dictation-status"}
                  className="ds-button ds-button--quiet ds-icon-button"
                >
                  <Icon name="mic" className="ds-button__icon" />
                </button>
              )}
              {showStop ? (
                <BusyButton busy={stopping} busyLabel="Stopping" onClick={stop} aria-describedby="composer-reason">
                  Stop
                </BusyButton>
              ) : (
                <BusyButton type="submit" variant="primary" busy={starting} busyLabel={chatting ? "Sending" : "Starting"} disabled={stopReason !== null} aria-describedby={describedBy}>
                  Send
                </BusyButton>
              )}
            </div>
          </div>
          {showStop ? (
            <p id="composer-reason" className="ds-composer__reason">
              Claude Code is working. You can send again when it has answered.
            </p>
          ) : (
            stopReason !== null && (
              <p id="composer-reason" data-testid={builderDown ? "driver-problem" : "composer-reason"} className="ds-composer__reason">
                {stopReason.reason}
              </p>
            )
          )}
          {builder.state === "problem" && (
            // Asks the agent again, for real, once the owner has fixed what the reason names.
            <BusyButton variant="quiet" size="small" onClick={checkDriver}>
              Check again
            </BusyButton>
          )}
          {error !== null && (
            <p id="composer-error" role="alert" className="ds-composer__error">
              {error}
            </p>
          )}
          {(dictation.kind === "listening" || dictation.kind === "transcribing") && (
            <p id="dictation-status" role="status" className="ds-composer__reason">
              {dictation.kind === "listening" ? "Listening. Press Dictate again when you have finished." : "Transcribing"}
            </p>
          )}
          {dictation.kind === "error" && (
            <p id="dictation-error" role="alert" className="ds-composer__error">
              {dictation.message}
            </p>
          )}
        </form>

        <ContextSheet
          sheetRef={sheetRef}
          view={view}
          setView={setView}
          state={{
            rows,
            values,
            warning: { mode: run && mode === "full" },
            repo,
            otherPath,
            known,
            chooseRepo: setRepo,
            setOtherPath: (path) => {
              setOtherPath(path);
              setRepo({ kind: "other", path });
            },
            repository,
            kind,
            setKind,
            specPath,
            setSpecPath,
            mode,
            setMode: setChosenMode,
            review,
            delivery,
            setDelivery,
            issue,
            models,
            sameBuild,
            setSameBuild,
            buildModels,
          }}
        />
      </main>
    </Frame>
  );
}
