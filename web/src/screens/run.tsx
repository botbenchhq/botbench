import { useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, approvePlan, cancelRun, getRun, getTranscript, openEventStream, requestPlanChanges, savePlan, type PlanTask, type RunDetail, type RunTask, type StoredEvent } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ApprovalCard } from "../components/approval-card.tsx";
import { ConfirmAction } from "../components/confirm.tsx";
import { DecisionControls, DecisionOutcome } from "../components/decision.tsx";
import { PullRequestLink, pullRequestWords } from "../components/pull-request.tsx";
import { CHECKS_LINE, ChecksResult, CommandRounds, latestRound } from "../components/evidence.tsx";
import { Alert, Frame, Page, PageHeader, StreamBanner } from "../components/header.tsx";
import { modeSentence } from "../app/run-words.ts";
import { APPROVAL_LIMIT_WORDS, limitName } from "../app/composer.ts";
import { cancelStatement } from "../app/row-menu.ts";
import { Icon } from "../components/icon.tsx";
import { modelState, sessionModel, useModelNames } from "../components/model-picker.tsx";
import { ResumeControl } from "../components/resume.tsx";
import { runSentence, runTaskNote } from "../components/run-status.ts";
import { offersMerge, statusLook, statusWord, waitingForWords, waitingWords } from "../components/task-status.ts";
import { mergeEvents, Transcript } from "../components/transcript.tsx";
import { StatusBadge } from "../components/status.tsx";
import { OutsideText } from "../components/outside-text.tsx";
import { RunTimeline } from "../components/run-timeline.tsx";
import { StricterMode } from "../components/mode-change.tsx";

const UNDO_SECONDS = 10;
/** When something happened, as the run's history says it. */
const when = (iso: string): string => new Date(iso).toLocaleString();
const tasksWord = (n: number): string => `${n} ${n === 1 ? "task" : "tasks"}`;
/** The criteria as the editor holds them: one on each line. */
const toLines = (criteria: readonly string[]): string => criteria.join("\n");
const fromLines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

/** Which row of the plan is being edited: one of its tasks by position from 0, or a new one at the end. */
type Editing = { at: number | "new"; title: string; criteria: string; problem: { title?: string; criteria?: string; save?: string } };
/** A task that was just deleted and can still be put back. */
type Deleted = { task: PlanTask; at: number; left: number; undoing: boolean };

/** Every piece of a plan is rendered as a React child, so a planner's words are always text and never markup. */
function PlanRow({ task, number, locked, onEdit, onDelete }: { task: PlanTask; number: number; locked: boolean; onEdit: () => void; onDelete: () => void }) {
  return (
    <>
      <div data-ds-content="" className="ds-editable-list__text ds-stack ds-gap-xs">
        <strong>{task.title}</strong>
        <ul aria-label={`Acceptance criteria of task ${number}`} className="ds-stack ds-gap-xs">
          {task.criteria.map((criterion, i) => (
            <li key={i}>{criterion}</li>
          ))}
        </ul>
      </div>
      <span className="ds-editable-list__actions">
        <button type="button" data-edit={number - 1} disabled={locked} data-ds-content-label="" aria-label={`Edit task ${number}: ${task.title}`} onClick={onEdit} className="ds-button ds-button--quiet ds-button--small">
          Edit
        </button>
        <button type="button" disabled={locked} data-ds-content-label="" aria-label={`Delete task ${number}: ${task.title}`} onClick={onDelete} className="ds-button ds-button--quiet ds-button--small">
          Delete
        </button>
      </span>
    </>
  );
}

/** The editor a row turns into: the title and the criteria, one on each line. Enter in the title saves; Escape cancels. */
function PlanEditor({ editing, name, saving, onChange, onSave, onCancel }: { editing: Editing; name: string; saving: boolean; onChange: (next: Editing) => void; onSave: () => void; onCancel: () => void }) {
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => title.current?.focus(), []);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave();
  };
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && !saving && onCancel()} className="ds-editable-list__editor" noValidate>
      <div className="ds-field">
        <label htmlFor="plan-title" className="ds-field__label">{`${name} title`}</label>
        <input ref={title} id="plan-title" type="text" autoComplete="off" readOnly={saving} value={editing.title} onChange={(e) => onChange({ ...editing, title: e.target.value })} aria-invalid={editing.problem.title !== undefined} aria-describedby={editing.problem.title === undefined ? undefined : "plan-title-error"} className="ds-field__control" />
        {editing.problem.title !== undefined && (
          <p id="plan-title-error" className="ds-field__error">
            {editing.problem.title}
          </p>
        )}
      </div>
      <div className="ds-field">
        <label htmlFor="plan-criteria" className="ds-field__label">{`${name} acceptance criteria`}</label>
        <textarea id="plan-criteria" readOnly={saving} value={editing.criteria} onChange={(e) => onChange({ ...editing, criteria: e.target.value })} aria-invalid={editing.problem.criteria !== undefined} aria-describedby={editing.problem.criteria === undefined ? "plan-criteria-about" : "plan-criteria-about plan-criteria-error"} className="ds-field__control ds-textarea" />
        <p id="plan-criteria-about" className="ds-field__description">One criterion on each line: a sentence that can be checked when the task is done.</p>
        {editing.problem.criteria !== undefined && (
          <p id="plan-criteria-error" className="ds-field__error">
            {editing.problem.criteria}
          </p>
        )}
      </div>
      {editing.problem.save !== undefined && (
        <p role="alert" className="ds-field__error">
          {editing.problem.save}
        </p>
      )}
      <div className="ds-editable-list__editor-actions">
        <button type="submit" aria-busy={saving} className="ds-button ds-button--small">
          {saving ? "Saving task" : "Save task"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel} className="ds-button ds-button--quiet ds-button--small">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What a task of the run is doing, in words, for its row. */
function taskFacts(task: RunTask): string {
  if (task.status === "queued") return "Starts when the tasks before it have finished";
  if (task.status === "verifying") return "Botbench is running this repository's checks";
  if (task.status === "reviewing") return "The reviewer is reading the changes";
  if (task.status === "waiting_for_limit") return waitingWords(task.retryAt);
  if (task.waitingFor !== null) return waitingForWords(task)!;
  if (task.status === "building") return task.waitingOnApproval ? "Claude Code is waiting for your answer" : task.attemptId === null ? "Preparing a separate copy of the project" : "Claude Code is working; open it to watch";
  if (task.decision?.branch === "deleted") return "Branch deleted";
  return task.branch ?? "No branch";
}

export function RunScreen({ id, onSignedOut }: { id: number; onSignedOut: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [connected, setConnected] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<"save" | "approve" | "changes" | "cancel" | null>(null);
  const [decisionProblem, setDecisionProblem] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [deleted, setDeleted] = useState<Deleted | null>(null);
  const missing = useRef(false);
  const nameOf = useModelNames(onSignedOut);
  /** Counts reads of the run, so an answer that arrives after a newer one was asked for is dropped. */
  const reads = useRef(0);

  /** Read the run as it stands, and its planner's stored transcript. */
  const load = useCallback((): void => {
    if (missing.current) return;
    const read = ++reads.current;
    const failed = (what: string) => (err: unknown): void => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      if (read !== reads.current) return;
      setProblem(err instanceof ApiError ? `${what} could not be read. ${err.message}` : `${what} could not be read: Botbench could not be reached.`);
    };
    getRun(id).then((next) => {
      if (read !== reads.current) return;
      setRun(next);
      setProblem(null);
      // Stored events only ever add up, so a transcript is folded in whichever read fetched it.
      if (next.attemptId !== null) getTranscript(next.attemptId).then((transcript) => setEvents((have) => mergeEvents(have, transcript.events)), failed("The planning transcript"));
    }, (err: unknown) => {
      if (err instanceof ApiError && err.status === 404) {
        missing.current = true;
        return setProblem(`There is no run ${id}.`);
      }
      failed("The run")(err);
    });
  }, [id, onSignedOut]);

  // Follow the stream from now on. The run is read each time the stream comes up and each time it reaches a new
  // state or its plan changes, here or in another window, so the plan arrives without a reload.
  useEffect(() => {
    load();
    return openEventStream(0, {
      onEvent: (event) => setEvents((have) => mergeEvents(have, [event])),
      onConnection: (isConnected) => {
        setConnected(isConnected);
        if (isConnected) load();
      },
      onSignedOut,
      onRun: (announcement) => {
        if (announcement.runId === id) load();
      },
      // A task of the run reached a state or gained evidence. Which run a task belongs to is on the run's own record.
      onTask: () => load(),
    });
  }, [id, load, onSignedOut]);

  // The planner's requests that wait for an answer, oldest first. One card at a time: the oldest.
  const { pending } = useContext(ApprovalsContext);
  const waiting = useMemo(() => (pending ?? []).filter((approval) => approval.runId === id), [pending, id]);
  const asking = waiting[0];
  useEffect(() => load(), [load, asking?.id]);
  // A builder's request comes and goes with the pending approvals: the row that waits says so.
  const pendingCount = pending?.length ?? 0;
  useEffect(() => load(), [load, pendingCount]);

  // The undo offer counts down once a second and then goes. The delete itself is already stored.
  useEffect(() => {
    if (deleted === null || deleted.undoing) return;
    const timer = window.setTimeout(() => setDeleted((d) => (d === null ? null : d.left <= 1 ? null : { ...d, left: d.left - 1 })), 1000);
    return () => window.clearTimeout(timer);
  }, [deleted]);

  const attemptId = run?.attemptId ?? null;
  const shown = useMemo(() => events.filter((e) => e.attemptId === attemptId), [events, attemptId]);
  const session = useMemo(() => sessionModel(shown), [shown]);

  /** What a refused request says, and what the screen then does about it. */
  const refusedWords = (err: unknown): string | null => {
    if (err instanceof ApiError && err.status === 401) {
      onSignedOut();
      return null;
    }
    // The plan or the run moved on in another window: show what is so now.
    if (err instanceof ApiError && err.status === 409) load();
    return err instanceof ApiError ? err.message : "Botbench could not be reached.";
  };
  const focusEdit = (at: number): void => void window.requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-edit="${at}"]:not(:disabled)`) ?? document.querySelector<HTMLElement>("[data-add-task]"))?.focus());

  const saveEdit = (): void => {
    if (run === null || editing === null || busy !== null) return;
    const title = editing.title.trim();
    const criteria = fromLines(editing.criteria);
    const found: Editing["problem"] = {};
    if (title === "") found.title = "Give the task a title.";
    if (criteria.length === 0) found.criteria = "Give at least one acceptance criterion, one on each line.";
    if (found.title !== undefined || found.criteria !== undefined) return setEditing({ ...editing, problem: found });
    const task = { title, criteria };
    const tasks = editing.at === "new" ? [...run.plan, task] : run.plan.map((old, i) => (i === editing.at ? task : old));
    const at = editing.at === "new" ? run.plan.length : editing.at;
    setBusy("save");
    savePlan(id, run.planVersion, tasks).then(
      (next) => {
        setBusy(null);
        setRun(next);
        setEditing(null);
        setDecisionProblem(null);
        focusEdit(at);
      },
      (err: unknown) => {
        setBusy(null);
        const why = refusedWords(err);
        // The row stays in editing with what was typed.
        if (why !== null) setEditing({ ...editing, problem: { save: `The task was not saved. ${why}` } });
      },
    );
  };

  const remove = (at: number): void => {
    if (run === null || busy !== null) return;
    const task = run.plan[at]!;
    setBusy("save");
    savePlan(id, run.planVersion, run.plan.filter((_, i) => i !== at)).then(
      (next) => {
        setBusy(null);
        setRun(next);
        setDecisionProblem(null);
        setDeleted({ task, at, left: UNDO_SECONDS, undoing: false });
        focusEdit(at);
      },
      (err: unknown) => {
        setBusy(null);
        const why = refusedWords(err);
        if (why !== null) setDecisionProblem(`Task ${at + 1} was not deleted. ${why}`);
      },
    );
  };

  const undo = (): void => {
    if (run === null || deleted === null || deleted.undoing || busy !== null) return;
    const { task, at } = deleted;
    setDeleted({ ...deleted, undoing: true });
    const tasks = [...run.plan.slice(0, at), task, ...run.plan.slice(at)];
    savePlan(id, run.planVersion, tasks).then(
      (next) => {
        setRun(next);
        setDeleted(null);
        focusEdit(at);
      },
      (err: unknown) => {
        setDeleted(null);
        const why = refusedWords(err);
        if (why !== null) setDecisionProblem(`The task was not put back. ${why} Add it again with Add task.`);
      },
    );
  };

  /** One of the owner's decisions about the whole run. Each names the plan this screen shows. */
  const decide = (what: "approve" | "changes" | "cancel"): void => {
    if (run === null || busy !== null) return;
    if (what !== "cancel" && editing !== null) return setDecisionProblem("Save or cancel the task you are editing first: it is not part of the plan yet.");
    if (what === "changes" && feedback.trim() === "") return setDecisionProblem("Changes were not requested. Say what the planner should change.");
    setDecisionProblem(null);
    setBusy(what);
    const sent = what === "approve" ? approvePlan(id, run.planVersion) : what === "changes" ? requestPlanChanges(id, run.planVersion, feedback.trim()) : cancelRun(id);
    sent.then(
      (next) => {
        setBusy(null);
        setRun(next);
        setEditing(null);
        setDeleted(null);
        if (what === "changes") setFeedback("");
      },
      (err: unknown) => {
        setBusy(null);
        const why = refusedWords(err);
        if (why !== null) setDecisionProblem(`${what === "approve" ? "The plan was not approved." : what === "changes" ? "Changes were not requested." : "The run was not cancelled."} ${why}`);
      },
    );
  };

  const planning = run?.status === "planning";
  const gate = run?.status === "awaiting_plan_approval";
  const building = run?.status === "running";
  const working = planning && attemptId !== null && !shown.some((e) => e.type === "turn_ended" && e.id === shown.at(-1)?.id) ? (asking === undefined ? "Claude Code is planning." : "") : null;
  const transcript = (
    // The planning prompt is Botbench's own, with the owner's words inside it, so the row says Botbench wrote it.
    <Transcript events={shown} working={working} modelName={nameOf} promptBy="Botbench, to Claude Code" folded={!planning} />
  );
  const cancel = run !== null && (planning || gate || building) && (
    <ConfirmAction label="Cancel run" title="Cancel this run?" confirmLabel="Cancel run" cancelLabel="Keep run" disabled={busy !== null} losing testId="cancel-run" onConfirm={() => decide("cancel")}>
      <p>{cancelStatement(run.status, run.plan.length)}</p>
    </ConfirmAction>
  );

  return (
    <Frame current={null} banner={connected ? undefined : <StreamBanner />} showing={waiting.map((approval) => approval.id)}>
      <Page>
        {/* The page header comes first and holds the view's one h1, also while the run is being read or cannot be. */}
        <PageHeader title={`Run ${id}`}>
          {run !== null && (
            <p data-testid="run-status" role="status" className="ds-page-header__description">
              {runSentence(run)}
            </p>
          )}
        </PageHeader>
        {problem !== null && (
          <Alert tone="error" role="alert">
            {problem}
          </Alert>
        )}
        {run === null ? (
          problem === null && (
            <p role="status" className="ds-spinner">
              Reading the run.
            </p>
          )
        ) : (
          <>
            {run.outsideText && <OutsideText issue={run.issue} what="run" />}
            <RunTimeline run={run} id={id} />
            <dl className="ds-key-value">
              <div className="ds-key-value__item">
                <dt className="ds-key-value__label">Repository</dt>
                <dd data-testid="run-repo" data-ds-content="" className="ds-key-value__value ds-key-value__value--mono">
                  {run.repo}
                </dd>
              </div>
              {run.source !== null && (
                // The finished task or the chat this run was made from, with the owner's note as its message.
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Made from</dt>
                  <dd data-testid="run-source" className="ds-key-value__value">
                    <a href={run.source.kind === "task" ? `#/tasks/${run.source.id}` : `#/chats/${run.source.id}`} className="ds-link">
                      {run.source.label}
                    </a>
                  </dd>
                </div>
              )}
              {run.claim !== null && (
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Other workbenches</dt>
                  <dd data-testid="run-claim" data-ds-content="" className="ds-key-value__value">
                    {run.claim.words}
                  </dd>
                </div>
              )}
              {run.specPath !== null && (
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Spec file</dt>
                  <dd data-testid="run-spec" data-ds-content="" className="ds-key-value__value ds-key-value__value--mono">
                    {run.specPath}
                  </dd>
                </div>
              )}
              <div className="ds-key-value__item">
                <dt className="ds-key-value__label">Mode</dt>
                <dd data-testid="run-mode" className="ds-key-value__value">
                  {modeSentence(run.mode, run.issueHosts)}
                </dd>
              </div>
              {run.modeChanges.length > 0 && (
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Changes of mode</dt>
                  <dd className="ds-key-value__value">
                    <ul data-testid="run-mode-changes" className="ds-stack ds-gap-xs">
                      {run.modeChanges.map((change) => (
                        <li key={change.at + change.to}>{`${when(change.at)}: ${change.words}`}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              <div className="ds-key-value__item">
                <dt className="ds-key-value__label">Approval time limit</dt>
                <dd data-testid="run-approval-limit" className="ds-key-value__value">
                  {run.approvalLimitMinutes === null ? `Off. ${APPROVAL_LIMIT_WORDS.off}` : `${limitName(run.approvalLimitMinutes)}. ${APPROVAL_LIMIT_WORDS.on(run.approvalLimitMinutes)}`}
                </dd>
              </div>
              <div className="ds-key-value__item">
                <dt className="ds-key-value__label">Planning model</dt>
                <dd data-testid="run-model" className="ds-key-value__value">{`${run.attemptId === null ? "not started yet" : modelState(session, nameOf)}. You asked for: ${run.requestedModel === null ? "Claude Code's default" : nameOf(run.requestedModel)}.`}</dd>
              </div>
              {run.buildModel !== undefined && (
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Build model</dt>
                  <dd data-testid="run-build-model" className="ds-key-value__value">{`The tasks are built on what you asked for: ${run.buildModel === null ? "Claude Code's default" : nameOf(run.buildModel)}.`}</dd>
                </div>
              )}
              <div className="ds-key-value__item">
                <dt className="ds-key-value__label">When you accept a task</dt>
                <dd data-testid="run-delivery" className="ds-key-value__value">{run.delivery === "pull_request" ? "Botbench pushes its branch and opens a pull request" : "Its branch is kept on this Mac"}</dd>
              </div>
            </dl>

            <StricterMode key={run.mode} run={run} onChanged={setRun} onSignedOut={onSignedOut} />

            {gate && run.reason !== null && (
              <Alert tone="warning" role="status">
                {run.reason}
              </Alert>
            )}

            {asking !== undefined && <ApprovalCard key={asking.id} approval={asking} more={waiting.length - 1} on="run" onSignedOut={onSignedOut} />}

            {gate && (
              <section aria-labelledby="plan-heading" className="ds-stack ds-gap-lg">
                <h2 id="plan-heading">Plan</h2>
                <div className="ds-editable-list">
                  {run.plan.length === 1 && <p className="ds-editable-list__note">A plan holds at least one task. To drop this one too, cancel the run.</p>}
                  <ol aria-label="Plan" className="ds-editable-list__items">
                    {run.plan.map((task, i) => (
                      <li key={i} className="ds-editable-list__item">
                        {editing?.at === i ? (
                          <PlanEditor editing={editing} name={`Task ${i + 1}`} saving={busy === "save"} onChange={setEditing} onSave={saveEdit} onCancel={() => (setEditing(null), focusEdit(i))} />
                        ) : (
                          <PlanRow task={task} number={i + 1} locked={busy !== null || editing !== null} onEdit={() => setEditing({ at: i, title: task.title, criteria: toLines(task.criteria), problem: {} })} onDelete={() => remove(i)} />
                        )}
                      </li>
                    ))}
                    {editing?.at === "new" && (
                      <li className="ds-editable-list__item">
                        <PlanEditor editing={editing} name="New task" saving={busy === "save"} onChange={setEditing} onSave={saveEdit} onCancel={() => (setEditing(null), focusEdit(run.plan.length))} />
                      </li>
                    )}
                  </ol>
                  {editing?.at !== "new" && (
                    <div className="ds-editable-list__add">
                      <button type="button" data-add-task disabled={busy !== null || editing !== null || run.plan.length >= 20} onClick={() => setEditing({ at: "new", title: "", criteria: "", problem: {} })} className="ds-button ds-button--quiet">
                        <Icon name="plus" className="ds-button__icon" />
                        Add task
                      </button>
                    </div>
                  )}
                </div>

                {decisionProblem !== null && (
                  <Alert tone="error" role="alert">
                    {decisionProblem}
                  </Alert>
                )}
                <div className="ds-cluster">
                  <button type="button" aria-busy={busy === "approve"} disabled={busy !== null && busy !== "approve"} onClick={() => decide("approve")} className="ds-button ds-button--primary">
                    {busy === "approve" ? "Approving" : `Approve ${tasksWord(run.plan.length)}`}
                  </button>
                </div>
                <p>Approving starts building the tasks, one at a time, in this order.</p>

                <div className="ds-stack ds-gap-sm">
                  <div className="ds-field">
                    <label htmlFor="plan-feedback" className="ds-field__label">
                      Feedback for the planner
                    </label>
                    <textarea id="plan-feedback" value={feedback} onChange={(e) => setFeedback(e.target.value)} aria-describedby="plan-feedback-about" className="ds-field__control ds-textarea" />
                    <p id="plan-feedback-about" className="ds-field__description">Request changes sends the plan as it stands here, with this feedback, back to the planner, and its new plan takes this one's place.</p>
                  </div>
                  <div className="ds-cluster">
                    <button type="button" aria-busy={busy === "changes"} disabled={busy !== null && busy !== "changes"} onClick={() => decide("changes")} className="ds-button">
                      {busy === "changes" ? "Requesting changes" : "Request changes"}
                    </button>
                    {cancel}
                  </div>
                </div>
              </section>
            )}

            {(planning || building) && (
              <>
                {decisionProblem !== null && (
                  <Alert tone="error" role="alert">
                    {decisionProblem}
                  </Alert>
                )}
                <div className="ds-cluster">{cancel}</div>
              </>
            )}

            {run.tasks.length > 0 && (
              <section aria-labelledby="run-tasks-heading" className="ds-stack ds-gap-sm">
                <h2 id="run-tasks-heading">Tasks</h2>
                <ul data-testid="run-tasks" className="ds-list">
                  {run.tasks.map((task) => (
                    <li key={task.id} className="ds-list__row">
                      <div className="ds-stack ds-gap-sm min-w-0 flex-1">
                        <a href={`#/tasks/${task.id}`} className="ds-list__link">
                          <span className="ds-run-status">
                            <span data-ds-content="" className="ds-run-status__title">
                              {task.title}
                            </span>
                            <span className="ds-run-status__station">
                              <StatusBadge look={statusLook({ status: task.status, waitingOnApproval: task.waitingOnApproval, resuming: false, waitingFor: task.waitingFor })}>{statusWord({ status: task.status, waitingOnApproval: task.waitingOnApproval, resuming: false, waitingFor: task.waitingFor })}</StatusBadge>
                            </span>
                            <span className="ds-run-status__facts">
                              {`Task ${task.id} · `}
                              <span data-testid="run-task-branch">{taskFacts(task)}</span>
                            </span>
                          </span>
                        </a>
                        {runTaskNote(task) !== null && <p data-ds-content="">{runTaskNote(task)}</p>}
                        {task.restartLine !== null && <p data-testid="run-task-restart">{task.restartLine}</p>}
                        <CommandRounds lists={task.commandLists} rows={task.evidence.filter((row) => row.kind === "setup")} what={{ one: "setup command", many: "setup commands" }} />
                        {task.checks !== null && <ChecksResult checks={task.checks} rows={latestRound(task.evidence.filter((row) => row.kind === "check"))} />}
                        <CommandRounds lists={task.commandLists} rows={task.evidence.filter((row) => row.kind === "check")} what={{ one: "check", many: "checks" }} failedFirst />
                        {task.resumeNote !== null && <ResumeControl taskId={task.id} note={task.resumeNote} name={`task ${task.id}`} primary={false} onResumed={load} onSignedOut={onSignedOut} />}
                        {task.status === "awaiting_decision" && <DecisionControls taskId={task.id} leftovers={task.leftovers} primary={false} name={`task ${task.id}`} onDecided={load} onSignedOut={onSignedOut} />}
                        {task.decision !== null && <DecisionOutcome decision={task.decision} repo={run.repo} merge={offersMerge(task)} compact />}
                        {task.pullRequest.state !== "none" && (
                          <p data-testid="run-task-pull-request" data-ds-content="">
                            {pullRequestWords(task.pullRequest)}
                          </p>
                        )}
                        <PullRequestLink view={task.pullRequest} />
                      </div>
                    </li>
                  ))}
                </ul>
                {run.tasks.some((task) => task.evidence.some((row) => row.kind === "check")) && <p data-testid="run-checks-line">{CHECKS_LINE}</p>}
              </section>
            )}

            {run.preapproved.length > 0 && (
              <section className="ds-stack ds-gap-sm">
                <h2>Allowed for this run</h2>
                <ul data-testid="run-preapproved" className="ds-list ds-list--dense">
                  {run.preapproved.map((command) => (
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
                <p>You listed these when you started the run, for when its tasks are built. Planning uses none of them.</p>
              </section>
            )}

            {planning ? (
              <section aria-labelledby="planning-heading" className="ds-stack ds-gap-sm">
                <h2 id="planning-heading">Planning</h2>
                {transcript}
              </section>
            ) : (
              shown.length > 0 && (
                <details className="ds-disclosure">
                  <summary className="ds-disclosure__summary">How the plan was made</summary>
                  <div className="ds-disclosure__content">{transcript}</div>
                </details>
              )
            )}
          </>
        )}
      </Page>
      <div role="status" aria-live="polite" aria-atomic="false" className="ds-toast__region">
        {deleted !== null && (
          <div className="ds-toast ds-toast--success ds-undo-toast">
            <p className="ds-toast__message">
              <span className="ds-toast__label">Done:</span> {`Task ${deleted.at + 1} deleted from the plan.`}
              <span className="ds-visually-hidden">{` You have ${UNDO_SECONDS} seconds to undo.`}</span>
              {!deleted.undoing && <span aria-hidden="true" className="ds-undo-toast__countdown">{` ${deleted.left} ${deleted.left === 1 ? "second" : "seconds"} left to undo`}</span>}
            </p>
            <button type="button" aria-busy={deleted.undoing} onClick={undo} className="ds-button ds-button--small ds-toast__action">
              {deleted.undoing ? "Putting the task back" : "Undo"}
            </button>
          </div>
        )}
      </div>
    </Frame>
  );
}
