import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { cn } from "@/ui/lib/utils";
import { ApiError, changeRunMode, type RunDetail, type RunMode, type RunTask } from "../../api/client.ts";
import { cancelStatement } from "../../app/row-menu.ts";
import { MODE_NAMES, STRICTER_HINT } from "../../app/run-words.ts";
import { DecisionControls, DecisionOutcome } from "../../components/decision.tsx";
import { CHECKS_LINE, ChecksResult, CommandRounds, latestRound } from "../../components/evidence.tsx";
import type { Look } from "../../components/looks.ts";
import { MODES } from "../../components/mode-choice.tsx";
import { pullRequestWords } from "../../components/pull-request.tsx";
import { ResumeControl } from "../../components/resume.tsx";
import { runTaskNote, stations, type StationState } from "../../components/run-status.ts";
import { offersMerge } from "../../components/task-status.ts";
import { rowState, runControls, stateTone, taskFacts, type StateTone } from "./run-model.ts";

/*
 * The pieces of the rebuilt run screen (ADR 0012): the three steps, a state's mark, the run's tasks as rows, and the
 * run's own controls as a menu. Which steps there are and where the run stands in them is components/run-status.ts's;
 * what the menu offers is the server's (`modeChoices`) and the run's state.
 */

const TONES: Record<StateTone, string> = {
  neutral: "border-border text-muted-foreground",
  working: "border-transparent bg-primary-subtle text-primary",
  waits: "border-transparent bg-attention-subtle text-attention",
  success: "border-transparent bg-success-subtle text-success",
  failed: "border-transparent bg-destructive-subtle text-destructive",
};

/** A state in the product's own word, with its mark: a ring for work under way, a dot for what waits or succeeded, a cross for a failure. The word says the state; the mark and tone only repeat it. */
export function StateBadge({ look, testId, children }: { look: Look; testId?: string; children: string }) {
  const tone = stateTone(look);
  return (
    <span data-testid={testId} data-tone={tone} className={cn("inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-sm border px-2 text-xs font-semibold whitespace-nowrap", TONES[tone])}>
      {tone === "failed" ? <X aria-hidden="true" className="size-3" /> : tone === "working" ? <span aria-hidden="true" className="size-2 rounded-full border-2 border-current" /> : tone === "neutral" ? null : <span aria-hidden="true" className="size-2 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STEP_MARK: Record<StationState, string> = {
  done: "border-transparent bg-success-subtle text-success",
  running: "border-primary text-primary",
  waiting: "border-attention text-attention",
  failed: "border-transparent bg-destructive-subtle text-destructive",
  "not-started": "border-edge text-muted-foreground",
};

/** A run's three steps, Plan, Build and Decide, in a line: each with its state in words, and the one the run is at marked as the current step. Nothing for a cancelled run, whose state in words says what happened. */
export function RunSteps({ run, id }: { run: Pick<RunDetail, "status" | "attemptId" | "waitingOnApproval" | "tasks">; id: number }) {
  const shown = stations(run);
  if (shown === null) return null;
  return (
    <ol aria-label={`Steps of run ${id}`} data-testid="run-steps" className="grid gap-x-3 gap-y-3 sm:grid-cols-3">
      {shown.stations.map((station, at) => (
        <li key={station.name} data-state={station.state} aria-current={at === shown.current ? "step" : undefined} className="flex min-w-0 items-start gap-3">
          <span aria-hidden="true" className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold tabular-nums", STEP_MARK[station.state])}>
            {station.state === "done" ? <Check className="size-3.5" /> : station.state === "failed" ? <X className="size-3.5" /> : station.state === "running" ? <span className="size-2 rounded-full bg-current" /> : at + 1}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-3">
              <span data-step="name" className={cn("text-sm font-semibold", station.state === "not-started" && "text-muted-foreground")}>
                {station.name}
              </span>
              {/* The line to the next step, where the steps stand side by side. */}
              {at < shown.stations.length - 1 && <span aria-hidden="true" className="h-px flex-1 bg-border max-sm:hidden" />}
            </span>
            <span data-step="words" className="text-meta text-muted-foreground">
              {station.words}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The run's tasks as rows: the title, the state in the product's own word with its mark, and what the task is doing,
 * the whole of it a link to the task. Under a row, what belongs to that task alone: why it ended, the commands Botbench
 * ran on it, its Resume, its decision. Those are the components the task's own screen draws, unchanged, until that
 * screen's rebuilt ones replace them here too.
 */
export function TaskRows({ run, onChanged, onSignedOut }: { run: RunDetail; onChanged: () => void; onSignedOut: () => void }) {
  return (
    <>
      <ul data-testid="run-tasks" className="flex flex-col overflow-hidden rounded-xl border bg-raised">
        {run.tasks.map((task, i) => (
          <TaskRow key={task.id} task={task} first={i === 0} repo={run.repo} onChanged={onChanged} onSignedOut={onSignedOut} />
        ))}
      </ul>
      {run.tasks.some((task) => task.evidence.some((row) => row.kind === "check")) && (
        <p data-testid="run-checks-line" className="text-meta text-muted-foreground">
          {CHECKS_LINE}
        </p>
      )}
    </>
  );
}

function TaskRow({ task, first, repo, onChanged, onSignedOut }: { task: RunTask; first: boolean; repo: string; onChanged: () => void; onSignedOut: () => void }) {
  const state = rowState(task);
  const note = runTaskNote(task);
  const setup = task.evidence.filter((row) => row.kind === "setup");
  const checks = task.evidence.filter((row) => row.kind === "check");
  const words = task.pullRequest.state === "none" ? null : pullRequestWords(task.pullRequest);
  const more = note !== null || task.restartLine !== null || setup.length > 0 || checks.length > 0 || task.checks !== null || task.resumeNote !== null || task.status === "awaiting_decision" || task.decision !== null || words !== null || task.commandLists.length > 0;
  return (
    <li className={cn("flex flex-col", !first && "border-t")}>
      <a href={`#/tasks/${task.id}`} className="group/row flex min-h-(--control) items-start gap-3 px-5 py-3 outline-none hover:bg-fill/50 focus-visible:bg-fill/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span data-ds-content="" title={task.title} className="min-w-0 text-base font-semibold break-words">
              {task.title}
            </span>
            <StateBadge look={state.look} testId="run-task-state">
              {state.word}
            </StateBadge>
          </span>
          <span className="text-meta text-muted-foreground">
            {`Task ${task.id} · `}
            <span data-testid="run-task-branch" data-ds-content="" className="break-all">
              {taskFacts(task)}
            </span>
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" />
      </a>
      {more && (
        <div data-testid="run-task-more" className="flex flex-col gap-3 px-5 pb-4 text-base">
          {note !== null && <p data-ds-content="">{note}</p>}
          {task.restartLine !== null && <p data-testid="run-task-restart">{task.restartLine}</p>}
          <CommandRounds lists={task.commandLists} rows={setup} what={{ one: "setup command", many: "setup commands" }} />
          {task.checks !== null && <ChecksResult checks={task.checks} rows={latestRound(checks)} />}
          <CommandRounds lists={task.commandLists} rows={checks} what={{ one: "check", many: "checks" }} failedFirst again={task.rerunRounds} />
          {task.resumeNote !== null && <ResumeControl taskId={task.id} note={task.resumeNote} name={`task ${task.id}`} primary={false} onResumed={onChanged} onSignedOut={onSignedOut} />}
          {task.status === "awaiting_decision" && <DecisionControls taskId={task.id} leftovers={task.leftovers} evidence={task.evidenceState} evidenceProblem={task.evidenceProblem} primary={false} name={`task ${task.id}`} onDecided={onChanged} onSignedOut={onSignedOut} />}
          {task.decision !== null && <DecisionOutcome decision={task.decision} repo={repo} merge={offersMerge(task)} compact />}
          {words !== null && (
            <p data-testid="run-task-pull-request" data-ds-content="">
              {words}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** A link that leaves Botbench for GitHub, in a new tab, and says so. */
export function OutLink({ href, testId, children }: { href: string; testId?: string; children: ReactNode }) {
  return (
    <a data-testid={testId} href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-(--control-small) items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline">
      {children}
      <ExternalLink aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/**
 * The choice of a stricter mode, in a dialog the run's menu opens: the run's mode, labelled as the current one, and
 * only the modes stricter than it, as the server offers them (`modeChoices`). Nothing changes until the owner presses
 * the button; the server checks the change again.
 */
function StricterMode({ run, open, onOpen, onChanged, onSignedOut }: { run: Pick<RunDetail, "id" | "mode" | "modeChoices">; open: boolean; onOpen: (open: boolean) => void; onChanged: (next: RunDetail) => void; onSignedOut: () => void }) {
  const [picked, setPicked] = useState<RunMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  // From the run's mode to the strictest, as MODES lists them from the strictest.
  const shown = [...MODES].reverse().filter((option) => option.mode === run.mode || run.modeChoices.includes(option.mode));
  const choice = picked !== null && run.modeChoices.includes(picked) ? picked : null;

  const change = (): void => {
    if (choice === null || busy) return;
    setBusy(true);
    setProblem(null);
    changeRunMode(run.id, choice).then(
      (next) => {
        setBusy(false);
        setPicked(null);
        onOpen(false);
        onChanged(next);
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The mode was not changed. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setPicked(null);
        onOpen(next);
      }}
    >
      <DialogContent data-testid="mode-change">
        <DialogHeader>
          <DialogTitle>Make the mode stricter</DialogTitle>
          <DialogDescription id={`${id}-hint`}>{STRICTER_HINT}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={choice ?? run.mode} onValueChange={(value) => setPicked(value === run.mode ? null : (value as RunMode))} disabled={busy} aria-label="Mode" className="gap-3">
          {shown.map((option) => {
            const current = option.mode === run.mode;
            return (
              <div key={option.mode} className="flex min-h-(--control) items-start gap-3">
                <RadioGroupItem value={option.mode} id={`${id}-${option.mode}`} aria-describedby={`${id}-${option.mode}-about`} className="mt-1 after:-inset-4" />
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor={`${id}-${option.mode}`} className="text-base leading-normal">
                    {option.name}
                  </Label>
                  <p id={`${id}-${option.mode}-about`} className="text-meta text-muted-foreground">
                    {current && <span className="font-semibold text-foreground">Current mode. </span>}
                    {option.description}
                  </p>
                </div>
              </div>
            );
          })}
        </RadioGroup>
        {problem !== null && (
          <p role="alert" className="rounded-lg border border-destructive/60 bg-destructive-subtle px-3 py-2 text-meta text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" aria-busy={busy || undefined} disabled={choice === null} onClick={change}>
            {busy ? "Changing the mode" : choice === null ? "Change mode" : `Change to ${MODE_NAMES[choice]}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The run's own controls, as a menu in the screen's bar: Make the mode stricter, where the server offers a stricter
 * mode, and Cancel run, while the run can be cancelled. No menu when the run has neither. Cancelling takes something
 * away, so it asks first, in an alert dialog whose first button, with the focus, changes nothing.
 */
export function RunMenu({ run, cancelling, onCancel, onChanged, onSignedOut }: { run: RunDetail; cancelling: boolean; onCancel: () => void; onChanged: (next: RunDetail) => void; onSignedOut: () => void }) {
  const [stricter, setStricter] = useState(false);
  const [asking, setAsking] = useState(false);
  const offers = runControls(run);
  if (!offers.stricter && !offers.cancel && !cancelling) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" data-testid="run-menu" aria-busy={cancelling || undefined} disabled={cancelling} className="shrink-0" />}>
          {cancelling ? "Cancelling" : "Run"}
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {offers.stricter && (
            <DropdownMenuItem onClick={() => setStricter(true)} className="flex-col items-start gap-0">
              <span>Make the mode stricter</span>
              <span className="text-meta text-muted-foreground">{`Now ${MODE_NAMES[run.mode].toLowerCase()}`}</span>
            </DropdownMenuItem>
          )}
          {offers.stricter && offers.cancel && <DropdownMenuSeparator />}
          {offers.cancel && <DropdownMenuItem onClick={() => setAsking(true)}>Cancel run</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      {offers.stricter && <StricterMode key={run.mode} run={run} open={stricter} onOpen={setStricter} onChanged={onChanged} onSignedOut={onSignedOut} />}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent data-testid="cancel-run">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-heading font-semibold">Cancel this run?</AlertDialogTitle>
            <AlertDialogDescription>{cancelStatement(run.status, run.plan.length)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep run</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setAsking(false);
                onCancel();
              }}
            >
              Cancel run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
