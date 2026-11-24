import { useEffect, useRef, type FormEvent } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Separator } from "@/ui/separator";
import { Textarea } from "@/ui/textarea";
import type { PlanTask } from "../../api/client.ts";
import { counted } from "../../app/format.ts";
import type { PlanEdit } from "../../app/plan-edit.ts";
import { tasksWord } from "../../components/run-status.ts";
import { DecisionSurface } from "../decision/decision-surface.tsx";

/*
 * A run's plan while it waits for the owner: each task a card with its title and acceptance criteria, edited in place,
 * and the decision on the whole plan. What an edit is and when it would lose words is app/plan-edit.ts's; what is sent
 * is the run screen's. Every piece of a plan is rendered as a React child, so a planner's words are text, never markup.
 */

/** A task being edited, with what is wrong with it as it stands. */
export type Editing = PlanEdit & { problem: { title?: string; criteria?: string; save?: string } };

const UNDO_SECONDS = 10;
/** A task that was just deleted and can still be put back. */
export type Deleted = { task: PlanTask; at: number; left: number; undoing: boolean };
export const justDeleted = (task: PlanTask, at: number): Deleted => ({ task, at, left: UNDO_SECONDS, undoing: false });

/** One task of the plan: its number, its title, its criteria, and Edit and Delete. */
function PlanTaskCard({ task, number, locked, onEdit, onDelete }: { task: PlanTask; number: number; locked: boolean; onEdit: () => void; onDelete: () => void }) {
  return (
    <Card className="flex-row items-start gap-4 p-5">
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-fill text-meta font-semibold tabular-nums">
        {number}
      </span>
      <div data-testid="plan-task-text" data-ds-content="" className="flex min-w-0 flex-1 flex-col gap-2">
        <strong className="text-base font-semibold break-words">{task.title}</strong>
        <ul aria-label={`Acceptance criteria of task ${number}`} className="flex list-disc flex-col gap-1 pl-5 text-base text-muted-foreground">
          {task.criteria.map((criterion, i) => (
            <li key={i} className="break-words">
              {criterion}
            </li>
          ))}
        </ul>
      </div>
      <div className="-my-1.5 -mr-2 flex shrink-0 flex-col sm:flex-row">
        <Button type="button" variant="ghost" size="icon" data-edit={number - 1} disabled={locked} data-ds-content-label="" aria-label={`Edit task ${number}: ${task.title}`} onClick={onEdit} className="size-(--control) text-muted-foreground">
          <Pencil aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" disabled={locked} data-ds-content-label="" aria-label={`Delete task ${number}: ${task.title}`} onClick={onDelete} className="size-(--control) text-muted-foreground">
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

/** The editor a card turns into: the title and the criteria, one on each line. Enter in the title saves; Escape cancels. */
function PlanEditor({ editing, name, saving, onChange, onSave, onCancel }: { editing: Editing; name: string; saving: boolean; onChange: (next: Editing) => void; onSave: () => void; onCancel: () => void }) {
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => title.current?.focus(), []);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave();
  };
  return (
    <Card className="border-primary/60 p-5">
      <form
        onSubmit={submit}
        onKeyDown={(e) => {
          // Escape while text is being composed belongs to the input method.
          if (e.key !== "Escape" || saving || e.nativeEvent.isComposing) return;
          // The same key press would otherwise close the question that Cancel may open: a dialog listens for Escape on
          // the page, and the question is open by the time this press gets there.
          e.preventDefault();
          e.nativeEvent.stopPropagation();
          onCancel();
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-title" className="text-meta font-semibold">{`${name} title`}</Label>
          <Input ref={title} id="plan-title" type="text" autoComplete="off" readOnly={saving} value={editing.title} onChange={(e) => onChange({ ...editing, title: e.target.value })} aria-invalid={editing.problem.title !== undefined} aria-describedby={editing.problem.title === undefined ? undefined : "plan-title-error"} />
          {editing.problem.title !== undefined && (
            <p id="plan-title-error" className="text-meta text-destructive">
              {editing.problem.title}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-criteria" className="text-meta font-semibold">{`${name} acceptance criteria`}</Label>
          <Textarea id="plan-criteria" readOnly={saving} value={editing.criteria} onChange={(e) => onChange({ ...editing, criteria: e.target.value })} aria-invalid={editing.problem.criteria !== undefined} aria-describedby={editing.problem.criteria === undefined ? "plan-criteria-about" : "plan-criteria-about plan-criteria-error"} className="min-h-24" />
          <p id="plan-criteria-about" className="text-meta text-muted-foreground">
            One criterion on each line: a sentence that can be checked when the task is done.
          </p>
          {editing.problem.criteria !== undefined && (
            <p id="plan-criteria-error" className="text-meta text-destructive">
              {editing.problem.criteria}
            </p>
          )}
        </div>
        {editing.problem.save !== undefined && (
          <p role="alert" className="text-meta text-destructive">
            {editing.problem.save}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" aria-busy={saving || undefined}>
            {saving ? "Saving task" : "Save task"}
          </Button>
          <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The plan as cards, the one being edited as its editor, Add task under them, and the offer to put a deleted task back. */
export function PlanList({ plan, editing, locked, saving, deleted, onEdit, onAdd, onDelete, onChange, onSave, onCancel, onUndo }: { plan: readonly PlanTask[]; editing: Editing | null; locked: boolean; saving: boolean; deleted: Deleted | null; onEdit: (at: number) => void; onAdd: () => void; onDelete: (at: number) => void; onChange: (next: Editing) => void; onSave: () => void; onCancel: () => void; onUndo: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      {plan.length === 1 && <p className="text-meta text-muted-foreground">A plan holds at least one task. To drop this one too, cancel the run.</p>}
      <ol aria-label="Plan" className="flex flex-col gap-3">
        {plan.map((task, i) => (
          <li key={i}>{editing?.at === i ? <PlanEditor editing={editing} name={`Task ${i + 1}`} saving={saving} onChange={onChange} onSave={onSave} onCancel={onCancel} /> : <PlanTaskCard task={task} number={i + 1} locked={locked} onEdit={() => onEdit(i)} onDelete={() => onDelete(i)} />}</li>
        ))}
        {editing?.at === "new" && (
          <li>
            <PlanEditor editing={editing} name="New task" saving={saving} onChange={onChange} onSave={onSave} onCancel={onCancel} />
          </li>
        )}
      </ol>
      {editing?.at !== "new" && (
        <div>
          <Button type="button" variant="outline" data-add-task disabled={locked || plan.length >= 20} onClick={onAdd}>
            <Plus aria-hidden="true" />
            Add task
          </Button>
        </div>
      )}
      {/* The delete is already stored; this is the offer to put the task back, said once to a screen reader. */}
      <div role="status" aria-live="polite" aria-atomic="false">
        {deleted !== null && (
          <div data-testid="plan-undo" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border bg-raised px-5 py-3 text-base">
            <p>
              {`Task ${deleted.at + 1} deleted from the plan.`}
              <span className="sr-only">{` You have ${UNDO_SECONDS} seconds to undo.`}</span>
              {!deleted.undoing && <span aria-hidden="true" className="text-muted-foreground tabular-nums">{` ${counted(deleted.left, "second", "seconds")} left to undo`}</span>}
            </p>
            <Button type="button" variant="outline" aria-busy={deleted.undoing || undefined} onClick={onUndo}>
              {deleted.undoing ? "Putting the task back" : "Undo"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The decision on the plan: Approve, the screen's one filled button, and Request changes with its feedback for the
 * planner. In the inspector (`compact` false) the field is always there. In the sticky area under a narrower screen
 * (`compact`) the area is the two buttons until Request changes is pressed, which opens the field in it; pressed again
 * with words in the field, it sends them.
 */
export function PlanDecision({ count, compact, busy, problem, feedback, asking, onFeedback, onAsking, onApprove, onChanges }: { count: number; compact: boolean; busy: "approve" | "changes" | "other" | null; problem: string | null; feedback: string; asking: boolean; onFeedback: (text: string) => void; onAsking: (open: boolean) => void; onApprove: () => void; onChanges: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const showField = !compact || asking;
  const wasAsking = useRef(asking);
  useEffect(() => {
    // Opened by Request changes in the sticky area: the field takes the focus, so the next thing typed is the feedback.
    if (compact && asking && !wasAsking.current) field.current?.focus();
    wasAsking.current = asking;
  }, [asking, compact]);
  const changes = (): void => {
    if (compact && !asking) return onAsking(true);
    onChanges();
  };
  const fieldBlock = showField && (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="plan-feedback" className="text-meta font-semibold">
          Feedback for the planner
        </Label>
        {compact && (
          <Button type="button" variant="ghost" size="icon" aria-label="Close the feedback field" onClick={() => onAsking(false)} className="-my-2 -mr-2 size-(--control) text-muted-foreground">
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      <Textarea ref={field} id="plan-feedback" value={feedback} onChange={(e) => onFeedback(e.target.value)} aria-describedby="plan-feedback-about" className={compact ? "max-h-32 min-h-16" : "min-h-24"} />
      <p id="plan-feedback-about" className="text-meta text-muted-foreground">
        Request changes sends the plan as it stands here, with this feedback, back to the planner, and its new plan takes this one's place.
      </p>
    </div>
  );
  const problemBlock = problem !== null && (
    <p role="alert" data-testid="decision-problem" className="rounded-lg border border-destructive/60 bg-destructive-subtle px-3 py-2 text-meta text-destructive">
      {problem}
    </p>
  );
  const changesButton = (
    <Button type="button" variant="outline" className={compact ? "flex-1" : "w-full"} aria-busy={busy === "changes" || undefined} disabled={busy !== null && busy !== "changes"} onClick={changes}>
      {busy === "changes" ? "Requesting changes" : "Request changes"}
    </Button>
  );
  const approveButton = (
    <Button type="button" className={compact ? "flex-[2]" : "w-full"} aria-busy={busy === "approve" || undefined} disabled={busy !== null && busy !== "approve"} onClick={onApprove}>
      {busy === "approve" ? "Approving" : `Approve ${tasksWord(count)}`}
    </Button>
  );
  const starts = "Approving starts building the tasks, one at a time, in this order.";
  if (compact) {
    return (
      <div data-testid="plan-decision" role="group" aria-label="Decision" className="sticky bottom-0 z-10 -mx-4 mt-auto flex flex-col gap-3 border-t bg-pane px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:-mx-8 md:px-8">
        {fieldBlock}
        {problemBlock}
        <div className="mx-auto flex w-full max-w-[47.5rem] gap-2">
          {changesButton}
          {approveButton}
        </div>
        <p className="mx-auto w-full max-w-[47.5rem] text-meta text-muted-foreground">{starts}</p>
      </div>
    );
  }
  // In the inspector the two decisions stand apart: Approve with what it starts, then the feedback with Request changes.
  return (
    <DecisionSurface level="approval" signal="Needs your decision" title="Approve this plan?" data-testid="plan-decision" className="gap-4 p-5">
      <p className="text-base text-muted-foreground">{starts}</p>
      {approveButton}
      <Separator />
      {fieldBlock}
      {problemBlock}
      {changesButton}
    </DecisionSurface>
  );
}
