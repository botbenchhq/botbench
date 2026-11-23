import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getTask, getTaskDiff, getTranscript, openEventStream, type FileChange, type StoredEvent, type TaskDetail } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ApprovalCard } from "../components/approval-card.tsx";
import { DiffLine } from "../components/diff.tsx";
import { Icon } from "../components/icon.tsx";
import { agentName, CHECKS_RISK, ChecksResult, CommandRounds, FixesEvidence, latestRound, REVIEW_RISK, ReviewEvidence, reviewerWords } from "../components/evidence.tsx";
import { Alert, Frame, Page, PageHeader, StreamBanner } from "../components/header.tsx";
import { OutsideText } from "../components/outside-text.tsx";
import { BranchCopy, DecisionControls, DecisionOutcome } from "../components/decision.tsx";
import { modeSentence } from "../app/run-words.ts";
import { DiscardSection } from "../components/discard.tsx";
import { PullRequestSection } from "../components/pull-request.tsx";
import { modelName, modelState, sessionModel, useModelList } from "../components/model-picker.tsx";
import { ResumeControl } from "../components/resume.tsx";
import { TaskNote } from "../components/task-note.tsx";
import { answeredOther, fileMarks, fileMarksLine, notMergedLine, offersMerge, statusSentence, taskTitle, waitingWords } from "../components/task-status.ts";
import { folderName } from "../app/composer.ts";
import { overlapLines } from "../app/peers.ts";
import { usePeersOf } from "../components/other-workbenches.tsx";
import { CheckTogether } from "../components/check-together.tsx";
import { mergeEvents, Transcript } from "../components/transcript.tsx";

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
        <span className="ds-diff__label">{file.added === 1 ? " line added" : " lines added"}</span>
      </span>
      <span className="ds-diff__removed">
        {`−${file.removed}`}
        <span className="ds-diff__label">{file.removed === 1 ? " line removed" : " lines removed"}</span>
      </span>
    </span>
  );
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
      // Stored events only ever add up, so a transcript is folded in whichever read fetched it.
      if (next.attemptId !== null) getTranscript(next.attemptId).then((transcript) => setEvents((have) => mergeEvents(have, transcript.events)), failed("The transcript"));
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
  const waiting = useMemo(() => (pending ?? []).filter((approval) => approval.taskId === id), [pending, id]);
  const asking = waiting[0];
  // The task starts and stops waiting as its requests come and go, so it is read again when they do.
  useEffect(() => load(), [load, asking?.id]);

  const attemptId = task?.attemptId ?? null;
  const shown = useMemo(() => events.filter((e) => e.attemptId === attemptId), [events, attemptId]);

  // The model that answered is the one the driver's own session event names; what was asked for is on the task.
  const session = useMemo(() => sessionModel(shown), [shown]);

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
  const lastSent = shown.findLastIndex((e) => e.type === "user_prompt");
  const working = task?.status === "building" && !task.resuming && attemptId !== null && !shown.slice(Math.max(lastSent, 0)).some((e) => e.type === "turn_ended") ? (asking === undefined ? "Claude Code is working." : "") : null;
  // The branch is where the decision needs it once the task is ready for review (and, decided, in the outcome); before, it is a detail.
  const branchInDetails = task !== null && task.branch !== null && task.decision === null && task.status !== "awaiting_decision" && task.remains?.discardedAt == null;
  // At review time: another workbench's open pull request that changes the same files, from the short-lived view of the remote.
  const peers = usePeersOf(task?.status === "awaiting_decision" ? task.repo : "", onSignedOut);
  const overlaps = task?.status === "awaiting_decision" && task.files !== null ? overlapLines(peers, task.files.map((f) => f.path)) : [];

  return (
    <Frame current={null} banner={connected ? undefined : <StreamBanner />} showing={waiting.map((approval) => approval.id)}>
      <Page>
        {/* The page header comes first and holds the view's one h1, also while the task is being read or cannot be: the task's own words, once read. */}
        <PageHeader title={taskTitle(id, task?.prompt ?? null)} theirs={task !== null}>
          {/* While a card waits, the header holds the title alone and the card comes next; these lines follow the card. */}
          {task !== null && asking === undefined && (
            <>
              <TaskLines task={task} id={id} className="ds-page-header__description" />
              <p data-testid="task-status" role="status" className="ds-page-header__description">
                {statusSentence(task)}
              </p>
            </>
          )}
        </PageHeader>
        {/* A request that waits for the owner comes first after the title: nothing else on the screen is as urgent. The card says what the task waits for. */}
        {task !== null && asking !== undefined && (
          <>
            <ApprovalCard key={asking.id} approval={asking} more={waiting.length - 1} on="task" onSignedOut={onSignedOut} />
            <TaskLines task={task} id={id} />
          </>
        )}
        {task !== null && task.outsideText && <OutsideText issue={task.issue} what="task" />}
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
            {answeredOther(models, session?.model ?? null, task.requestedModel) && (
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
                {task.earlierAttempts > 0 && (
                  <p data-testid="earlier-sessions">{`This is Claude Code's latest session on this task. ${task.earlierAttempts === 1 ? "Its 1 earlier session is" : `Its ${task.earlierAttempts} earlier sessions are`} kept in Botbench's records, not shown here.`}</p>
                )}
                {/* The model is named above when it is not the one asked for; the transcript adds no row of its own for it. */}
                <Transcript
                  events={shown}
                  working={working}
                  modelName={nameOf}
                  modelDiffers={() => null}
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

            <TaskNote task={task} onChanged={load} onSignedOut={onSignedOut} />

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
                {task.checks !== "none" && <p>{CHECKS_RISK}</p>}
                <CommandRounds testId="checks" lists={task.commandLists} rows={task.evidence.filter((row) => row.kind === "check")} what={{ one: "check", many: "checks" }} failedFirst />
              </section>
            )}
            {task.checks !== null && task.checks !== "none" && <CheckTogether taskId={task.id} repo={task.repo} ready={task.status === "awaiting_decision"} onSignedOut={onSignedOut} />}

            {task.reviewer !== null && (task.review !== null || task.status === "reviewing") && (
              <section aria-labelledby="review-heading" data-testid="review" className="ds-stack ds-gap-sm">
                <h2 id="review-heading">{`${agentName(task.reviewer.agent)}'s review`}</h2>
                <p data-testid="review-by">{`By ${reviewerWords(task.review ?? task.reviewer)}. ${REVIEW_RISK}`}</p>
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
                {task.status === "building" && task.reviews.length > task.refinements.length && (
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

            {task.decision !== null ? (
              <section aria-labelledby="decision-heading" className="ds-stack ds-gap-sm">
                <h2 id="decision-heading">{task.decision.decision === "accept" ? (task.decision.decidedBy === "mode" ? "Accepted without you" : "Accepted") : "Rejected"}</h2>
                {task.decision.reasons !== null && <p data-testid="decided-by">{task.decision.reasons}</p>}
                <DecisionOutcome decision={task.decision} repo={task.repo} merge={offersMerge(task)} pushed={task.pullRequest.pushed ? task.pullRequest.remote : null} />
              </section>
            ) : (
              task.branch !== null && task.remains?.discardedAt == null && (
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
              )
            )}

            {task.resumeNote !== null && (
              <section aria-labelledby="resume-heading" className="ds-stack ds-gap-sm">
                <h2 id="resume-heading">Resume</h2>
                <ResumeControl taskId={task.id} note={task.resumeNote} primary onResumed={load} onSignedOut={onSignedOut} />
              </section>
            )}

            {task.decision?.decision === "accept" && <PullRequestSection taskId={task.id} view={task.pullRequest} target={task.pullRequestTarget} onChanged={load} onSignedOut={onSignedOut} />}

            <DiscardSection task={task} startOpen={discard} onDiscarded={load} onSignedOut={onSignedOut} />

            {task.status === "awaiting_decision" && (
              <section aria-labelledby="decide-heading" className="ds-stack ds-gap-sm">
                <h2 id="decide-heading">Your decision</h2>
                {overlaps.map((line) => (
                  <p key={line} data-testid="peer-overlap">
                    {line}
                  </p>
                ))}
                <p>{`Accept keeps the branch for you to merge yourself and removes the task's copy of the project. Reject removes the copy too, and asks whether to keep the branch.${task.pullRequest.choice === "pull_request" ? " This run then pushes an accepted task's branch and opens a pull request for it." : ""}${task.checks === "failed" ? " The checks failed; you can still accept or reject it." : ""}`}</p>
                {task.leftovers !== null && task.leftovers.length > 0 && <p>{`The checks left ${task.leftovers.length === 1 ? "1 file" : `${task.leftovers.length} files`} in the task's copy that ${task.leftovers.length === 1 ? "is" : "are"} not on the branch. Accept and Reject list ${task.leftovers.length === 1 ? "it" : "them"} before anything is removed.`}</p>}
                <DecisionControls taskId={task.id} leftovers={task.leftovers} primary onDecided={load} onSignedOut={onSignedOut} />
              </section>
            )}

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
              </div>
            </details>
          </>
        )}
      </Page>
    </Frame>
  );
}
