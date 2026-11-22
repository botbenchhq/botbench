import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getTask, getTaskDiff, getTranscript, openEventStream, type FileChange, type StoredEvent, type TaskDetail } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ApprovalCard } from "../components/approval-card.tsx";
import { DiffLine } from "../components/diff.tsx";
import { CHECKS_RISK, ChecksResult, CommandEvidence } from "../components/evidence.tsx";
import { Alert, Frame, Page, PageHeader, StreamBanner } from "../components/header.tsx";
import { Icon } from "../components/icon.tsx";
import { modelState, sessionModel, useModelNames } from "../components/model-picker.tsx";
import { statusSentence } from "../components/task-status.ts";
import { mergeEvents, Transcript } from "../components/transcript.tsx";

/** What is known about one file's diff: being fetched, fetched, or why it could not be. */
type DiffState = { kind: "loading" } | { kind: "loaded"; diff: string; truncated: boolean } | { kind: "failed"; why: string };

/** A unified diff as text, in a block that scrolls sideways on its own so the page never does. */
function Diff({ path, state }: { path: string; state: DiffState }) {
  if (state.kind === "loading") {
    return (
      <figure className="gw-diff" aria-busy="true">
        <p role="status" className="gw-diff__note">
          Loading the changes.
        </p>
      </figure>
    );
  }
  if (state.kind === "failed") {
    return (
      <figure className="gw-diff">
        <p role="alert" className="gw-diff__note">{`The changes could not be loaded. ${state.why}`}</p>
      </figure>
    );
  }
  const lines = state.diff.replace(/\n$/, "").split("\n");
  return (
    <figure className="gw-diff">
      <pre data-testid="diff-scroll" tabIndex={0} role="group" data-gw-content-label="" aria-label={`Changes in ${path}`} className="gw-diff__body">
        <code data-testid="diff" data-gw-content="" className="gw-diff__lines">
          {lines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </code>
      </pre>
      {state.truncated && <p className="gw-diff__note">These changes are longer than Smelt shows here. All of them are on the branch.</p>}
    </figure>
  );
}

/** A file's line counts: each a sign and a number, finished in words for a screen reader. */
function Counts({ file }: { file: FileChange }) {
  if (file.binary) return <>binary</>;
  return (
    <span className="gw-diff__counts">
      <span className="gw-diff__added">
        {`+${file.added}`}
        <span className="gw-diff__label">{file.added === 1 ? " line added" : " lines added"}</span>
      </span>
      <span className="gw-diff__removed">
        {`−${file.removed}`}
        <span className="gw-diff__label">{file.removed === 1 ? " line removed" : " lines removed"}</span>
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
  const [copied, setCopied] = useState<string | null>(null);
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
      setProblem(err instanceof ApiError ? `${what} could not be read. ${err.message}` : `${what} could not be read: Smelt could not be reached.`);
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
        setDiffs((have) => ({ ...have, [file]: { kind: "failed", why: err instanceof ApiError ? err.message : "Smelt could not be reached." } }));
      },
    );
  };

  const copyBranch = (branch: string): void => {
    // The clipboard is only there on a secure page (HTTPS, or this Mac itself) and may still refuse.
    const written = navigator.clipboard === undefined ? Promise.reject(new Error("no clipboard")) : navigator.clipboard.writeText(branch);
    written.then(
      () => setCopied("Copied."),
      () => setCopied("Not copied: this browser refused. Select the name to copy it."),
    );
  };

  // Between the end of the turn and Smelt's commit the task is still building, but Claude Code is no longer working.
  const working = task?.status === "building" && !task.resuming && attemptId !== null && !shown.some((e) => e.type === "turn_ended") ? (asking === undefined ? "Claude Code is working." : asking.parkedAt === null ? "Claude Code is paused until you answer." : "Claude Code is stopped until you answer.") : null;

  return (
    <Frame current={null} banner={connected ? undefined : <StreamBanner />}>
      <Page>
        {/* The page header comes first and holds the view's one h1, also while the task is being read or cannot be. */}
        <PageHeader title={`Task ${id}`}>
          {task !== null && (
            <p data-testid="task-status" role="status" className="gw-page-header__description">
              {statusSentence(task)}
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
            <p role="status" className="gw-spinner">
              Reading the task.
            </p>
          )
        ) : (
          <>
            <dl className="gw-key-value">
              <div className="gw-key-value__item">
                <dt className="gw-key-value__label">Model</dt>
                <dd data-testid="task-model" className="gw-key-value__value">{`${modelState(session, nameOf)}. You asked for: ${task.requestedModel === null ? "Claude Code's default" : nameOf(task.requestedModel)}.`}</dd>
              </div>
              <div className="gw-key-value__item">
                <dt className="gw-key-value__label">Repository</dt>
                <dd data-testid="task-repo" data-gw-content="" className="gw-key-value__value gw-key-value__value--mono">
                  {task.repo}
                </dd>
              </div>
            </dl>

            {task.preapproved.length > 0 && (
              <section className="gw-stack gw-gap-sm">
                <h2>Allowed for this task</h2>
                <ul data-testid="task-preapproved" className="gw-list gw-list--dense">
                  {task.preapproved.map((command) => (
                    <li key={command} className="gw-list__row">
                      <div className="gw-list__content">
                        <span className="gw-list__body">
                          <code data-gw-content="" className="gw-list__primary">
                            {command}
                          </code>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <p>You listed these when you started the task. They run without asking, with further arguments too, unless Smelt's safety rules catch them (git push, sudo, deleting outside the task's copy and the like) or they are chained, piped or redirected: those still ask.</p>
              </section>
            )}

            {asking !== undefined && <ApprovalCard key={asking.id} approval={asking} more={waiting.length - 1} onSignedOut={onSignedOut} />}

            {task.evidence.some((row) => row.kind === "setup") && (
              <section aria-labelledby="setup-heading" className="gw-stack gw-gap-sm">
                <h2 id="setup-heading">Setup</h2>
                <p>Smelt ran this repository's setup commands in the task's copy before Claude Code started, as your settings list them.</p>
                <CommandEvidence rows={task.evidence.filter((row) => row.kind === "setup")} what={{ one: "setup command", many: "setup commands" }} />
              </section>
            )}

            {shown.length > 0 || working !== null ? (
              <section aria-label="Transcript">
                <Transcript events={shown} working={working} modelName={nameOf} />
              </section>
            ) : (
              attemptId === null && (
                <ol className="gw-stack gw-gap-sm">
                  <li className="gw-message gw-message--user">
                    <span className="gw-message__label">You</span>
                    <p data-testid="task-prompt" data-gw-content="" className="gw-message__body">
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
              <section aria-labelledby="checks-heading" className="gw-stack gw-gap-sm">
                <h2 id="checks-heading">Checks</h2>
                {task.checks !== null && <ChecksResult checks={task.checks} rows={task.evidence.filter((row) => row.kind === "check")} />}
                {task.checks !== "none" && <p>{CHECKS_RISK}</p>}
                <CommandEvidence testId="checks" rows={task.evidence.filter((row) => row.kind === "check")} what={{ one: "check", many: "checks" }} failedFirst />
              </section>
            )}

            {task.files !== null && (
              <section className="gw-stack gw-gap-sm">
                <h2>Changed files</h2>
                {task.files.length === 0 ? (
                  <p data-testid="no-changes">No file was changed, so the branch is still at the commit it started from.</p>
                ) : (
                  <ul data-testid="changed-files" className="gw-list">
                    {task.files.map((file) => {
                      const expanded = open.includes(file.path);
                      return (
                        <li key={file.path} className="gw-list__row">
                          <details open={expanded} onToggle={(e) => toggled(file.path, e.currentTarget.open)} className="gw-disclosure gw-disclosure--row">
                            <summary className="gw-disclosure__summary">
                              <code data-gw-content="">{file.path}</code>
                              <span className="gw-disclosure__meta">
                                {file.status} <Counts file={file} />
                              </span>
                            </summary>
                            <div className="gw-disclosure__content">{expanded && <Diff path={file.path} state={diffs[file.path] ?? { kind: "loading" }} />}</div>
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}

            {task.branch !== null && (
              <section className="gw-stack gw-gap-sm">
                <div className="gw-field">
                  <label htmlFor="branch" className="gw-field__label">
                    Branch
                  </label>
                  <div className="gw-copy-field">
                    <input id="branch" data-testid="branch" type="text" readOnly value={task.branch} className="gw-copy-field__value basis-full" />
                    <button type="button" aria-label="Copy branch name" onClick={() => copyBranch(task.branch!)} className="gw-button">
                      <Icon name="copy" className="gw-button__icon" />
                      Copy
                    </button>
                    <p data-testid="copy-state" role="status" className="gw-copy-field__status">
                      {copied}
                    </p>
                  </div>
                </div>
                <p data-testid="not-merged">
                  {`Nothing has been merged or pushed. Claude Code may read and change files inside this task's copy of the project without asking. ${task.preapproved.length > 0 ? "The commands listed above, and those you chose Always allow for (see Permissions), run without asking; every other shell command waits for your answer first" : "Every shell command waits for your answer first, unless you chose Always allow for it (see Permissions)"}, and Smelt sends you anything else it wants to do as well. The separate copy (a git worktree) keeps changes apart from your own files; it is not a sandbox: a command you allow${task.preapproved.length > 0 ? " or list in advance" : ""} runs with your account's rights.`}
                </p>
              </section>
            )}
          </>
        )}
      </Page>
    </Frame>
  );
}
