import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, getChat, getDefaultMode, getDriver, getFirstRun, getProposal, getTranscript, getVoice, interruptTurn, openEventStream, sendChatMessage, startRun, startTask, type ChatTarget, type Delivery, type DriverState, type RunMode, type StoredEvent } from "../api/client.ts";
import { arrive, blocked as blockedBy, builderName, chipModel, type Builder, commandsWords, issueWords, modeFor, modeLine, oneTaskFor, startMode, READ_ABOUT, readName, type ChosenMode, readRemembered, repoName, rowsFor, sendFor, writeRemembered, type Facts, type Kind, type ReadPick, type RepoPick, type Row } from "../app/composer.ts";
import { agentName, agentRowValue, CLAUDE, chatTargets, chatView, chipWords, sendWords, type AttemptInfo } from "../app/chat.ts";
import { chatChip, CompareAction, useChatAgents } from "../components/agent-choice.tsx";
import { agentLine, agentStatus, AGENTS_ADDRESS, CONNECT, FIRST_STEP, type AgentStatus } from "../app/first-run.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ApprovalCard } from "../components/approval-card.tsx";
import { cannotRecord, createDictation, insertAt, type Dictation, type DictationState } from "../app/dictation.ts";
import { ContextSheet, type SheetView } from "../components/composer-sheet.tsx";
import { Alert, Frame, Page, PageHeader, StreamBanner } from "../components/header.tsx";
import { jumpCount } from "../components/follow.ts";
import { Icon, SPRITE } from "../components/icon.tsx";
import { MODES } from "../components/mode-choice.tsx";
import { choiceName, modelName, useModelChoice } from "../components/model-picker.tsx";
import { useKnownRepositories, useRepository } from "../components/repository.tsx";
import { useIssueChoice } from "../components/issue-choice.tsx";
import { usePeersOf } from "../components/other-workbenches.tsx";
import { agoWords, claimNotice, issueWarnings, oldClaims } from "../app/peers.ts";
import { ConfirmAction } from "../components/confirm.tsx";
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

/**
 * A chat opened from its row on Work: its attempts become the conversation this device shows, and Chat opens on it.
 * The chat the device showed before is not lost: Botbench keeps every chat, and Work lists it.
 */
export function OpenChat({ id, onSignedOut }: { id: number; onSignedOut: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getChat(id).then(
      (chat) => {
        if (!live) return;
        saveConversation(chat.attempts);
        window.location.replace("#/turn");
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The chat could not be opened. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
      },
    );
    return () => {
      live = false;
    };
  }, [id, onSignedOut]);
  return (
    <Frame current="turn">
      <Page>
        <PageHeader title="Chat" />
        {problem === null ? (
          <p role="status" className="ds-spinner">
            Opening the chat.
          </p>
        ) : (
          <div className="ds-stack ds-gap-sm">
            <Alert tone="error" role="alert">
              {problem}
            </Alert>
            <p>
              <a href="#/work" className="ds-link">
                Back to Work
              </a>
            </p>
          </div>
        )}
      </Page>
    </Frame>
  );
}

/** What is wrong with the agent, or null: while it is being checked and when all is well, the header says nothing. */
const HEADER_PROBLEM: Record<AgentStatus, string | null> = {
  checking: null,
  ready: null,
  "not-checked": "Claude Code: could not be checked",
  "not-installed": "Claude Code: not installed",
  unsupported: "Claude Code: unsupported version",
  "signed-out": "Claude Code: signed out",
  unavailable: "Claude Code: unavailable",
};

/** The one link to connect an agent, at the end of a sentence that says the agent cannot be used. */
function ConnectAgent({ first = false }: { first?: boolean }) {
  return (
    <>
      {`${first ? "" : " "}${CONNECT.before}`}
      <a href={AGENTS_ADDRESS} className="ds-link">
        {CONNECT.link}
      </a>
      {CONNECT.after}
    </>
  );
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
export function TurnScreen({ start, proposal = null, onSignedOut }: { start: Kind | null; proposal?: number | null; onSignedOut: () => void }) {
  const [driver, setDriver] = useState<DriverState | null>(null);
  const [driverFailed, setDriverFailed] = useState(false);
  const [conversation, setConversation] = useState<number[]>(loadConversation);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  /** The chat turns the screen is waiting on: one, or one per agent asked at once. */
  const [active, setActive] = useState<{ attemptId: number; turn: number }[]>([]);
  /** Who answered in each attempt of the chat, and the message it answered. */
  const [infos, setInfos] = useState<ReadonlyMap<number, AttemptInfo>>(new Map());
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  /** Other workbenches' old claims the owner confirmed taking over for the run about to start, by branch. */
  const [takenOver, setTakenOver] = useState<string[]>([]);
  const startRef = useRef<Promise<{ attemptId: number; turn: number }[]> | null>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // What the composer holds, starting from what this device remembers.
  const [remembered] = useState(() => readRemembered(loadComposer()));
  // Come from Start on a proposed issue, the repository is the issue's: the repository view is not opened for it.
  const arrived = useMemo(() => (proposal === null ? arrive(remembered, start) : { ...arrive(remembered, start), opens: null }), [remembered, start, proposal]);
  const [repo, setRepo] = useState<RepoPick>(arrived.repo);
  const [otherPath, setOtherPath] = useState(remembered.repo.kind === "other" ? remembered.repo.path : "");
  const [kind, setKind] = useState<Kind>(arrived.kind);
  /** The mode the owner chose here, for the repository it was chosen for; otherwise the default from Settings. */
  const [chosenMode, setChosenMode] = useState<ChosenMode | null>(remembered.mode);
  /** Whether the owner chose the mode on this visit; until then it is the one remembered, which may fall back (`startMode`). */
  const [modeChosenHere, setModeChosenHere] = useState(false);
  const [defaultMode, setDefaultMode] = useState<RunMode | null>(null);
  const repoPath = repo.kind === "known" || repo.kind === "other" ? repo.path.trim() : "";
  const [delivery, setDelivery] = useState<Delivery>(remembered.delivery);
  /** Who the owner chose to build; Claude Code unless Codex was chosen here. Not remembered: each start chooses again. */
  const [builderPick, setBuilderPick] = useState<Builder | null>(null);
  /** Keep the run to one task, as the owner chose it here; null follows the mode (`oneTaskFor`). */
  const [chosenOneTask, setChosenOneTask] = useState<boolean | null>(null);
  const [specPath, setSpecPath] = useState("");
  const [sameBuild, setSameBuild] = useState(remembered.sameBuild);
  const models = useModelChoice(onSignedOut);
  const buildModels = useModelChoice(onSignedOut, "botbench.buildModel");
  // Only a run has a reviewer: the agents are asked once a run is being set up.
  const [runWanted, setRunWanted] = useState(false);
  const review = useReviewChoice(onSignedOut, remembered.review, runWanted);
  const known = useKnownRepositories(onSignedOut);
  const repository = useRepository(inRepository(repo) ? repo.path.trim() : "", onSignedOut);
  /** A repository the chat lets its agents read, never change. Not remembered: each is chosen for the chat at hand. */
  const [readPick, setReadPick] = useState<ReadPick>({ kind: "none" });
  const [readOther, setReadOther] = useState("");
  const readPath = repo.kind === "none" && readPick.kind !== "none" ? readPick.path.trim() : "";
  const reading = useRepository(readPath, onSignedOut);
  /** The issue proposed on Work that Start was chosen on, once read: its repository and number. */
  const [preset, setPreset] = useState<{ repo: string; number: number } | null>(null);
  // Only a run can start from an issue, and only in a usable repository whose remote is on GitHub.
  const issue = useIssueChoice(inRepository(repo) && repository.status.state === "usable" ? repo.path.trim() : "", runWanted, onSignedOut, preset);
  // The mode the run starts in: the one remembered for this repository, falling back to a stricter one, and saying why,
  // when it cannot start here; else the default from Settings. Shown under the box before Send.
  const started = startMode(modeFor(chosenMode, repoPath, defaultMode), { remembered: !modeChosenHere && chosenMode !== null && chosenMode.repo === repoPath, hasChecks: repository.listed?.hasChecks ?? null, issue: kind === "run" && issue.attached !== null });
  const mode = started.mode;
  const oneTask = oneTaskFor(chosenOneTask, mode);
  // What other workbenches have in flight on the repository's remote: warnings only, never a reason Send waits.
  const peers = usePeersOf(inRepository(repo) && repository.status.state === "usable" ? repo.path.trim() : "", onSignedOut);

  useEffect(() => {
    if (repo.kind === "needed") return;
    saveComposer(writeRemembered({ repo, kind, mode: chosenMode, review: review.value, delivery, sameBuild }));
  }, [repo, kind, chosenMode, review.value, delivery, sameBuild]);
  // Coming from New task or New run, the address goes back to the composer's own, so a reload keeps what was chosen since.
  useEffect(() => {
    if (start !== null) window.history.replaceState(null, "", "#/turn");
  }, [start]);
  /** Whether this installation has never stored a chat, task or run; null until the server has said, and then nothing is shown. */
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getFirstRun().then(
      (found) => live && setFirstRun(found),
      (err: unknown) => {
        // Not known: the lines are not shown, and the home screen is as it always was.
        if (live && err instanceof ApiError && err.status === 401) onSignedOut();
      },
    );
    return () => {
      live = false;
    };
  }, [onSignedOut]);
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
  // Coming from New task or New run with no repository remembered, the owner came to work in one: the sheet opens on it.
  useEffect(() => {
    if (arrived.opens !== null) openSheet(arrived.opens);
  }, [arrived.opens]);

  // Coming from Start on an issue proposed on Work: a run in the issue's repository, the issue looked up and attached in
  // the From an issue row (components/issue-choice.tsx), which opens once it is offered. Nothing is sent until Send.
  useEffect(() => {
    if (proposal === null) return;
    let live = true;
    getProposal(proposal).then(
      (found) => {
        if (!live) return;
        setOtherPath(found.repoPath);
        setRepo({ kind: "other", path: found.repoPath });
        setKind("run");
        setPreset({ repo: found.repoPath, number: found.number });
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setError(err instanceof ApiError ? err.message : "The proposed issue could not be read: Botbench could not be reached.");
      },
    );
    return () => {
      live = false;
    };
  }, [proposal, onSignedOut]);
  const issueOffered = issue.source.state === "offered";
  const presetOpened = useRef(false);
  useEffect(() => {
    if (preset === null || !issueOffered || presetOpened.current) return;
    presetOpened.current = true;
    openSheet("issue");
  }, [preset, issueOffered]);

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
        setInfos((have) => new Map(have).set(id, { agent: transcript.agent, model: transcript.model, round: transcript.round }));
        setEvents((have) => mergeEvents(have, transcript.events));
        newest = Math.max(newest, transcript.events.at(-1)?.id ?? 0);
        const turn = Math.max(0, ...transcript.events.map((e) => e.turn));
        // A turn started after this request was sent is newer than what it says, and is left alone.
        setActive((current) => {
          const others = current.filter((a) => a.attemptId !== id || a.turn > turn);
          return transcript.turnRunning && !others.some((a) => a.attemptId === id) ? [...others, { attemptId: id, turn }] : others;
        });
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
  // What this chat's Claude Code waits for you to answer: each card stands in the transcript where it was asked.
  const { pending } = useContext(ApprovalsContext);
  // A chat's request from another device's chat (or one this device put away) is shown here too, after the transcript.
  const waitingHere = useMemo(() => (pending ?? []).filter((approval) => approval.chat), [pending]);
  const askedAt = useMemo(() => new Set(shown.flatMap((e) => (e.payload.type === "permission_request" ? [`${e.attemptId}:${e.payload.toolCallId}`] : []))), [shown]);
  const cardOf = (approval: (typeof waitingHere)[number]) => <ApprovalCard key={approval.id} approval={approval} more={0} on="chat" onSignedOut={onSignedOut} />;
  const asking = useCallback(
    (attemptId: number, toolCallId: string) => {
      const approval = waitingHere.find((a) => a.attemptId === attemptId && a.toolCallId === toolCallId);
      return approval === undefined ? null : cardOf(approval);
    },
    [waitingHere, onSignedOut],
  );
  const chat = useMemo(() => chatView(shown, infos, conversation), [shown, infos, conversation]);
  const endedOf = (a: { attemptId: number; turn: number }): boolean => events.some((e) => e.attemptId === a.attemptId && e.turn === a.turn && e.type === "turn_ended");
  const working = active.filter((a) => !endedOf(a));
  const anyEnded = working.length !== active.length;
  const running = (starting && !inRepository(repo)) || working.length > 0;
  useEffect(() => {
    if (anyEnded) {
      setActive((current) => current.filter((a) => !endedOf(a)));
      if (working.length === 0) setStopping(false);
    }
  });

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

  // Who a chat asks. The agents are asked for when the screen opens, so the choice lists them all at once.
  const agents = useChatAgents(onSignedOut);
  const offered = agents.offer.known;
  const targets = chatTargets(agents.choice, models.request(), offered);
  const asksClaude = !targets.ok || targets.targets.some((t) => t.agent === CLAUDE);
  const claudeState: Facts["builder"] = driverFailed ? { state: "problem", words: "Botbench could not check Claude Code." } : driver === null ? { state: "checking" } : driver.problem !== null ? { state: "problem", words: driver.problem } : { state: "ready" };
  // Codex is offered as the builder only once the server's check found it can build; a choice it no longer has is Claude Code.
  const codexBuilds = (offered ?? []).some((a) => a.agent === "codex" && a.builds === true);
  const chosenBuilder: Builder | null = codexBuilds && builderPick === "codex" ? "codex" : null;
  // A chat that asks only other agents, and a task on its own that Codex builds, do not wait on Claude Code; a run does,
  // as Claude Code plans it.
  const builder: Facts["builder"] = (!inRepository(repo) && !asksClaude) || (inRepository(repo) && kind === "task" && chosenBuilder === "codex") ? { state: "ready" } : claudeState;
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
    read: { pick: readPick, status: reading.status },
    agentsChecking: agents.offer.checking,
    // Claude Code is never given a repository in a chat; another agent reads one as the server said (src/api/chat.ts).
    ...(targets.ok ? { asked: targets.targets.map((t) => ({ name: agentName(t.agent), reads: t.agent === CLAUDE ? false : (offered?.find((o) => o.agent === t.agent)?.readsRepository ?? null) })) } : {}),
  };
  /** The agents that read a repository attached to a chat, by name, as their last check said. */
  const readers = (offered ?? []).filter((o) => o.readsRepository === true).map((o) => o.name);
  const readAttached = repo.kind === "none" && readPick.kind !== "none";
  const chatting = !inRepository(repo);
  const peerWarnings = chatting ? [] : issueWarnings(peers, { attached: kind === "run" ? (issue.attached?.number ?? null) : null, message: prompt });
  // A run may take over another workbench's claim on its issue once the claim is old (Peers P3); only those still offered are sent.
  const offeredClaims = chatting || kind !== "run" ? [] : oldClaims(peers, { attached: issue.attached?.number ?? null, message: prompt });
  const takeOver = takenOver.filter((branch) => offeredClaims.some((c) => c.branch === branch));
  // A chat whose agent cannot answer is blocked like one whose Claude Code cannot: the reason ends with the link to connect one.
  const stopReason = blockedBy(facts) ?? (chatting && !targets.ok ? { reason: targets.why, required: null, connect: true as const } : null);
  const askedCount = chatting && targets.ok ? targets.targets.length : 1;
  /** While a chat reply runs and the composer would send a chat, the button is Stop. */
  const showStop = chatting && running;

  /** Send a chat message to the agents asked, or, with `compare`, ask one to compare a round's answers. */
  const sendChat = (text: string, to: readonly ChatTarget[], compare?: number, repository?: string): void => {
    setError(null);
    setStarting(true);
    // Whoever sends wants to see the answer: the transcript follows again.
    jumpToLatest();
    const started = sendChatMessage({ prompt: text, conversation: conversationRef.current, agents: to, ...(compare === undefined ? {} : { compare }), ...(repository === undefined ? {} : { repository }) });
    const turns = started.then((replies) => replies.map(({ attemptId, turn }) => ({ attemptId, turn })));
    startRef.current = turns;
    started.then(
      (replies) => {
        // What each reply answers is known now, so the screen never shows what Botbench framed for an agent.
        setInfos((have) => {
          const next = new Map(have);
          for (const r of replies) next.set(r.attemptId, { agent: r.agent, model: r.model, round: r.roundId === null ? null : { id: r.roundId, kind: compare === undefined ? "ask" : "compare", message: text, compares: compare ?? null } });
          return next;
        });
        const ids = replies.map((r) => r.attemptId).filter((id) => !conversationRef.current.includes(id));
        const next = [...conversationRef.current, ...ids];
        setConversation(next);
        saveConversation(next);
        setAsked((have) => ({ ...have, ...Object.fromEntries(replies.map((r) => [r.attemptId, r.model])) }));
        setActive(replies.map(({ attemptId, turn }) => ({ attemptId, turn })));
        // The chat is stored now, and the first run is over for good: New chat does not bring the lines back.
        setFirstRun(false);
        setStarting(false);
        if (compare === undefined) setPrompt("");
        // Events stored before the attempts were known here may have been missed by a stream that was reconnecting.
        for (const { attemptId } of replies) getTranscript(attemptId).then((transcript) => setEvents((have) => mergeEvents(have, transcript.events)), () => {});
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
    const action = sendFor(facts, { preapproved: repository.listed?.commands ?? [], reviewer: review.choice(), delivery, oneTask, takeOver, builder: chosenBuilder });
    if (action.do === "focus") return promptRef.current?.focus();
    if (action.do === "blocked") return;
    if (action.do === "chat") return targets.ok ? sendChat(action.prompt, targets.targets, undefined, action.repository) : undefined;
    if (action.do === "task") return startWork("task", () => startTask(action.repo, action.prompt, action.model, action.preapproved, action.agent).then(({ taskId }) => `#/tasks/${taskId}`));
    const { do: _, ...run } = action;
    startWork("run", () => startRun(run).then(({ runId }) => `#/runs/${runId}`));
  };

  /** Stop the running turns: every one, or `only` one agent's. */
  const stop = (only?: number): void => {
    if (stopping && only === undefined) return;
    if (only === undefined) setStopping(true);
    // A turn that is still being started is stopped as soon as its attempt is known.
    const target = working.length > 0 ? Promise.resolve(working) : (startRef.current ?? Promise.resolve([]));
    target.then(
      (turns) =>
        Promise.all(
          turns
            .filter((t) => only === undefined || t.attemptId === only)
            .map(({ attemptId }) =>
              interruptTurn(attemptId).catch((err: unknown) => {
                // 409: the turn ended on its own first, which the transcript already shows.
                if (err instanceof ApiError && err.status === 409) return;
                setStopping(false);
                if (err instanceof ApiError && err.status === 401) return onSignedOut();
                const who = agentName(infos.get(attemptId)?.agent ?? CLAUDE);
                setError(err instanceof ApiError ? `${who} was not stopped. ${err.message}` : `${who} was not stopped: Botbench could not be reached.`);
              }),
            ),
        ),
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
    setActive([]);
    // A new chat reads no repository until one is chosen for it.
    setReadPick({ kind: "none" });
    setError(null);
    jumpToLatest();
    promptRef.current?.focus();
  };

  const nameOf = useCallback((id: string) => modelName(models.list, id), [models.list]);
  const claudeStatus = agentStatus(driver, driverFailed);
  const problem = HEADER_PROBLEM[claudeStatus];
  // On a first run, an empty chat shows what to do first and, when the chat asks Claude Code (as it does until another
  // agent is chosen), a line on it: signed in, or, under the header's line that names what is wrong, where to connect
  // one. Three short lines at most above the box.
  const welcome = firstRun === true && chatting && shown.length === 0 ? { agent: asksClaude ? agentLine(claudeStatus) : null } : null;
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
  const chip = chatting ? chatChip(agents, models) : chipWords(chipModel({ run, sameBuild, plan: choiceName(models), build: choiceName(buildModels) }), "Claude Code");
  const values: Record<Row, string> = {
    repository: repoName(repo, known),
    read: readName(readPick, known),
    kind: kind === "task" ? "One task" : "Plan a run",
    builder: builderName(chosenBuilder),
    spec: specPath.trim() === "" ? "None" : (specPath.trim().split("/").at(-1) ?? specPath.trim()),
    mode: kind === "task" ? "Manual" : (MODES.find((m) => m.mode === mode)?.name ?? "Reading"),
    tasks: oneTask ? "One task" : "Several",
    review: review.offer.state === "checking" ? "Checking" : review.words,
    delivery: delivery === "branch" ? "Keep the branch" : "Open a pull request",
    commands: commandsWords(repository.listed?.commands.length ?? 0),
    models: chatting ? agentRowValue(agents.choice.pick) : chipModel({ run, sameBuild, plan: choiceName(models), build: choiceName(buildModels) }),
    issue: issueWords(issue.attached),
  };
  const rows = rowsFor({ repo, kind, reviewOffered: !(review.offer.state === "not-offered" && review.offer.none), commandsKnown: repository.listed !== null, issueOffered: issue.source.state === "offered", builderOffered: codexBuilds });
  // Come to start a task or a run, the box is named for it while the repository is still to be chosen.
  const label = repo.kind === "none" ? (agents.choice.pick.kind === "several" ? "Message several agents" : `Message ${agentName(agents.choice.pick.agent)}`) : kind === "task" ? "Describe the task" : "Describe what to plan";
  const describedBy = [stopReason !== null ? "composer-reason" : null, error !== null ? "composer-error" : null].filter((id) => id !== null).join(" ") || undefined;
  const builderDown = builder.state !== "ready";
  const name = repoName(repo, known);

  return (
    <Frame
      current="turn"
      fill
      showing={waitingHere.map((approval) => approval.id)}
      banner={connected ? undefined : <StreamBanner />}
      actions={
        conversation.length > 0 && (
          <button type="button" aria-label="New chat" disabled={running} onClick={newChat} className="ds-app-header__action">
            <Icon name="plus" className="ds-app-header__icon" />
          </button>
        )
      }
    >
      <main className="flex min-h-0 min-w-0 flex-col">
        {/* The screen is its transcript and its message box: the view's one h1 is for assistive technology only. */}
        <PageHeader title="Chat" hidden />
        {problem !== null && (
          <div className="ds-container pt-md">
            <p data-testid="driver-state" className="ds-composer__reason">
              {problem}
            </p>
          </div>
        )}

        <div ref={scrollerRef} role="region" aria-label="Transcript" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
          <div ref={setLog} className="ds-container pb-lg">
            {shown.length > 0 ? (
              <Transcript
                events={chat.events}
                asking={asking}
                working={running && working.length <= 1 ? (waitingHere.some((a) => working.some((w) => w.attemptId === a.attemptId)) && !stopping ? `${agentName(CLAUDE)} is waiting for your answer.` : stopping ? `Stopping ${agentName(infos.get(working[0]?.attemptId ?? 0)?.agent ?? CLAUDE)}.` : `${agentName(infos.get(working[0]?.attemptId ?? 0)?.agent ?? (askedCount === 1 && targets.ok ? targets.targets[0]!.agent : CLAUDE))} is working.`) : null}
                modelName={nameOf}
                modelDiffers={differs}
                who={chat.who}
                after={
                  <>
                    {/* A request whose place in the transcript has not arrived yet still shows its card. */}
                    {waitingHere.filter((a) => !askedAt.has(`${a.attemptId}:${a.toolCallId}`)).map((a) => (
                      <li key={`asked-${a.id}`}>{cardOf(a)}</li>
                    ))}
                    {working.length > 1 &&
                      working.map(({ attemptId }) => (
                        <li key={`working-${attemptId}`} className="ds-split">
                          <p className="ds-streaming ds-streaming--row">
                            <span role="status">{`${agentName(infos.get(attemptId)?.agent ?? CLAUDE)} is working.`}</span>
                          </p>
                          <button type="button" className="ds-button ds-button--small" onClick={() => stop(attemptId)}>
                            Stop {agentName(infos.get(attemptId)?.agent ?? CLAUDE)}
                          </button>
                        </li>
                      ))}
                    {chat.compare !== null && !running && <CompareAction agents={agents} claude={models} onCompare={(to) => sendChat("", [to], chat.compare!.roundId)} busy={starting} />}
                  </>
                }
              />
            ) : welcome !== null ? (
              // A first run: at most two plain lines, no tour and nothing over the screen. Gone once a chat, task or run is stored.
              <div data-testid="first-run" className="ds-stack ds-gap-xs pt-md">
                <p className="ds-composer__reason">{FIRST_STEP}</p>
                {welcome.agent !== null && (
                  <p data-testid="first-run-agent" className="ds-composer__reason">
                    {welcome.agent.connect ? <ConnectAgent first /> : welcome.agent.words}
                  </p>
                )}
              </div>
            ) : (
              // An empty chat shows nothing above the box but a chat's request still waiting. Work in a repository says, in one muted line, where and what follows.
              waitingHere.length > 0 ? (
                <ol className="ds-stack ds-gap-sm pt-md">
                  {waitingHere.map((a) => (
                    <li key={`asked-${a.id}`}>{cardOf(a)}</li>
                  ))}
                </ol>
              ) : !chatting && (
                <p data-testid="composer-about" className="ds-composer__reason pt-md">
                  {kind === "task"
                    ? `A task in ${name}: ${builderName(chosenBuilder)} works on a new branch, in a separate copy of the repository (a git worktree). Your own files and your branch are not touched.`
                    : `A run in ${name}: Claude Code plans ${oneTask ? "one task" : "tasks"} first, reading a copy it cannot change.${chosenBuilder === "codex" ? " Codex builds them." : ""} ${mode === "full" || (mode === "semi" && issue.attached === null) ? "Building starts on the plan without your approval." : "Nothing is built until you approve the plan."}${delivery === "pull_request" ? " Each accepted task is then opened as a pull request." : ""}${claimNotice({ claimIssues: repository.listed?.claimIssues === true, delivery, attached: issue.attached?.number ?? null, message: prompt })}`}
                </p>
              )
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
                      <span className="ds-visually-hidden">Agent and model: </span>
                      {chip.value}
                      {chip.qualifier !== null && (
                        <>
                          {" "}
                          <span className="ds-composer__qualifier">{chip.qualifier}</span>
                        </>
                      )}
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
                <BusyButton busy={stopping} busyLabel="Stopping" onClick={() => stop()} aria-describedby="composer-reason">
                  Stop
                </BusyButton>
              ) : (
                <BusyButton type="submit" variant="primary" busy={starting} busyLabel={chatting ? "Sending" : "Starting"} disabled={stopReason !== null} aria-describedby={describedBy} {...(chatting && askedCount > 1 ? { "aria-label": sendWords(askedCount).label } : {})}>
                  Send
                </BusyButton>
              )}
            </div>
          </div>
          {showStop ? (
            <p id="composer-reason" className="ds-composer__reason">
              {working.length > 1 ? "The agents are working. You can send again when each has answered or stopped." : `${agentName(infos.get(working[0]?.attemptId ?? 0)?.agent ?? CLAUDE)} is working. You can send again when it has answered.`}
            </p>
          ) : (
            stopReason !== null && (
              <p id="composer-reason" data-testid={builderDown ? "driver-problem" : "composer-reason"} className="ds-composer__reason">
                {stopReason.reason}
                {stopReason.connect && <ConnectAgent />}
              </p>
            )
          )}
          {!showStop && run && modeLine(started) !== null && (
            <p data-testid="composer-mode" className="ds-composer__reason">
              {modeLine(started)}
            </p>
          )}
          {!showStop && stopReason === null && chatting && sendWords(askedCount).line !== null && (
            <p data-testid="asked-line" className="ds-composer__reason">
              {sendWords(askedCount).line}
            </p>
          )}
          {!showStop && readAttached && (
            <p data-testid="read-line" className="ds-composer__reason">
              {`For the chat to read: ${readName(readPick, known)}. ${READ_ABOUT}`}
            </p>
          )}
          {peerWarnings.map((line) => (
            <p key={line} data-testid="peer-warning" className="ds-composer__reason">
              {line}
            </p>
          ))}
          {offeredClaims.map((c) =>
            takeOver.includes(c.branch) ? (
              <p key={c.branch} data-testid="peer-taken-over" className="ds-composer__reason">
                <span data-ds-content="">{c.workbench}</span>
                {`'s claim on issue #${c.issue} is taken over: your run goes ahead, and Botbench leaves its branches as they are.`}
              </p>
            ) : (
              <ConfirmAction
                key={c.branch}
                label="Take over"
                opener={{ small: true, name: `Take over ${c.workbench}'s claim on issue #${c.issue}` }}
                title={`Take over ${c.workbench}'s claim?`}
                confirmLabel="Take over"
                cancelLabel={`Leave ${c.workbench}'s claim`}
                disabled={starting}
                testId="take-over-dialog"
                onConfirm={() => setTakenOver((have) => [...have, c.branch])}
              >
                <p>
                  <span data-ds-content="">{c.workbench}</span>
                  {` started on issue #${c.issue} ${agoWords(c.startedAt, Date.now())} and has opened no pull request. Your run goes ahead as if `}
                  <span data-ds-content="">{c.workbench}</span>
                  {" had not started. Botbench leaves its branches on the remote as they are, and pushes only a branch of your own. If that workbench is still working on the issue, the two of you may do the same work twice."}
                </p>
              </ConfirmAction>
            ),
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
            read: {
              pick: readPick,
              choose: setReadPick,
              otherPath: readOther,
              setOtherPath: (path) => {
                setReadOther(path);
                setReadPick({ kind: "other", path });
              },
              check: reading,
              readers,
            },
            kind,
            setKind,
            builder: chosenBuilder,
            setBuilder: setBuilderPick,
            specPath,
            setSpecPath,
            mode,
            setMode: (chosen: RunMode) => {
              setChosenMode({ repo: repoPath, mode: chosen });
              setModeChosenHere(true);
            },
            review,
            delivery,
            setDelivery,
            oneTask,
            setOneTask: setChosenOneTask,
            issue,
            models,
            sameBuild,
            setSameBuild,
            buildModels,
            agents,
          }}
        />
      </main>
    </Frame>
  );
}
