import { useId, useState } from "react";
import { FileSearch } from "lucide-react";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Label } from "@/ui/label";
import { Separator } from "@/ui/separator";
import { Textarea } from "@/ui/textarea";
import { ApiError, discardTask, resumeTask, type TaskDetail } from "../../api/client.ts";
import { agentName } from "../../app/chat.ts";
import { counted, plural } from "../../app/format.ts";
import { useInspector } from "../../shell/shell.tsx";
import { DestructiveDialog } from "../decision/decision-surface.tsx";
import { Problem } from "./steer.tsx";

/*
 * A task that ended with nothing to review (failed, stopped, cancelled, or drafted a message), recovery first (boards
 * V2Failed, V2MFailed): what Resume will do, in the server's words, with a note for the agent where the server says
 * one can go with it; what is kept; and Discard apart and quiet, behind its confirmation. Resume is offered only when
 * the server says the task can be resumed (`resumeNote`), and is then the view's one filled button.
 */

/** Resume's own state and request, kept by the screen: the pane and the foot of a narrow window are one Resume. */
export function useResume(task: TaskDetail | null, onResumed: () => void, onSignedOut: () => void) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const resume = (): void => {
    if (task === null || busy) return;
    setBusy(true);
    setProblem(null);
    resumeTask(task.id, task.resumeTakesNote && note.trim() !== "" ? note : null).then(
      () => {
        setBusy(false);
        setNote("");
        onResumed();
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The task was not resumed. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
        // The task may have moved on meanwhile: show what is so now.
        onResumed();
      },
    );
  };
  return { busy, problem, note, setNote, resume, offered: task !== null && task.resumeNote !== null };
}
export type Resume = ReturnType<typeof useResume>;

export function ResumeButton({ r, className }: { r: Resume; className?: string }) {
  return (
    <Button className={className} aria-busy={r.busy || undefined} onClick={r.resume}>
      {r.busy ? "Resuming" : "Resume"}
    </Button>
  );
}

/** The note that goes with Resume, for the agent to read first. Only where the server says the Resume starts the agent. */
export function ResumeNote({ task, r, rows }: { task: Pick<TaskDetail, "builder">; r: Resume; rows: number }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-note`} className="text-meta font-semibold">{`Note for ${agentName(task.builder)} (optional)`}</Label>
      <Textarea id={`${id}-note`} data-testid="resume-note-input" rows={rows} maxLength={4000} placeholder="What to do differently this time" value={r.note} readOnly={r.busy} onChange={(e) => r.setNote(e.target.value)} className={rows === 1 ? "min-h-(--control)" : undefined} />
    </div>
  );
}

/** The recovery card of the pane: Resume, with what it will do and the note that can go with it, and a way to the activity. */
export function RecoveryCard({ task, r, onInspect }: { task: TaskDetail; r: Resume; onInspect: () => void }) {
  const inspector = useInspector();
  if (!r.offered && r.problem === null) return null;
  // Where the pane is a sheet it closes first: the activity is in the column under it.
  const inspect = (): void => {
    inspector.close();
    onInspect();
  };
  return (
    <Card data-testid="recovery" className="gap-4 p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-heading font-semibold tracking-tight">Resume this task</h2>
        {task.resumeNote !== null && (
          <p data-testid="resume-note" className="text-meta text-muted-foreground">
            {task.resumeNote}
          </p>
        )}
      </div>
      {r.problem !== null && <Problem testId="resume-problem">{r.problem}</Problem>}
      {r.offered && (
        <>
          {task.resumeTakesNote && <ResumeNote task={task} r={r} rows={3} />}
          {task.resumeTakesNote && <p className="text-meta text-muted-foreground">{`${agentName(task.builder)} reads your note first, as your instruction for the work from here.`}</p>}
          <div className="flex flex-col gap-2">
            <ResumeButton r={r} />
            <Button variant="outline" onClick={inspect}>
              <FileSearch aria-hidden="true" />
              Inspect what happened
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** How a task ended without being ready for review, in the words of its state. */
const ENDED: Partial<Record<TaskDetail["status"], string>> = { failed: "failed", interrupted: "was stopped", cancelled: "was cancelled", drafted: "drafted a message and changed no file" };

/**
 * What a task that ended with nothing to review left behind, and Discard, which removes it after asking: its separate
 * copy of the project and Botbench's branch. Shown while something is left, also after a discard that could not
 * finish; once nothing is, that it was discarded. `startOpen`: the owner chose Discard from the task's menu on Work.
 */
/**
 * Discard's own state and request, kept by the screen: its confirmation is drawn once, outside the pane, so it opens
 * at any width (the pane may be a closed sheet) and only once for an address that asks for it (`startOpen`).
 */
export function useDiscard(task: TaskDetail | null, startOpen: boolean, onDiscarded: () => void, onSignedOut: () => void) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(startOpen);
  const send = (): void => {
    if (task === null || task.remains === null) return;
    setAsking(false);
    setBusy(true);
    setProblem(null);
    // The owner confirmed exactly the files the dialog showed; the server refuses, and lists them again, if they changed since.
    discardTask(task.id, task.remains.files).then(
      () => {
        setBusy(false);
        onDiscarded();
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`Nothing was discarded. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
        onDiscarded();
      },
    );
  };
  return { busy, problem, asking, setAsking, send };
}
export type Discard = ReturnType<typeof useDiscard>;

/** What Discard would remove, in words: the copy, the branch, or both. Empty when nothing is left. */
const leftOf = (task: TaskDetail): string[] => [task.remains?.copy === true && "its separate copy of the project", task.remains?.branch === true && `its branch ${task.branch ?? ""}`].filter((part): part is string => typeof part === "string");

export function Kept({ task, steps, x }: { task: TaskDetail; steps: number; x: Discard }) {
  const { busy, problem, setAsking } = x;
  const id = useId();
  const ended = ENDED[task.status];
  const remains = task.remains;
  if (ended === undefined) return null;
  if (remains === null) return task.remainsProblem === null ? null : <Problem>{task.remainsProblem}</Problem>;
  if (!remains.copy && !remains.branch) {
    return remains.discardedAt === null ? null : (
      <p data-testid="discarded" className="text-meta text-muted-foreground">
        Discarded. Nothing of this task is left: its copy of the project and its branch are gone, with the work on them. Nothing was merged or pushed.
      </p>
    );
  }
  const left = leftOf(task);
  const rows = [
    remains.branch && task.branch !== null ? { name: "Branch", value: task.branch, mono: true } : null,
    { name: "The task's copy", value: !remains.copy ? "Removed" : remains.files.length === 0 ? "Kept" : `Kept, with ${counted(remains.files.length, "file", "files")} not on the branch`, mono: false },
    { name: "Activity", value: steps === 0 ? "Kept" : `Kept, ${counted(steps, "step", "steps")}`, mono: false },
  ].filter((row) => row !== null);
  return (
    <>
      <section aria-labelledby={`${id}-kept`} data-testid="kept">
        <h2 id={`${id}-kept`} className="mb-1 text-meta font-semibold text-muted-foreground">
          Kept until you decide otherwise
        </h2>
        <dl className="flex flex-col text-sm">
          {rows.map((row, i) => (
            <div key={row.name}>
              {i > 0 && <Separator />}
              <div className="flex justify-between gap-4 py-2.5">
                <dt className="text-muted-foreground">{row.name}</dt>
                <dd className="min-w-0 text-right break-all">{row.mono ? <code data-ds-content="">{row.value}</code> : row.value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby={`${id}-discard`} className="flex flex-col gap-2 border-t pt-4">
        <h2 id={`${id}-discard`} className="text-meta font-semibold text-muted-foreground">
          When you no longer want it
        </h2>
        <p className="text-meta text-muted-foreground">{`This task ${ended}, so there is nothing to review. Discard removes ${left.join(" and ")}. Nothing is merged or pushed. It asks first.`}</p>
        {problem !== null && <Problem testId="discard-problem">{problem}</Problem>}
        <Button variant="ghost" data-testid="discard" className="-ml-3 w-fit text-muted-foreground" aria-busy={busy || undefined} onClick={() => !busy && setAsking(true)}>
          {busy ? "Discarding" : "Discard…"}
        </Button>
      </section>
    </>
  );
}

/** Discard's confirmation, drawn once by the screen: the first button, with the focus, changes nothing. */
export function DiscardDialog({ task, x }: { task: TaskDetail; x: Discard }) {
  const remains = task.remains;
  const left = leftOf(task);
  if (ENDED[task.status] === undefined || remains === null || left.length === 0) return null;
  const { asking, setAsking, send } = x;
  return (
    <DestructiveDialog open={asking} onOpenChange={setAsking} title="Discard what this task left?" keepLabel="Keep them" confirmLabel="Discard" onConfirm={send} testId="discard-dialog">
      <p>{`This removes ${left.join(" and ")}. The work on ${remains.branch ? "the branch" : "it"} is gone for good. Nothing is merged or pushed.`}</p>
      {remains.files.length > 0 && (
        <div className="flex flex-col gap-1 text-meta">
          <p>{`${plural(remains.files.length, "This file is", "These files are")} in the task's copy and not on the branch, and ${plural(remains.files.length, "goes", "go")} with it:`}</p>
          <ul data-testid="leftovers">
            {remains.files.map((file) => (
              <li key={file}>
                <code data-ds-content="">{file}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DestructiveDialog>
  );
}
