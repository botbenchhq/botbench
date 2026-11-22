import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getTask, getTaskDiff, getTranscript, openEventStream, type FileChange, type StoredEvent, type TaskDetail } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ApprovalCard } from "../components/approval-card.tsx";
import { DiffLine } from "../components/diff.tsx";
import { agentName, CHECKS_RISK, ChecksResult, CommandRounds, latestRound, REVIEW_RISK, ReviewEvidence, reviewerWords } from "../components/evidence.tsx";
import { Alert, Frame, Page, PageHeader, StreamBanner } from "../components/header.tsx";
import { CopyField, DecisionControls, DecisionOutcome } from "../components/decision.tsx";
import { MODE_SENTENCE } from "../components/mode-choice.tsx";
import { DiscardSection } from "../components/discard.tsx";
import { modelState, sessionModel, useModelNames } from "../components/model-picker.tsx";
import { ResumeControl } from "../components/resume.tsx";
import { statusSentence } from "../components/task-status.ts";
import { mergeEvents, Transcript } from "../components/transcript.tsx";

/** What is known about one file's diff: being fetched, fetched, or why it could not be. */
type DiffState = { kind: "loading" } | { kind: "loaded"; diff: string; truncated: boolean } | { kind: "failed"; why: string };

/** A unified diff as text, in a block that scrolls sideways on its own so the page never does. */
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
  return (
    <figure className="ds-diff">
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

export function TaskScreen({ id, onSignedOut }: { id: number; onSignedOut: () => void }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [connected, setConnected] = useState(true);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const [open, setOpen] = useState<string[]>([]);
  const missing = useRef(false);
  const nameOf = useModelNames(onSignedOut);
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
  const working = task?.status === "building" && !task.resuming && attemptId !== null && !shown.some((e) => e.type === "turn_ended") ? (asking === undefined ? "Claude Code is working." : asking.parkedAt === null ? "Claude Code is paused until you answer." : "Claude Code is stopped until you answer.") : null;

  return (
    <Frame current={null} banner={connected ? undefined : <StreamBanner />}>
      <Page>
        {/* The page header comes first and holds the view's one h1, also while the task is being read or cannot be. */}
        <PageHeader title={`Task ${id}`}>
          {task !== null && (
            <p data-testid="task-status" role="status" className="ds-page-header__description">
              {statusSentence(task)}
            </p>
          )}
          {task !== null && task.ofPlan !== null && (
            <p data-testid="task-mode" className="ds-page-header__description">
              {MODE_SENTENCE[task.mode]}
            </p>
          )}
        </PageHeader>
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
            <dl className="ds-key-value">
              <div className="ds-key-value__item">
                <dt className="ds-key-value__label">Model</dt>
                <dd data-testid="task-model" className="ds-key-value__value">{`${modelState(session, nameOf)}. You asked for: ${task.requestedModel === null ? "Claude Code's default" : nameOf(task.requestedModel)}.`}</dd>
              </div>
              <div className="ds-key-value__item">
                <dt className="ds-key-value__label">Repository</dt>
                <dd data-testid="task-repo" data-ds-content="" className="ds-key-value__value ds-key-value__value--mono">
                  {task.repo}
                </dd>
              </div>
            </dl>

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

            {asking !== undefined && <ApprovalCard key={asking.id} approval={asking} more={waiting.length - 1} onSignedOut={onSignedOut} />}

            {task.evidence.some((row) => row.kind === "setup") && (
              <section aria-labelledby="setup-heading" className="ds-stack ds-gap-sm">
                <h2 id="setup-heading">Setup</h2>
                <p>Botbench ran this repository's setup commands in the task's copy before Claude Code started, as your settings list them.</p>
                <CommandRounds lists={task.commandLists} rows={task.evidence.filter((row) => row.kind === "setup")} what={{ one: "setup command", many: "setup commands" }} />
              </section>
            )}

            {shown.length > 0 || working !== null ? (
              <section aria-label="Transcript">
                <Transcript events={shown} working={working} modelName={nameOf} />
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

            {task.filesProblem !== null && (
              <Alert tone="error" role="alert">
                {task.filesProblem}
              </Alert>
            )}
            {(task.checks !== null || task.status === "verifying") && (
              <section aria-labelledby="checks-heading" className="ds-stack ds-gap-sm">
                <h2 id="checks-heading">Checks</h2>
                {task.checks !== null && <ChecksResult checks={task.checks} rows={latestRound(task.evidence.filter((row) => row.kind === "check"))} />}
                {task.checks !== "none" && <p>{CHECKS_RISK}</p>}
                <CommandRounds testId="checks" lists={task.commandLists} rows={task.evidence.filter((row) => row.kind === "check")} what={{ one: "check", many: "checks" }} failedFirst />
              </section>
            )}

            {task.reviewer !== null && (task.review !== null || task.status === "reviewing") && (
              <section aria-labelledby="review-heading" data-testid="review" className="ds-stack ds-gap-sm">
                <h2 id="review-heading">{`${agentName(task.reviewer.agent)}'s review`}</h2>
                <p data-testid="review-by">{`By ${reviewerWords(task.review ?? task.reviewer)}. ${REVIEW_RISK}`}</p>
                {task.review !== null ? <ReviewEvidence review={task.review} /> : <p role="status">{`${agentName(task.reviewer.agent)} is reading the changes.`}</p>}
              </section>
            )}

            {task.files !== null && (
              <section className="ds-stack ds-gap-sm">
                <h2>Changed files</h2>
                {task.files.length === 0 ? (
                  <p data-testid="no-changes">No file was changed, so the branch is still at the commit it started from.</p>
                ) : (
                  <ul data-testid="changed-files" className="ds-list">
                    {task.files.map((file) => {
                      const expanded = open.includes(file.path);
                      return (
                        <li key={file.path} className="ds-list__row">
                          <details open={expanded} onToggle={(e) => toggled(file.path, e.currentTarget.open)} className="ds-disclosure ds-disclosure--row">
                            <summary className="ds-disclosure__summary">
                              <code data-ds-content="">{file.path}</code>
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
                )}
              </section>
            )}

            {task.decision !== null ? (
              <section aria-labelledby="decision-heading" className="ds-stack ds-gap-sm">
                <h2 id="decision-heading">{task.decision.decision === "accept" ? (task.decision.decidedBy === "mode" ? "Accepted without you" : "Accepted") : "Rejected"}</h2>
                {task.decision.reasons !== null && <p data-testid="decided-by">{task.decision.reasons}</p>}
                <DecisionOutcome decision={task.decision} repo={task.repo} />
              </section>
            ) : (
              task.branch !== null && task.remains?.discardedAt == null && (
                <section className="ds-stack ds-gap-sm">
                  <CopyField label="Branch" value={task.branch} testId="branch" buttonName="Copy branch name" />
                  <p data-testid="not-merged">
                    {`Nothing has been merged or pushed. Claude Code may read and change files inside this task's copy of the project without asking. ${task.mode === "manual" ? `${task.preapproved.length > 0 ? "The commands listed above, and those you chose Always allow for (see Permissions), run without asking; every other shell command waits for your answer first" : "Every shell command waits for your answer first, unless you chose Always allow for it (see Permissions)"}, and Botbench sends you anything else it wants to do as well.` : task.mode === "semi" ? "Its run is semi-autonomous, so its shell commands run without asking, apart from those the safety rules always ask you about; Botbench sends you anything else it wants to do as well." : "Its run is fully autonomous, so its shell commands run without asking, and what would need your answer is refused instead: those the safety rules always ask about, and anything else it wants to do."} The separate copy (a git worktree) keeps changes apart from your own files. A command you allow${task.preapproved.length > 0 ? " or list in advance" : ""} runs in Claude Code's sandbox: it cannot read your sign-ins, your keys or the rest of your home folder (apart from this repository's git data and your git settings), can change files only in this copy and a temporary folder, and reaches the internet only at hosts allowed for this repository in Botbench's settings file.`}
                  </p>
                </section>
              )
            )}

            {task.status === "interrupted" && task.resumeNote !== null && (
              <section aria-labelledby="resume-heading" className="ds-stack ds-gap-sm">
                <h2 id="resume-heading">Resume</h2>
                <ResumeControl taskId={task.id} note={task.resumeNote} primary onResumed={load} onSignedOut={onSignedOut} />
              </section>
            )}

            <DiscardSection task={task} onDiscarded={load} onSignedOut={onSignedOut} />

            {task.status === "awaiting_decision" && (
              <section aria-labelledby="decide-heading" className="ds-stack ds-gap-sm">
                <h2 id="decide-heading">Your decision</h2>
                <p>{`Accept keeps the branch for you to merge yourself and removes the task's copy of the project. Reject removes the copy too, and asks whether to keep the branch.${task.checks === "failed" ? " The checks failed; you can still accept or reject it." : ""}`}</p>
                {task.leftovers !== null && task.leftovers.length > 0 && <p>{`The checks left ${task.leftovers.length === 1 ? "1 file" : `${task.leftovers.length} files`} in the task's copy that ${task.leftovers.length === 1 ? "is" : "are"} not on the branch. Accept and Reject list ${task.leftovers.length === 1 ? "it" : "them"} before anything is removed.`}</p>}
                <DecisionControls taskId={task.id} leftovers={task.leftovers} primary onDecided={load} onSignedOut={onSignedOut} />
              </section>
            )}
          </>
        )}
      </Page>
    </Frame>
  );
}
