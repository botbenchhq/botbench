import { useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, approvePlan, cancelRun, getRun, getTranscript, openEventStream, requestPlanChanges, savePlan, type PlanTask, type RunDetail, type RunTask, type StoredEvent } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ApprovalCard } from "../components/approval-card.tsx";
import { ConfirmAction } from "../components/confirm.tsx";
import { CHECKS_RISK, ChecksResult, CommandEvidence } from "../components/evidence.tsx";
import { Alert, Frame, Page, PageHeader, StreamBanner } from "../components/header.tsx";
import { Icon } from "../components/icon.tsx";
import { modelState, sessionModel, useModelNames } from "../components/model-picker.tsx";
import { runSentence } from "../components/run-status.ts";
import { statusLook, statusWord } from "../components/task-status.ts";
import { mergeEvents, Transcript } from "../components/transcript.tsx";

const UNDO_SECONDS = 10;
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
      <div data-gw-content="" className="gw-editable-list__text gw-stack gw-gap-xs">
        <strong>{task.title}</strong>
        <ul aria-label={`Acceptance criteria of task ${number}`} className="gw-stack gw-gap-xs">
          {task.criteria.map((criterion, i) => (
            <li key={i}>{criterion}</li>
          ))}
        </ul>
      </div>
      <span className="gw-editable-list__actions">
        <button type="button" data-edit={number - 1} disabled={locked} data-gw-content-label="" aria-label={`Edit task ${number}: ${task.title}`} onClick={onEdit} className="gw-button gw-button--quiet gw-button--small">
          Edit
        </button>
        <button type="button" disabled={locked} data-gw-content-label="" aria-label={`Delete task ${number}: ${task.title}`} onClick={onDelete} className="gw-button gw-button--quiet gw-button--small">
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
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && !saving && onCancel()} className="gw-editable-list__editor" noValidate>
      <div className="gw-field">
        <label htmlFor="plan-title" className="gw-field__label">{`${name} title`}</label>
        <input ref={title} id="plan-title" type="text" autoComplete="off" readOnly={saving} value={editing.title} onChange={(e) => onChange({ ...editing, title: e.target.value })} aria-invalid={editing.problem.title !== undefined} aria-describedby={editing.problem.title === undefined ? undefined : "plan-title-error"} className="gw-field__control" />
        {editing.problem.title !== undefined && (
          <p id="plan-title-error" className="gw-field__error">
            {editing.problem.title}
          </p>
        )}
      </div>
      <div className="gw-field">
        <label htmlFor="plan-criteria" className="gw-field__label">{`${name} acceptance criteria`}</label>
        <textarea id="plan-criteria" readOnly={saving} value={editing.criteria} onChange={(e) => onChange({ ...editing, criteria: e.target.value })} aria-invalid={editing.problem.criteria !== undefined} aria-describedby={editing.problem.criteria === undefined ? "plan-criteria-about" : "plan-criteria-about plan-criteria-error"} className="gw-field__control gw-textarea" />
        <p id="plan-criteria-about" className="gw-field__description">One criterion on each line: a sentence that can be checked when the task is done.</p>
        {editing.problem.criteria !== undefined && (
          <p id="plan-criteria-error" className="gw-field__error">
            {editing.problem.criteria}
          </p>
        )}
      </div>
      {editing.problem.save !== undefined && (
        <p role="alert" className="gw-field__error">
          {editing.problem.save}
        </p>
      )}
      <div className="gw-editable-list__editor-actions">
        <button type="submit" aria-busy={saving} className="gw-button gw-button--small">
          {saving ? "Saving task" : "Save task"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel} className="gw-button gw-button--quiet gw-button--small">
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
  if (task.status === "building") return task.waitingOnApproval ? "Claude Code is waiting for your answer" : task.attemptId === null ? "Preparing a separate copy of the project" : "Claude Code is working; open it to watch";
  if (task.status === "awaiting_decision") return task.branch ?? "Built";
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
  const working = planning && attemptId !== null && !shown.some((e) => e.type === "turn_ended" && e.id === shown.at(-1)?.id) ? (asking === undefined ? "Claude Code is planning." : "Claude Code is paused until you answer.") : null;
  const transcript = (
    // The planning prompt is Botbench's own, with the owner's words inside it, so the row says Botbench wrote it.
    <Transcript events={shown} working={working} modelName={nameOf} promptBy="Botbench, to Claude Code" folded={!planning} />
  );
  const cancel = run !== null && (planning || gate || building) && (
    <ConfirmAction label="Cancel run" title="Cancel this run?" confirmLabel="Cancel run" cancelLabel="Keep run" disabled={busy !== null} losing testId="cancel-run" onConfirm={() => decide("cancel")}>
      <p>
        {planning
          ? "The planner is stopped and no plan is kept. Nothing was built."
          : gate
            ? `The plan of ${tasksWord(run.plan.length)} is dropped and nothing is built. A cancelled run cannot be started again; start a new one instead.`
            : "Tasks that have finished keep their branches. The task being built is stopped, and what it did so far is committed to its branch. Tasks that have not started are not built. A cancelled run cannot be started again."}
      </p>
    </ConfirmAction>
  );

  return (
    <Frame current={null} banner={connected ? undefined : <StreamBanner />}>
      <Page>
        {/* The page header comes first and holds the view's one h1, also while the run is being read or cannot be. */}
        <PageHeader title={`Run ${id}`}>
          {run !== null && (
            <p data-testid="run-status" role="status" className="gw-page-header__description">
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
            <p role="status" className="gw-spinner">
              Reading the run.
            </p>
          )
        ) : (
          <>
            <dl className="gw-key-value">
              <div className="gw-key-value__item">
                <dt className="gw-key-value__label">Repository</dt>
                <dd data-testid="run-repo" data-gw-content="" className="gw-key-value__value gw-key-value__value--mono">
                  {run.repo}
                </dd>
              </div>
              {run.specPath !== null && (
                <div className="gw-key-value__item">
                  <dt className="gw-key-value__label">Spec file</dt>
                  <dd data-testid="run-spec" data-gw-content="" className="gw-key-value__value gw-key-value__value--mono">
                    {run.specPath}
                  </dd>
                </div>
              )}
              <div className="gw-key-value__item">
                <dt className="gw-key-value__label">Planning model</dt>
                <dd data-testid="run-model" className="gw-key-value__value">{`${run.attemptId === null ? "not started yet" : modelState(session, nameOf)}. You asked for: ${run.requestedModel === null ? "Claude Code's default" : nameOf(run.requestedModel)}.`}</dd>
              </div>
            </dl>

            {gate && run.reason !== null && (
              <Alert tone="warning" role="status">
                {run.reason}
              </Alert>
            )}

            {asking !== undefined && <ApprovalCard key={asking.id} approval={asking} more={waiting.length - 1} onSignedOut={onSignedOut} />}

            {gate && (
              <section aria-labelledby="plan-heading" className="gw-stack gw-gap-lg">
                <h2 id="plan-heading">Plan</h2>
                <div className="gw-editable-list">
                  {run.plan.length === 1 && <p className="gw-editable-list__note">A plan holds at least one task. To drop this one too, cancel the run.</p>}
                  <ol aria-label="Plan" className="gw-editable-list__items">
                    {run.plan.map((task, i) => (
                      <li key={i} className="gw-editable-list__item">
                        {editing?.at === i ? (
                          <PlanEditor editing={editing} name={`Task ${i + 1}`} saving={busy === "save"} onChange={setEditing} onSave={saveEdit} onCancel={() => (setEditing(null), focusEdit(i))} />
                        ) : (
                          <PlanRow task={task} number={i + 1} locked={busy !== null || editing !== null} onEdit={() => setEditing({ at: i, title: task.title, criteria: toLines(task.criteria), problem: {} })} onDelete={() => remove(i)} />
                        )}
                      </li>
                    ))}
                    {editing?.at === "new" && (
                      <li className="gw-editable-list__item">
                        <PlanEditor editing={editing} name="New task" saving={busy === "save"} onChange={setEditing} onSave={saveEdit} onCancel={() => (setEditing(null), focusEdit(run.plan.length))} />
                      </li>
                    )}
                  </ol>
                  {editing?.at !== "new" && (
                    <div className="gw-editable-list__add">
                      <button type="button" data-add-task disabled={busy !== null || editing !== null || run.plan.length >= 20} onClick={() => setEditing({ at: "new", title: "", criteria: "", problem: {} })} className="gw-button gw-button--quiet">
                        <Icon name="plus" className="gw-button__icon" />
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
                <div className="gw-cluster">
                  <button type="button" aria-busy={busy === "approve"} disabled={busy !== null && busy !== "approve"} onClick={() => decide("approve")} className="gw-button gw-button--primary">
                    {busy === "approve" ? "Approving" : `Approve ${tasksWord(run.plan.length)}`}
                  </button>
                </div>
                <p>Approving starts building the tasks, one at a time, in this order.</p>

                <div className="gw-stack gw-gap-sm">
                  <div className="gw-field">
                    <label htmlFor="plan-feedback" className="gw-field__label">
                      Feedback for the planner
                    </label>
                    <textarea id="plan-feedback" value={feedback} onChange={(e) => setFeedback(e.target.value)} aria-describedby="plan-feedback-about" className="gw-field__control gw-textarea" />
                    <p id="plan-feedback-about" className="gw-field__description">Request changes sends the plan as it stands here, with this feedback, back to the planner, and its new plan takes this one's place.</p>
                  </div>
                  <div className="gw-cluster">
                    <button type="button" aria-busy={busy === "changes"} disabled={busy !== null && busy !== "changes"} onClick={() => decide("changes")} className="gw-button">
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
                <div className="gw-cluster">{cancel}</div>
              </>
            )}

            {run.tasks.length > 0 && (
              <section aria-labelledby="run-tasks-heading" className="gw-stack gw-gap-sm">
                <h2 id="run-tasks-heading">Tasks</h2>
                <ul data-testid="run-tasks" className="gw-list">
                  {run.tasks.map((task) => (
                    <li key={task.id} className="gw-list__row">
                      <div className="gw-stack gw-gap-sm min-w-0 flex-1">
                        <a href={`#/tasks/${task.id}`} className="gw-list__link">
                          <span className="gw-run-status">
                            <span data-gw-content="" className="gw-run-status__title">
                              {task.title}
                            </span>
                            <span className="gw-run-status__station">
                              <span className={statusLook({ status: task.status, waitingOnApproval: task.waitingOnApproval, resuming: false })}>{statusWord({ status: task.status, waitingOnApproval: task.waitingOnApproval, resuming: false })}</span>
                            </span>
                            <span className="gw-run-status__facts">{`Task ${task.id} · ${taskFacts(task)}`}</span>
                          </span>
                        </a>
                        {(task.status === "failed" || task.status === "cancelled" || task.status === "interrupted") && task.reason !== null && <p data-gw-content="">{task.reason}</p>}
                        <CommandEvidence rows={task.evidence.filter((row) => row.kind === "setup")} what={{ one: "setup command", many: "setup commands" }} />
                        {task.checks !== null && <ChecksResult checks={task.checks} rows={task.evidence.filter((row) => row.kind === "check")} />}
                        <CommandEvidence rows={task.evidence.filter((row) => row.kind === "check")} what={{ one: "check", many: "checks" }} failedFirst />
                      </div>
                    </li>
                  ))}
                </ul>
                {run.tasks.some((task) => task.evidence.some((row) => row.kind === "check")) && <p>{CHECKS_RISK}</p>}
              </section>
            )}

            {run.preapproved.length > 0 && (
              <section className="gw-stack gw-gap-sm">
                <h2>Allowed for this run</h2>
                <ul data-testid="run-preapproved" className="gw-list gw-list--dense">
                  {run.preapproved.map((command) => (
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
                <p>You listed these when you started the run, for when its tasks are built. Planning uses none of them: every command it wants asks.</p>
              </section>
            )}

            {planning ? (
              <section aria-labelledby="planning-heading" className="gw-stack gw-gap-sm">
                <h2 id="planning-heading">Planning</h2>
                {transcript}
              </section>
            ) : (
              shown.length > 0 && (
                <details className="gw-disclosure">
                  <summary className="gw-disclosure__summary">How the plan was made</summary>
                  <div className="gw-disclosure__content">{transcript}</div>
                </details>
              )
            )}
          </>
        )}
      </Page>
      <div role="status" aria-live="polite" aria-atomic="false" className="gw-toast__region">
        {deleted !== null && (
          <div className="gw-toast gw-toast--success gw-undo-toast">
            <p className="gw-toast__message">
              <span className="gw-toast__label">Done:</span> {`Task ${deleted.at + 1} deleted from the plan.`}
              <span className="gw-visually-hidden">{` You have ${UNDO_SECONDS} seconds to undo.`}</span>
              {!deleted.undoing && <span aria-hidden="true" className="gw-undo-toast__countdown">{` ${deleted.left} ${deleted.left === 1 ? "second" : "seconds"} left to undo`}</span>}
            </p>
            <button type="button" aria-busy={deleted.undoing} onClick={undo} className="gw-button gw-button--small gw-toast__action">
              {deleted.undoing ? "Putting the task back" : "Undo"}
            </button>
          </div>
        )}
      </div>
    </Frame>
  );
}
