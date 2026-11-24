import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible";
import { Separator } from "@/ui/separator";
import { ApiError, approvePlan, cancelRun, getRun, getTranscript, openEventStream, requestPlanChanges, savePlan, type RunDetail, type StoredEvent } from "../../api/client.ts";
import { ApprovalsContext } from "../../app/approvals.tsx";
import { arrive, setLeaveGuard, tabTitle } from "../../app/arrival.ts";
import { APPROVAL_LIMIT_WORDS, folderName, limitName } from "../../app/composer.ts";
import { fullDate } from "../../app/format.ts";
import { editChanged, editStands, fromLines, NEW_EDIT, openEdit } from "../../app/plan-edit.ts";
import { MODE_NAMES, modeSentence } from "../../app/run-words.ts";
import { useThreePanes } from "../../app/wide.ts";
import { ApprovalQueue } from "../decision/decision-surface.tsx";
import { modelState, sessionModel, useModelNames } from "../../components/model-picker.tsx";
import { runLook, runSentence, runWord } from "../../components/run-status.ts";
import { mergeEvents, Transcript } from "../../components/transcript.tsx";
import { NextShell } from "../../shell/shell.tsx";
import { justDeleted, PlanDecision, PlanList, type Deleted, type Editing } from "./plan.tsx";
import { decidedCount, pullRequests } from "./run-model.ts";
import { OutLink, RunMenu, RunSteps, StateBadge, TaskRows } from "./run-parts.tsx";

/*
 * A run, rebuilt on shadcn/ui and Tailwind 4 (ADR 0012), at the run's own address. It has three real steps, Plan, Build
 * and Decide, and the screen is what the step it is at needs: while the plan waits for the owner the plan is the
 * content, each task a card edited in place, with the decision on it in the inspector (a sticky area under 1280px);
 * while it builds, the steps and the tasks as rows, each a link to its task; once it has ended, how it ended in one
 * sentence, the tasks and the pull requests it opened. The inspector holds what the run was started with, and the bar
 * the run's own controls as a menu. Everything shown is read through the API client, and every sentence about the
 * run's state is components/run-status.ts's. The planner's request, its transcript, and what a task's row holds under
 * its link are the components the old screens draw, unchanged, until their rebuilt ones exist.
 */

/** One fact of the run in the inspector: its name over its value. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5">
      <dt className="text-meta text-muted-foreground">{name}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/** A plain notice in the main column: a hairline card with the words, and amber or red only as a thin edge and the text of a problem. */
function Notice({ tone, role, testId, children }: { tone: "note" | "waits" | "problem"; role: "status" | "alert"; testId?: string; children: ReactNode }) {
  return (
    <p role={role} data-testid={testId} className={tone === "problem" ? "rounded-xl border border-destructive/60 bg-destructive-subtle px-5 py-3 text-base text-destructive" : tone === "waits" ? "rounded-xl border border-attention/50 px-5 py-3 text-base" : "rounded-xl border px-5 py-3 text-base text-muted-foreground"}>
      {children}
    </p>
  );
}

export default function RunScreen({ id, onSignedOut }: { id: number; onSignedOut: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  // The question whether to lose typed words is open: asked by Cancel or Escape (`to` null), or by a change of address,
  // which is then where the owner goes once the words are discarded.
  const [leaving, setLeaving] = useState<{ to: string | null } | null>(null);
  // Said in place of an editor that was closed because the plan moved on in another window.
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const waitingForPlan = run?.status === "awaiting_plan_approval";
  const unsaved = editing !== null && run !== null && waitingForPlan && editChanged(editing);
  useEffect(() => {
    // The plan was approved, the run cancelled or the task taken out elsewhere: there is no editor to show any more.
    if (editing === null || run === null || editStands(editing, run.plan, waitingForPlan)) return;
    if (editChanged(editing)) setEditNotice("The plan changed in another window, so the task you were editing was closed. What you typed was not saved.");
    setEditing(null);
    setLeaving(null);
  }, [editing, run, waitingForPlan]);
  useEffect(() => {
    if (!unsaved) return;
    // Closing the tab or loading the page again asks first, in the browser's own words. A change of address inside
    // Botbench (the navigation, a link, Back) asks with the same question as Cancel.
    const ask = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", ask);
    setLeaveGuard((to) => {
      setLeaving({ to });
      return false;
    });
    return () => {
      window.removeEventListener("beforeunload", ask);
      setLeaveGuard(null);
    };
  }, [unsaved]);
  const [busy, setBusy] = useState<"save" | "approve" | "changes" | "cancel" | null>(null);
  const [decisionProblem, setDecisionProblem] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  // Under 1280px the feedback field is in the sticky area only once Request changes was pressed.
  const [askingChanges, setAskingChanges] = useState(false);
  const [deleted, setDeleted] = useState<Deleted | null>(null);
  const missing = useRef(false);
  const nameOf = useModelNames(onSignedOut);
  const threePanes = useThreePanes();
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

  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = tabTitle(`Run ${id}`);
    arrive(heading.current);
  }, [id]);

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

  /** The card the open editor returns focus to. */
  const editRow = (): number => (editing === null || run === null ? 0 : editing.at === "new" ? run.plan.length : editing.at);
  /** Cancel or Escape in the editor: at once when nothing was typed, and after a question when words would be lost. */
  const cancelEdit = (): void => {
    if (unsaved) return setLeaving({ to: null });
    const at = editRow();
    setEditing(null);
    focusEdit(at);
  };
  /** The question's answer. Kept: the dialog gives focus back to where it was. Discarded: the card, or the address the owner was going to. */
  const answeredLeaving = (discard: boolean): void => {
    const to = leaving?.to ?? null;
    setLeaving(null);
    if (!discard) return;
    const at = editRow();
    setEditing(null);
    if (to === null) return focusEdit(at);
    setLeaveGuard(null);
    window.location.hash = to;
  };

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
        // The card stays in editing with what was typed.
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
        setDeleted(justDeleted(task, at));
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
        if (what === "changes") {
          setFeedback("");
          setAskingChanges(false);
        }
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
  const working = planning && attemptId !== null && !shown.some((e) => e.type === "turn_ended" && e.id === shown.at(-1)?.id) ? (asking === undefined ? "Claude Code is planning." : "") : null;
  const transcript = (
    // The planning prompt is Botbench's own, with the owner's words inside it, so the row says Botbench wrote it.
    <Transcript events={shown} working={working} modelName={nameOf} promptBy="Botbench, to Claude Code" folded={!planning} />
  );
  const startOpen = (next: Editing): void => {
    setEditNotice(null);
    setEditing(next);
  };
  const decision = run !== null && gate && (
    <PlanDecision count={run.plan.length} compact={!threePanes} busy={busy === "approve" || busy === "changes" ? busy : busy === null ? null : "other"} problem={decisionProblem} feedback={feedback} asking={askingChanges} onFeedback={(text) => (setFeedback(text), setDecisionProblem(null))} onAsking={setAskingChanges} onApprove={() => decide("approve")} onChanges={() => decide("changes")} />
  );
  const opened = run === null ? [] : pullRequests(run);
  const summary = run === null ? null : { status: run.status, waitingOnApproval: run.waitingOnApproval, attemptId: run.attemptId, decidedCount: decidedCount(run) };

  const about = run !== null && (
    <>
      <section aria-labelledby="run-facts-heading">
        <h2 id="run-facts-heading" className="mb-1 text-meta font-semibold text-muted-foreground">
          This run
        </h2>
        <dl data-testid="run-facts" className="flex flex-col [&>div+div]:border-t">
          <Fact name="Mode">
            <span className="font-semibold">{MODE_NAMES[run.mode]}</span>
            {/* The whole sentence, with the mode's name first, as every screen says a run's mode. */}
            <span data-testid="run-mode" className="mt-0.5 block text-meta text-muted-foreground">
              {modeSentence(run.mode, run.issueHosts)}
            </span>
          </Fact>
          {run.modeChanges.length > 0 && (
            <Fact name="Changes of mode">
              <ul data-testid="run-mode-changes" className="flex flex-col gap-1">
                {run.modeChanges.map((change) => (
                  <li key={change.at + change.to}>{`${fullDate(change.at)}: ${change.words}`}</li>
                ))}
              </ul>
            </Fact>
          )}
          <Fact name="Repository">
            <code data-testid="run-repo" data-ds-content="" className="break-all">
              {run.repo}
            </code>
          </Fact>
          {run.source !== null && (
            // The finished task or the chat this run was made from, with the owner's note as its message.
            <Fact name="Made from">
              <a data-testid="run-source" href={run.source.kind === "task" ? `#/tasks/${run.source.id}` : `#/chats/${run.source.id}`} className="inline-flex min-h-(--control) items-center text-primary underline-offset-4 hover:underline">
                {run.source.label}
              </a>
            </Fact>
          )}
          {run.issue !== null && (
            <Fact name="Started from">
              <OutLink href={run.issue.url} testId="issue-link">{`Issue #${run.issue.number} on GitHub`}</OutLink>
            </Fact>
          )}
          {run.claim !== null && (
            <Fact name="Other workbenches">
              <span data-testid="run-claim" data-ds-content="">
                {run.claim.words}
              </span>
            </Fact>
          )}
          {run.specPath !== null && (
            <Fact name="Spec file">
              <code data-testid="run-spec" data-ds-content="" className="break-all">
                {run.specPath}
              </code>
            </Fact>
          )}
          <Fact name="Planning model">
            <span data-testid="run-model">{`${run.attemptId === null ? "not started yet" : modelState(session, nameOf)}. You asked for: ${run.requestedModel === null ? "Claude Code's default" : nameOf(run.requestedModel)}.`}</span>
          </Fact>
          {run.buildModel !== undefined && (
            <Fact name="Build model">
              <span data-testid="run-build-model">{`The tasks are built on what you asked for: ${run.buildModel === null ? "Claude Code's default" : nameOf(run.buildModel)}.`}</span>
            </Fact>
          )}
          <Fact name="When you accept a task">
            <span data-testid="run-delivery">{run.delivery === "pull_request" ? "Botbench pushes its branch and opens a pull request" : "Its branch is kept on this Mac"}</span>
          </Fact>
          <Fact name="Approval time limit">
            <span data-testid="run-approval-limit">{run.approvalLimitMinutes === null ? `Off. ${APPROVAL_LIMIT_WORDS.off}` : `${limitName(run.approvalLimitMinutes)}. ${APPROVAL_LIMIT_WORDS.on(run.approvalLimitMinutes)}`}</span>
          </Fact>
        </dl>
      </section>
      {opened.length > 0 && (
        <section aria-labelledby="run-prs-heading">
          <h2 id="run-prs-heading" className="mb-1 text-meta font-semibold text-muted-foreground">
            Pull requests
          </h2>
          <ul data-testid="run-pull-requests" className="flex flex-col [&>li+li]:border-t">
            {opened.map((row) => (
              <li key={row.taskId} className="flex flex-col py-2">
                <span data-ds-content="" className="text-sm break-words">
                  {row.title}
                </span>
                <OutLink href={row.view.url}>{`Pull request #${row.view.number} on GitHub`}</OutLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.preapproved.length > 0 && (
        <section aria-labelledby="run-allowed-heading">
          <h2 id="run-allowed-heading" className="mb-1 text-meta font-semibold text-muted-foreground">
            Allowed for this run
          </h2>
          <ul data-testid="run-preapproved" className="flex flex-col gap-1 py-1">
            {run.preapproved.map((command) => (
              <li key={command}>
                <code data-ds-content="" className="break-all">
                  {command}
                </code>
              </li>
            ))}
          </ul>
          <p className="text-meta text-muted-foreground">You listed these when you started the run, for when its tasks are built. Planning uses none of them.</p>
        </section>
      )}
    </>
  );

  return (
    <NextShell
      open={run === null ? null : { title: run.title, href: `#/runs/${id}` }}
      bar={
        <>
          <nav aria-label="Where this is" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <a href="#/work" className="inline-flex min-h-(--control-small) items-center text-muted-foreground hover:text-foreground">
              Work
            </a>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span className="font-semibold">{`Run ${id}`}</span>
            {run !== null && summary !== null && (
              <>
                <StateBadge look={runLook(summary)} testId="run-state">
                  {runWord(summary)}
                </StateBadge>
                <span data-ds-content="" className="ml-auto text-muted-foreground max-md:hidden">
                  {folderName(run.repo)}
                </span>
              </>
            )}
          </nav>
          {run !== null && <RunMenu run={run} cancelling={busy === "cancel"} busy={busy !== null} onCancel={() => decide("cancel")} onChanged={setRun} onSignedOut={onSignedOut} />}
        </>
      }
      aside={
        // From 1280px the inspector stands at the right. Under that, what it holds follows the content in the one column,
        // so the plan's decision can stay at the foot of the window over all of it.
        run !== null &&
        threePanes && (
          <aside aria-label="About this run" className="border-l bg-pane px-6 py-6 xl:min-h-svh">
            <div className="sticky top-6 flex flex-col gap-6">
              {decision}
              {about}
            </div>
          </aside>
        )
      }
    >
      <main className="flex min-w-0 flex-1 flex-col px-4 pt-4 md:px-8">
        <div className="mx-auto flex w-full max-w-[47.5rem] flex-1 flex-col gap-6 pb-12">
          <header className="flex flex-col gap-2">
            {/* The view's one h1: the run's title, the owner's own words, or Botbench's name for it while it is read. */}
            <h1 ref={heading} tabIndex={-1} data-ds-content={run === null ? undefined : ""} className="text-[1.5rem] leading-[1.875rem] font-bold tracking-tight text-balance outline-none md:text-title">
              {run === null ? `Run ${id}` : run.title}
            </h1>
            {run !== null && (
              <p data-testid="run-status" role="status" className="text-base text-muted-foreground">
                {runSentence(run)}
              </p>
            )}
          </header>
          {problem !== null && (
            <Notice tone="problem" role="alert">
              {problem}
            </Notice>
          )}
          {run === null ? (
            problem === null && (
              <p role="status" className="text-base text-muted-foreground">
                Reading the run.
              </p>
            )
          ) : (
            <>
              <RunSteps run={run} id={id} />
              {run.outsideText && (
                <Notice tone="note" role="status" testId="outside-text">
                  <span className="font-semibold text-foreground">Outside text. </span>
                  This run read a GitHub issue, which people outside this project wrote. No command is allowed for it in advance or always allowed, and it cannot be fully autonomous.
                </Notice>
              )}
              {editNotice !== null && (
                <Notice tone="note" role="status" testId="edit-closed">
                  {editNotice}
                </Notice>
              )}
              {gate && run.reason !== null && (
                <Notice tone="waits" role="status">
                  {run.reason}
                </Notice>
              )}
              {/* A decision that failed outside the plan gate (Cancel run) is said here; at the gate the decision says it. */}
              {!gate && decisionProblem !== null && (
                <Notice tone="problem" role="alert">
                  {decisionProblem}
                </Notice>
              )}

              <ApprovalQueue waiting={waiting} on="run" onSignedOut={onSignedOut} />

              {gate && (
                <section aria-labelledby="plan-heading" className="flex flex-col gap-3">
                  <h2 id="plan-heading" className="text-heading font-semibold tracking-tight">
                    Plan
                  </h2>
                  <PlanList
                    plan={run.plan}
                    editing={editing}
                    locked={busy !== null || editing !== null}
                    saving={busy === "save"}
                    deleted={deleted}
                    onEdit={(at) => startOpen({ ...openEdit(at, run.plan[at]!), problem: {} })}
                    onAdd={() => startOpen({ ...NEW_EDIT, problem: {} })}
                    onDelete={remove}
                    onChange={setEditing}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                    onUndo={undo}
                  />
                </section>
              )}

              {run.tasks.length > 0 && (
                <section aria-labelledby="run-tasks-heading" className="flex flex-col gap-3">
                  <h2 id="run-tasks-heading" className="text-heading font-semibold tracking-tight">
                    Tasks
                  </h2>
                  <TaskRows run={run} onChanged={load} onSignedOut={onSignedOut} />
                </section>
              )}

              {planning ? (
                <section aria-labelledby="planning-heading" className="flex flex-col gap-3">
                  <h2 id="planning-heading" className="text-heading font-semibold tracking-tight">
                    Planning
                  </h2>
                  {transcript}
                </section>
              ) : (
                shown.length > 0 && (
                  <Collapsible data-testid="plan-made" className="rounded-xl border">
                    <CollapsibleTrigger render={<Button variant="ghost" className="group/made h-auto min-h-(--control) w-full justify-start rounded-xl px-5 font-semibold" />}>
                      <ChevronRight aria-hidden="true" className="transition-transform group-data-panel-open/made:rotate-90" />
                      How the plan was made
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <Separator />
                      <div className="px-5 py-4">{transcript}</div>
                    </CollapsibleContent>
                  </Collapsible>
                )
              )}
            </>
          )}
          {!threePanes && about !== false && (
            <section aria-label="About this run" className="flex flex-col gap-6 border-t pt-6">
              {about}
            </section>
          )}
        </div>
        {!threePanes && decision}
      </main>
      {/* Words typed into a task would be lost: asked before they are, with the focus on the button that keeps them. */}
      <AlertDialog open={leaving !== null} onOpenChange={(open) => !open && answeredLeaving(false)}>
        <AlertDialogContent data-testid="discard-edit">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-heading font-semibold">Discard what you typed?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to this task are not saved. The plan stays as it was.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => answeredLeaving(true)}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </NextShell>
  );
}
