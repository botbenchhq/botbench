import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getTask, getTaskDiff, getTranscript, openEventStream, type FileChange, type StoredEvent, type TaskDetail } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ApprovalCard } from "../components/approval-card.tsx";
import { DraftPeerCard } from "../components/peer-card.tsx";
import { PeerCardsContext } from "../app/peer-cards.tsx";
import { DiffLine } from "../components/diff.tsx";
import { Icon } from "../components/icon.tsx";
import { agentName, CHECKS_LIMITS, CHECKS_LINE, ChecksResult, CommandRounds, FixesEvidence, latestRound, MachineChecksNote, REVIEW_LIMITS, REVIEW_LINE, ReviewEvidence, reviewerWords } from "../components/evidence.tsx";
import { Alert, Frame, Page, PageHeader, StreamBanner } from "../components/header.tsx";
import { OutsideText } from "../components/outside-text.tsx";
import { BranchCopy, ReviewDecision } from "../components/decision.tsx";
import { modeSentence } from "../app/run-words.ts";
import { DiscardSection } from "../components/discard.tsx";
import { PullRequestSection } from "../components/pull-request.tsx";
import { modelName, modelState, sessionModel, useModelList } from "../components/model-picker.tsx";
import { ResumeControl } from "../components/resume.tsx";
import { TaskNote } from "../components/task-note.tsx";
import { MoveTask } from "../components/move-task.tsx";
import { MainUpdateSection } from "../components/main-update.tsx";
import { sessionAgent, sessionsLine, shownAttempts } from "../app/handoff-words.ts";
import { answeredOther, fileMarks, fileMarksLine, notMergedLine, statusSentence, taskTitle, waitingWords } from "../components/task-status.ts";
import { folderName } from "../app/composer.ts";
import { overlapLines } from "../app/peers.ts";
import { usePeersOf } from "../components/other-workbenches.tsx";
import { CheckTogether } from "../components/check-together.tsx";
import { mergeEvents, Transcript } from "../components/transcript.tsx";
import { counted, duration, number, plural } from "../app/format.ts";
import { oldestCommand, runningCommands, runningWords, type RunningCommand } from "../../../src/engine/command-limit.ts";
import { MakeRunSection } from "../components/make-run.tsx";
import { offersRun } from "../app/run-source.ts";
import { firstLine } from "../../../src/shorten.ts";

/** A time in the transcript's own words ("42s", "2m 14s"). */
const shortTime = (ms: number): string => duration(ms, "short").words;

/** What is known about one file's diff: being fetched, fetched, or why it could not be. */
type DiffState = { kind: "loading" } | { kind: "loaded"; diff: string; truncated: boolean } | { kind: "failed"; why: string };

/** The task's number and repository, and its run's mode for a task of a plan: in the header, or after a waiting card. */
function TaskLines({ task, id, className }: { task: TaskDetail; id: number; className?: string }) {
  return (
    <>
      <p data-testid="task-name" className={className}>
        {`Task ${id} · `}
        <span data-ds-content="">{folderName(task.repo)}</span>
      </p>
      {task.ofPlan !== null && (
        <p data-testid="task-mode" className={className}>
          {modeSentence(task.mode, task.issueHosts)}
        </p>
      )}
    </>
  );
}

/** The files whose diff wraps: prose, by their extension. */
const PROSE = /\.(md|txt)$/i;

/** A unified diff as text, in a block that scrolls sideways on its own so the page never does; prose wraps instead. */
function Diff({ path, state }: { path: string; state: DiffState }) {
  if (state.kind === "loading") {
    return (
      <figure className="ds-diff" aria-busy="true">
        <p role="status" className="ds-diff__note">
          Loading the changes.
        </p>
      </figure>
    );
  }
  if (state.kind === "failed") {
    return (
      <figure className="ds-diff">
        <p role="alert" className="ds-diff__note">{`The changes could not be loaded. ${state.why}`}</p>
      </figure>
    );
  }
  const lines = state.diff.replace(/\n$/, "").split("\n");
  // Prose wraps to the screen's width; code keeps its lines whole, scrolling sideways inside the diff (index.css).
  return (
    <figure className={PROSE.test(path) ? "ds-diff bb-diff-prose" : "ds-diff"}>
      <pre data-testid="diff-scroll" tabIndex={0} role="group" data-ds-content-label="" aria-label={`Changes in ${path}`} className="ds-diff__body">
        <code data-testid="diff" data-ds-content="" className="ds-diff__lines">
          {lines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </code>
      </pre>
      {state.truncated && <p className="ds-diff__note">These changes are longer than Botbench shows here. All of them are on the branch.</p>}
    </figure>
  );
}

/** A file's line counts: each a sign and a number, finished in words for a screen reader. */
function Counts({ file }: { file: FileChange }) {
  if (file.binary) return <>binary</>;
  return (
    <span className="ds-diff__counts">
      <span className="ds-diff__added">
        {`+${file.added}`}
        <span className="ds-diff__label">{plural(file.added, " line added", " lines added")}</span>
      </span>
      <span className="ds-diff__removed">
        {`−${file.removed}`}
        <span className="ds-diff__label">{plural(file.removed, " line removed", " lines removed")}</span>
      </span>
    </span>
  );
}

/**
 * One refused request in the task's list: its first line, shortened, and when that is not all of it, a disclosure with
 * the whole of it and how many lines it has. A here-document of thousands of characters stays one line until opened.
 */
function RefusedCommand({ command }: { command: string }) {
  const first = firstLine(command, 100);
  const lines = command.trim().split("\n").length;
  if (first === command.trim()) return <code data-testid="refused-command" data-ds-content="">{first}</code>;
  return (
    <details data-testid="refused-command" className="ds-disclosure">
      <summary className="ds-disclosure__summary">
        <code data-ds-content="">{first}</code>
        <span className="ds-disclosure__meta">{lines === 1 ? `${number(command.trim().length)} characters` : `${number(lines)} lines`}</span>
      </summary>
      <div className="ds-disclosure__content">
        <figure className="ds-code-block">
          <pre data-testid="refused-full" data-ds-content="" className="ds-code-block__body">
            <code>{command}</code>
          </pre>
        </figure>
      </div>
    </details>
  );
}

/** How long a command has run, ticking each second, against its own time limit (engine/command-limit.ts). */
function RunningFor({ agent, command }: { agent: string; command: RunningCommand }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span data-testid="running-for">{` ${runningWords(agent, command, now, shortTime).time}`}</span>;
}

/** `discard`: the owner chose Discard from the task's More menu on Work, so its confirmation opens once the task is read. */
export function TaskScreen({ id, discard = false, onSignedOut }: { id: number; discard?: boolean; onSignedOut: () => void }) {
  // The address goes back to the task's own, so a reload or Back does not ask again.
  useEffect(() => {
    if (discard) window.history.replaceState(null, "", `#/tasks/${id}`);
  }, [discard, id]);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [connected, setConnected] = useState(true);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const [open, setOpen] = useState<string[]>([]);
  const missing = useRef(false);
  const models = useModelList(onSignedOut);
  const nameOf = useCallback((model: string) => modelName(models, model), [models]);
  /** Counts reads of the task, so an answer that arrives after a newer one was asked for is dropped. */
  const reads = useRef(0);

  /** Read the task as it stands, and its attempt's stored transcript. */
  const load = useCallback((): void => {
    if (missing.current) return;
    const read = ++reads.current;
    const failed = (what: string) => (err: unknown): void => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      if (read !== reads.current) return;
      setProblem(err instanceof ApiError ? `${what} could not be read. ${err.message}` : `${what} could not be read: Botbench could not be reached.`);
    };
    getTask(id).then((next) => {
      // Several states can be announced within milliseconds; only the newest read may set what the screen shows.
      if (read !== reads.current) return;
      setTask(next);
      setProblem(null);
      // Stored events only ever add up, so a transcript is folded in whichever read fetched it. After a move to another
      // agent, the session each move left is read too, so the transcript shows both agents.
      for (const attempt of shownAttempts(next)) getTranscript(attempt).then((transcript) => setEvents((have) => mergeEvents(have, transcript.events)), failed("The transcript"));
    }, (err: unknown) => {
      if (err instanceof ApiError && err.status === 404) {
        missing.current = true;
        return setProblem(`There is no task ${id}.`);
      }
      failed("The task")(err);
    });
  }, [id, onSignedOut]);

  // Follow the stream from now on. The task and its stored transcript are read each time the stream comes up
  // and each time the task reaches a new state, so nothing that happened in between is missed.
  useEffect(() => {
    load();
    return openEventStream(0, {
      onEvent: (event) => setEvents((have) => mergeEvents(have, [event])),
      onConnection: (isConnected) => {
        setConnected(isConnected);
        if (isConnected) load();
      },
      onSignedOut,
      onTask: (announcement) => {
        if (announcement.taskId === id) load();
      },
    });
  }, [id, load, onSignedOut]);

  // This task's requests that wait for an answer, oldest first. One card at a time: the oldest.
  const { pending } = useContext(ApprovalsContext);
  const peerCards = useContext(PeerCardsContext).cards;
  const waiting = useMemo(() => (pending ?? []).filter((approval) => approval.taskId === id), [pending, id]);
  const asking = waiting[0];
  // The task starts and stops waiting as its requests come and go, so it is read again when they do.
  useEffect(() => load(), [load, asking?.id]);

  const attemptId = task?.attemptId ?? null;
  const shownIds = useMemo(() => (task === null ? [] : shownAttempts(task)).join(","), [task]);
  const shown = useMemo(() => {
    const ids = new Set(shownIds.split(",").filter((id) => id !== "").map(Number));
    return events.filter((e) => ids.has(e.attemptId));
  }, [events, shownIds]);
  // The session the task names now: what is said of the model and of the agent at work is read from it alone.
  const current = useMemo(() => shown.filter((e) => e.attemptId === attemptId), [shown, attemptId]);

  // The model that answered is the one the driver's own session event names; what was asked for is on the task.
  const session = useMemo(() => sessionModel(current), [current]);

  /** Follows a file's disclosure as the browser opens and closes it; the diff is read the first time it opens. */
  const toggled = (file: string, isOpen: boolean): void => {
    if (isOpen === open.includes(file)) return;
    if (!isOpen) return setOpen(open.filter((f) => f !== file));
    setOpen([...open, file]);
    if (diffs[file]?.kind === "loaded") return;
    setDiffs((have) => ({ ...have, [file]: { kind: "loading" } }));
    getTaskDiff(id, file).then(
      ({ diff, truncated }) => setDiffs((have) => ({ ...have, [file]: { kind: "loaded", diff, truncated } })),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setDiffs((have) => ({ ...have, [file]: { kind: "failed", why: err instanceof ApiError ? err.message : "Botbench could not be reached." } }));
      },
    );
  };
  // Between the end of the turn and Botbench's commit the task is still building, but Claude Code is no longer working.
  // While a request waits, its card says so: the transcript is still live, with no line of its own ("").
  // Its last message's turn has not ended: with the owner's note sent as the next message, that is the note's.
  const lastSent = current.findLastIndex((e) => e.type === "user_prompt");
  const turnOn = task?.status === "building" && !task.resuming && attemptId !== null && !current.slice(Math.max(lastSent, 0)).some((e) => e.type === "turn_ended");
  // The command the agent is running now, which may print nothing for minutes: the line says which, and for how long.
  const command = turnOn ? oldestCommand(runningCommands(current)) : null;
  const working = turnOn ? (asking !== undefined ? "" : command !== null ? runningWords(agentName(task!.builder), command, Date.now(), shortTime).line : `${agentName(task!.builder)} is working.`) : null;
  // The branch is where the decision needs it once the task is ready for review (and, decided, in the outcome); before, it is a detail.
  const branchInDetails = task !== null && task.branch !== null && task.decision === null && task.status !== "awaiting_decision" && task.remains?.discardedAt == null;
  // At review time: another workbench's open pull request that changes the same files, from the short-lived view of the remote.
  const peers = usePeersOf(task?.status === "awaiting_decision" ? task.repo : "", onSignedOut);
  const overlaps = task?.status === "awaiting_decision" && task.files !== null ? overlapLines(peers, task.files.map((f) => f.path)) : [];
  // The review decision is drawn from ready for review on: it carries the checks' and the review's findings, each said once.
  const decisionShown = task !== null && (task.decision !== null || task.status === "awaiting_decision");

  // An agent's draft to the paired workbench from this task waits on its card here, where its approvals are.
  const drafts = (peerCards ?? []).filter((card) => card.direction === "out" && card.taskId === id);

  return (
    <Frame current={null} banner={connected ? undefined : <StreamBanner />} showing={waiting.map((approval) => approval.id)}>
      <Page>
        {/* The page header comes first and holds the view's one h1, also while the task is being read or cannot be: the task's own words, once read. */}
        <PageHeader title={taskTitle(id, task?.prompt ?? null)} tab={`Task ${id}`} theirs={task !== null}>
          {/* While a card waits, the header holds the title alone and the card comes next; these lines follow the card. */}
          {task !== null && asking === undefined && (
            <>
              <TaskLines task={task} id={id} className="ds-page-header__description" />
              <p data-testid="task-status" role="status" className="ds-page-header__description">
                {statusSentence(task)}
              </p>
              {task.restartLine !== null && (
                <p data-testid="task-restart" className="ds-page-header__description">
                  {task.restartLine}
                </p>
              )}
            </>
          )}
        </PageHeader>
        {/* A request that waits for the owner comes first after the title: nothing else on the screen is as urgent. The card says what the task waits for. */}
        {task !== null && asking !== undefined && (
          <>
            <ApprovalCard key={asking.id} approval={asking} more={waiting.length - 1} on="task" onSignedOut={onSignedOut} />
            <TaskLines task={task} id={id} />
            {task.restartLine !== null && <p data-testid="task-restart">{task.restartLine}</p>}
          </>
        )}
        {task !== null &&
          drafts.map((card) => (
            <DraftPeerCard key={card.messageId} card={card} primary={asking === undefined && task.status === "drafted" && drafts.length === 1} onSignedOut={onSignedOut} />
          ))}
        {task !== null && task.outsideText && <OutsideText issue={task.issue} given={task.givenMessage} what="task" />}
        {problem !== null && (
          <Alert tone="error" role="alert">
            {problem}
          </Alert>
        )}
        {task === null ? (
          problem === null && (
            <p role="status" className="ds-spinner">
              Reading the task.
            </p>
          )
        ) : (
          <>
            {/* The model asked for is the first agent's: after a move to another agent it says nothing of the one at work now. */}
            {task.handoffs.length === 0 && answeredOther(models, session?.model ?? null, task.requestedModel) && (
              <dl className="ds-key-value">
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Model</dt>
                  <dd data-testid="task-model" className="ds-key-value__value">{`${modelState(session, nameOf)}. You asked for: ${nameOf(task.requestedModel!)}.`}</dd>
                </div>
              </dl>
            )}

            {task.preapproved.length > 0 && (
              <section className="ds-stack ds-gap-sm">
                <h2>Allowed for this task</h2>
                <ul data-testid="task-preapproved" className="ds-list ds-list--dense">
                  {task.preapproved.map((command) => (
                    <li key={command} className="ds-list__row">
                      <div className="ds-list__content">
                        <span className="ds-list__body">
                          <code data-ds-content="" className="ds-list__primary">
                            {command}
                          </code>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <p>You listed these when you started the task. They run without asking, with further arguments too, unless Botbench's safety rules catch them (git push, sudo, deleting outside the task's copy and the like) or they are chained, piped or redirected: those still ask.</p>
              </section>
            )}

            {task.evidence.some((row) => row.kind === "setup") && (
              <section aria-labelledby="setup-heading" className="ds-stack ds-gap-sm">
                <h2 id="setup-heading">Setup</h2>
                <p>Botbench ran this repository's setup commands in the task's copy before Claude Code started, as your settings list them.</p>
                <CommandRounds lists={task.commandLists} rows={task.evidence.filter((row) => row.kind === "setup")} what={{ one: "setup command", many: "setup commands" }} />
              </section>
            )}

            {shown.length > 0 || working !== null ? (
              <section aria-label="Transcript">
                {sessionsLine(task.builder, task.earlierAttempts, task.handoffs.length > 0) !== null && <p data-testid="earlier-sessions">{sessionsLine(task.builder, task.earlierAttempts, task.handoffs.length > 0)}</p>}
                {/* One line for each move to another agent, in order. */}
                {task.handoffs.map((h) => (
                  <p key={h.at} data-testid="handoff-line" role="note">
                    {h.line}
                  </p>
                ))}
                {/* The model is named above when it is not the one asked for; the transcript adds no row of its own for it. */}
                <Transcript
                  events={shown}
                  working={working}
                  workingMore={command !== null && asking === undefined && <RunningFor agent={agentName(task.builder)} command={command} />}
                  modelName={nameOf}
                  modelDiffers={() => null}
                  who={(attempt) => sessionAgent(task, attempt)}
                  after={
                    task.status === "waiting_for_limit" && (
                      <li data-testid="usage-limit-wait" className="ds-message">
                        <p role="status" className="ds-message__body">
                          {waitingWords(task.retryAt)}
                        </p>
                      </li>
                    )
                  }
                />
              </section>
            ) : (
              attemptId === null && (
                <ol className="ds-stack ds-gap-sm">
                  <li className="ds-message ds-message--user">
                    <span className="ds-message__label">You</span>
                    <p data-testid="task-prompt" data-ds-content="" className="ds-message__body">
                      {task.prompt}
                    </p>
                  </li>
                </ol>
              )
            )}

            {/* On a task that is ready for review the note box comes just before the decision, as the other way on from it. */}
            {task.status !== "awaiting_decision" && <TaskNote task={task} onChanged={load} onSignedOut={onSignedOut} />}
            <MoveTask task={task} onMoved={load} onSignedOut={onSignedOut} />

            {task.filesProblem !== null && (
              <Alert tone="error" role="alert">
                {task.filesProblem}
              </Alert>
            )}
            {(task.checks !== null || task.status === "verifying" || task.evidence.some((row) => row.kind === "check")) && (
              <section aria-labelledby="checks-heading" className="ds-stack ds-gap-sm">
                <h2 id="checks-heading">Checks</h2>
                {task.checks !== null && <ChecksResult checks={task.checks} rows={latestRound(task.evidence.filter((row) => row.kind === "check"))} />}
                {task.checkFixLine !== null && (
                  <p data-testid="check-fix-outcome" role="status">
                    {task.checkFixLine}
                  </p>
                )}
                {task.checks !== "none" && <p data-testid="checks-line">{CHECKS_LINE}</p>}
                <CommandRounds testId="checks" lists={task.commandLists} rows={task.evidence.filter((row) => row.kind === "check")} what={{ one: "check", many: "checks" }} failedFirst again={task.rerunRounds} />
                <MachineChecksNote rows={latestRound(task.evidence.filter((row) => row.kind === "check"))} />
              </section>
            )}
            {task.checks !== null && task.checks !== "none" && <CheckTogether taskId={task.id} repo={task.repo} ready={task.status === "awaiting_decision"} onSignedOut={onSignedOut} />}

            {task.reviewer !== null && (task.review !== null || task.status === "reviewing") && (
              <section aria-labelledby="review-heading" data-testid="review" className="ds-stack ds-gap-sm">
                <h2 id="review-heading">{`${agentName(task.reviewer.agent)}'s review`}</h2>
                {/* The decision below says it once; only without it is it said here. */}
                <p data-testid="review-by">{`By ${reviewerWords(task.review ?? task.reviewer)}.${decisionShown ? "" : ` ${REVIEW_LINE}`}`}</p>
                {task.reviewLine !== null && (
                  <p data-testid="review-outcome" role="status">
                    {task.reviewLine}
                  </p>
                )}
                {task.reviews.length > 0 && (
                  <ol data-testid="review-rounds" className="ds-stack ds-gap-sm">
                    {task.reviews.map((review) => {
                      const fix = task.refinements.find((r) => r.round === review.round);
                      return (
                        <li key={review.id} data-testid="review-round" className="ds-stack ds-gap-sm">
                          <h3>{`Review ${review.round}`}</h3>
                          <ReviewEvidence review={review} />
                          {fix !== undefined && (
                            <div data-testid="fixes-round" className="ds-stack ds-gap-sm">
                              <h3>{`${agentName("claude-code")}'s fixes ${fix.round}`}</h3>
                              <FixesEvidence fix={fix} />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {task.status === "reviewing" && <p role="status">{`${agentName(task.reviewer.agent)} is reading the changes.`}</p>}
                {task.status === "building" && !task.onNoteRound && task.reviews.length > task.refinements.length && (
                  <p role="status" data-testid="fixes-working">{`${agentName("claude-code")} is working on fixes: round ${task.reviews.length} of up to ${task.maxRefineRounds}.`}</p>
                )}
              </section>
            )}

            {task.files !== null && (
              <section className="ds-stack ds-gap-sm">
                <h2>Changed files</h2>
                {task.files.length === 0 ? (
                  <p data-testid="no-changes">No file was changed, so the branch is still at the commit it started from.</p>
                ) : (
                  <>
                  {fileMarksLine(task.files) !== null && <p data-testid="file-marks">{fileMarksLine(task.files)}</p>}
                  <ul data-testid="changed-files" className="ds-list">
                    {task.files.map((file) => {
                      const expanded = open.includes(file.path);
                      return (
                        <li key={file.path} className="ds-list__row">
                          <details open={expanded} onToggle={(e) => toggled(file.path, e.currentTarget.open)} className="ds-disclosure ds-disclosure--row">
                            <summary className="ds-disclosure__summary">
                              <code data-ds-content="">{file.path}</code>
                              {fileMarks(file).map((mark) => (
                                <span key={mark} className="ds-badge ds-badge--warning">
                                  <Icon name={mark === "Protected" ? "shield" : "circle-alert"} className="ds-badge__icon" />
                                  {mark}
                                </span>
                              ))}
                              <span className="ds-disclosure__meta">
                                {file.status} <Counts file={file} />
                              </span>
                            </summary>
                            <div className="ds-disclosure__content">{expanded && <Diff path={file.path} state={diffs[file.path] ?? { kind: "loading" }} />}</div>
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                  </>
                )}
              </section>
            )}

            {task.refused.length > 0 && (
              <section aria-labelledby="refused-heading" data-testid="refused" className="ds-stack ds-gap-sm">
                <h2 id="refused-heading">Refused without asking</h2>
                <p>{`Botbench refused ${plural(task.refused.length, "this request", `these ${number(task.refused.length)} requests`)} during this task without asking you. Each shows its first line; open one to see all of it.`}</p>
                <ul className="ds-stack ds-gap-xs">
                  {task.refused.map((command, i) => (
                    <li key={i}>
                      <RefusedCommand command={command} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {task.decision === null &&
              task.branch !== null &&
              task.remains?.discardedAt == null && (
                <section className="ds-stack ds-gap-sm">
                  {task.status === "awaiting_decision" && <BranchCopy branch={task.branch} />}
                  <p data-testid="not-merged">{notMergedLine(task)}</p>
                  <details data-testid="can-do" className="ds-disclosure">
                    <summary className="ds-disclosure__summary">What Claude Code can do here</summary>
                    <div className="ds-disclosure__content">
                      <p data-testid="can-do-text">
                        {`Claude Code may read and change files inside this task's copy of the project without asking. ${task.mode === "manual" ? `A shell command kept inside this copy runs without asking, apart from those the safety rules always ask you about; with Ask before every command on in Settings, every one waits for your answer first, unless you ${task.preapproved.length > 0 ? "listed it above or " : ""}chose Always allow for it (see Permissions). Botbench sends you anything else it wants to do as well.` : task.mode === "semi" ? "A shell command kept inside this copy runs without asking, apart from those the safety rules always ask you about; Botbench sends you anything else it wants to do as well." : "Its run is fully autonomous, so its shell commands run without asking, and what would need your answer is refused instead: those the safety rules always ask about, and anything else it wants to do."} The separate copy (a git worktree) keeps changes apart from your own files. A command you allow${task.preapproved.length > 0 ? " or list in advance" : ""} runs in Claude Code's sandbox: it cannot read your sign-ins, your keys or the rest of your home folder (apart from this repository's git data and your git settings), can change files only in this copy and a temporary folder, and reaches the internet only at hosts allowed for this repository in Botbench's settings file.`}
                      </p>
                    </div>
                  </details>
                </section>
              )}

            {/* Just before the decision, which is where delivery starts: the branch against main, and bringing it up to date. */}
            <MainUpdateSection task={task} onChanged={load} onSignedOut={onSignedOut} />
            {task.status === "awaiting_decision" && <TaskNote task={task} onChanged={load} onSignedOut={onSignedOut} />}

            {/* One section from ready for review on: Accept and Reject, then, once decided, the result in their place. */}
            {decisionShown && (
              <ReviewDecision task={task} onDecided={load} onSignedOut={onSignedOut}>
                {overlaps.map((line) => (
                  <p key={line} data-testid="peer-overlap">
                    {line}
                  </p>
                ))}
                <p>{`${task.evidenceState?.state === "current" || task.evidenceState?.state === "none" ? "Accept keeps the branch for you to merge yourself and removes the task's copy of the project. Reject removes the copy too, and asks whether to keep the branch." : "Reject removes the task's copy of the project, and asks whether to keep the branch."}${task.pullRequest.choice === "pull_request" ? " This run then pushes an accepted task's branch and opens a pull request for it." : ""}`}</p>
                {/* What the checks found on the commit under review, failed checks included, is the Evidence line's, from the server. */}
                {task.leftovers !== null && task.leftovers.length > 0 && <p>{`The task's copy holds ${counted(task.leftovers.length, "file", "files")} that ${plural(task.leftovers.length, "is", "are")} not on the branch. Reject lists ${plural(task.leftovers.length, "it", "them")} before anything is removed.`}</p>}
              </ReviewDecision>
            )}

            {task.resumeNote !== null && (
              <section aria-labelledby="resume-heading" className="ds-stack ds-gap-sm">
                <h2 id="resume-heading">Resume</h2>
                <ResumeControl taskId={task.id} note={task.resumeNote} primary onResumed={load} onSignedOut={onSignedOut} />
              </section>
            )}

            {task.decision?.decision === "accept" && <PullRequestSection taskId={task.id} view={task.pullRequest} target={task.pullRequestTarget} onChanged={load} onSignedOut={onSignedOut} />}

            <DiscardSection task={task} startOpen={discard} onDiscarded={load} onSignedOut={onSignedOut} />

            {task.runsMade.length > 0 && (
              <section aria-labelledby="runs-made-heading" data-testid="runs-made" className="ds-stack ds-gap-sm">
                <h2 id="runs-made-heading">Runs made from this task</h2>
                <ul className="ds-list ds-list--dense">
                  {task.runsMade.map((runId) => (
                    <li key={runId} className="ds-list__row">
                      <a href={`#/runs/${runId}`} className="ds-list__link">
                        <span className="ds-list__body">
                          <span className="ds-list__primary">{`Run ${runId}`}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {offersRun(task.status) && <MakeRunSection taskId={task.id} repo={task.repo} />}

            <details data-testid="task-details" className="ds-disclosure">
              <summary className="ds-disclosure__summary">Details</summary>
              <div className="ds-disclosure__content ds-stack ds-gap-sm">
                <dl className="ds-key-value">
                  <div className="ds-key-value__item">
                    <dt className="ds-key-value__label">Repository</dt>
                    <dd data-testid="task-repo" data-ds-content="" className="ds-key-value__value ds-key-value__value--mono">
                      {task.repo}
                    </dd>
                  </div>
                </dl>
                {branchInDetails && <BranchCopy branch={task.branch!} />}
                {/* The full limits of the checks and the review, once, rather than under every result. */}
                {task.checks !== null && task.checks !== "none" && <p data-testid="checks-limits">{CHECKS_LIMITS}</p>}
                {task.reviewer !== null && task.review !== null && <p data-testid="review-limits">{`${agentName(task.reviewer.agent)}'s review: ${REVIEW_LIMITS}`}</p>}
              </div>
            </details>
          </>
        )}
      </Page>
    </Frame>
  );
}
