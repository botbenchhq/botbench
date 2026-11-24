import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Square } from "lucide-react";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/ui/lib/utils";
import { ApiError, moveTask, sendTaskNote, stopTask, updateWithMain, type TaskDetail } from "../../api/client.ts";
import { agentName } from "../../app/chat.ts";
import { moveAbout, moveButton, moveRefused } from "../../app/handoff-words.ts";
import { behindLine, choiceLine, MAIN_HEADING, updateAbout, updateButton, updateRefused } from "../../app/main-words.ts";
import { NOTE_ABOUT, NOTE_ABOUT_READY, NOTE_HEADING, NOTE_LABEL, NOTE_NOT_DELIVERED, NOTE_REPLACED, NOTE_SEND, NOTE_SENDING, NOTE_WAITING, NOTE_WAITING_LABEL, NOTE_WAITING_ROUND, notDeliveredLine, noteRefused } from "../../components/task-note-words.ts";

/*
 * The ways the owner steers a task from its screen (ADR 0012), each through the same request as before the rebuild:
 * a note to its agent (src/engine/notes.ts), a move to another agent (src/engine/handoff.ts), bringing its branch up
 * to date with main (src/engine/branch-update.ts), and Stop on one working task (src/engine/task.ts, `stop`). What is
 * offered is the server's to say: a control is drawn only for what the task's own answer allows now.
 */

/** A problem said in place, in the destructive tone. */
export function Problem({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p role="alert" data-testid={testId} className="rounded-lg border border-destructive/60 bg-destructive-subtle px-3 py-2 text-meta text-destructive">
      {children}
    </p>
  );
}

/**
 * The owner's note to a task's agent. On a working task: the box and Send note, with the note that waits, if one does.
 * On a task that is ready for review the same box, saying that the note takes the agent's session up again and the
 * work is checked and reviewed again. On any task: why a send was just refused, and the latest note when it was not
 * delivered, with why. A delivered note is in the activity, as the owner's message. `draft` is the unsent text and its setter.
 */
export function NoteBox({ task, card = true, draft, onChanged, onSignedOut }: { task: Pick<TaskDetail, "id" | "status" | "builder" | "waitingNote" | "undeliveredNote">; card?: boolean; draft: [string, (text: string) => void]; onChanged: () => void; onSignedOut: () => void }) {
  // The words typed and not sent are the screen's: the box may be drawn anew (in the pane, then in its sheet as the window narrows) and keeps them.
  const [text, setText] = draft;
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const id = useId();
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefused(null);
    sendTaskNote(task.id, text).then(
      () => {
        setBusy(false);
        setText("");
        onChanged();
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setRefused(noteRefused(err instanceof ApiError ? err.message : null));
        // The task may have moved on meanwhile: show what is so now.
        onChanged();
      },
    );
  };
  const waiting = task.waitingNote;
  const ready = task.status === "awaiting_decision";
  const takes = task.status === "building" || ready;
  if (!takes && refused === null && task.undeliveredNote === null) return null;
  return (
    <div className="flex flex-col gap-3">
      {refused !== null && <Problem testId="note-refused">{refused}</Problem>}
      {task.undeliveredNote !== null && (
        <div data-testid="note-undelivered" className="rounded-lg border border-dashed border-edge px-3 py-2 text-meta">
          <p className="font-semibold">{NOTE_NOT_DELIVERED}</p>
          <p className="text-muted-foreground">
            {notDeliveredLine(task.undeliveredNote.reason)}
            <span data-ds-content="" className="text-foreground">
              {task.undeliveredNote.text}
            </span>
          </p>
        </div>
      )}
      {takes && (
        <section aria-labelledby={`${id}-heading`} data-testid="task-note" className={cn("flex flex-col gap-3", card && "rounded-xl border border-edge bg-pane p-4")}>
          <h2 id={`${id}-heading`} className="text-sm font-semibold">
            {NOTE_HEADING}
          </h2>
          {waiting !== null && (
            <div className="flex flex-col gap-1 rounded-lg bg-fill px-3 py-2 text-meta">
              <p role="status" data-testid="note-waiting">
                {waiting.forRound ? NOTE_WAITING_ROUND : NOTE_WAITING}
              </p>
              {waiting.replacedOne && <p data-testid="note-replaced">{NOTE_REPLACED}</p>}
              <p className="text-muted-foreground">
                {`${NOTE_WAITING_LABEL}: `}
                <span data-testid="note-text" data-ds-content="" className="whitespace-pre-wrap text-foreground">
                  {waiting.text}
                </span>
              </p>
            </div>
          )}
          <form onSubmit={send} className="flex flex-col gap-3">
            <Label htmlFor={`${id}-text`} className="sr-only">
              {NOTE_LABEL}
            </Label>
            <Textarea id={`${id}-text`} data-testid="note-input" placeholder={NOTE_LABEL} maxLength={4000} value={text} readOnly={busy} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-about`} />
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p id={`${id}-about`} data-testid="note-about" className="min-w-0 flex-1 basis-64 text-meta text-muted-foreground">
                {ready ? NOTE_ABOUT_READY : NOTE_ABOUT}
              </p>
              <Button type="submit" variant="outline" aria-busy={busy || undefined}>
                {busy ? NOTE_SENDING : NOTE_SEND}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}

/**
 * Move a working task to another agent: one outlined button for each agent the server says can take it over now
 * (never the run's reviewer, and only agents that could build it in its run's mode).
 */
export function MoveControl({ task, onMoved, onSignedOut }: { task: Pick<TaskDetail, "id" | "status" | "builder" | "moveTo">; onMoved: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const move = (agent: string): void => {
    if (busy !== null) return;
    setBusy(agent);
    setProblem(null);
    moveTask(task.id, agent).then(
      () => {
        setBusy(null);
        onMoved();
      },
      (err: unknown) => {
        setBusy(null);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(moveRefused(err instanceof ApiError ? err.message : null));
        onMoved();
      },
    );
  };
  const offered = task.status === "building" && task.moveTo.length > 0;
  if (problem === null && !offered) return null;
  return (
    <div data-testid="task-move" className="flex flex-col gap-2">
      {problem !== null && <Problem testId="move-refused">{problem}</Problem>}
      {offered && (
        <>
          {task.moveTo.map((agent) => (
            <Button key={agent} variant="outline" aria-busy={busy === agent || undefined} disabled={busy !== null && busy !== agent} onClick={() => move(agent)}>
              {moveButton(agent, busy === agent)}
            </Button>
          ))}
          <p data-testid="move-about" className="text-meta text-muted-foreground">
            {moveAbout(task.builder)}
          </p>
        </>
      )}
    </div>
  );
}

/** What Stop does, beside its button. */
export const stopAbout = (agent: string): string => `Stops ${agent} now. What it wrote is kept in the task's copy, and you can resume it.`;

/**
 * Stop on one working task, for the pane and for the foot of a narrow window: one state for both, kept by the screen.
 * Offered only while the server says the task's agent is at work (`canStop`).
 */
export function useStop(task: TaskDetail | null, onStopped: () => void, onSignedOut: () => void) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const stop = (): void => {
    if (task === null || busy) return;
    setBusy(true);
    setProblem(null);
    stopTask(task.id).then(
      // It stays "Stopping" until the task is read as no longer working: the agent's process takes a moment to end.
      () => onStopped(),
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The task was not stopped. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
        onStopped();
      },
    );
  };
  const working = task?.status === "building";
  useEffect(() => {
    if (!working) setBusy(false);
  }, [working]);
  return { busy, problem, stop, offered: task?.canStop === true || (busy && working) };
}
export type Stop = ReturnType<typeof useStop>;

export function StopControl({ task, s }: { task: Pick<TaskDetail, "builder">; s: Stop }) {
  if (!s.offered && s.problem === null) return null;
  return (
    <div data-testid="task-stop" className="flex flex-col gap-2">
      {s.problem !== null && <Problem testId="stop-refused">{s.problem}</Problem>}
      {s.offered && (
        <div className="flex items-center gap-3">
          <Button variant="outline" aria-busy={s.busy || undefined} onClick={s.stop}>
            <Square aria-hidden="true" />
            {s.busy ? "Stopping" : "Stop"}
          </Button>
          <p className="min-w-0 flex-1 text-meta text-muted-foreground">{stopAbout(agentName(task.builder))}</p>
        </div>
      )}
    </div>
  );
}

/**
 * A task and main: how far its branch is behind main while it is ready for review, the button that brings it up to
 * date, and what came of the latest update. Shown while it is ready for review and behind, while an update is under
 * way, and once one ended. On a dashed card with no fill: nothing verified how the branch fits main as it is now. The
 * button is never the view's primary action.
 */
export function MainUpdate({ task, onChanged, onSignedOut }: { task: Pick<TaskDetail, "id" | "status" | "builder" | "mainUpdate">; onChanged: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const m = task.mainUpdate;
  const ready = task.status === "awaiting_decision";
  const update = (): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    updateWithMain(task.id).then(
      () => {
        setBusy(false);
        onChanged();
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(updateRefused(err instanceof ApiError ? err.message : null));
        onChanged();
      },
    );
  };
  // How the branch stands against main: while it is behind, and, after an update, that it now holds everything on main.
  const lacks = ready && (m.behind ?? 0) > 0;
  const behind = lacks || (ready && m.line !== null) ? behindLine(m) : null;
  const unverified = lacks || (ready && m.problem !== null);
  const offer = ready && !m.underWay && m.behind !== null && m.behind > 0 && m.branch !== null;
  const choice = offer ? choiceLine(m) : null;
  if (behind === null && !(ready && m.problem !== null) && !m.underWay && m.line === null && problem === null) return null;
  return (
    <section aria-label="Main" data-testid="main-update" className="grid gap-x-4 gap-y-2 rounded-xl border border-dashed border-edge px-5 py-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      <h2 className="sr-only">{MAIN_HEADING}</h2>
      {/* Only what nothing verified is labelled so: a branch brought up to date had its checks run again. */}
      <span className="inline-flex h-5 w-fit items-center rounded-sm border border-dashed border-edge px-1.5 text-xs font-medium text-muted-foreground">{unverified ? "Not verified" : MAIN_HEADING}</span>
      <div className="flex min-w-0 flex-col gap-2">
        {problem !== null && <Problem testId="main-update-refused">{problem}</Problem>}
        {m.line !== null && (
          <p data-testid="main-update-line" role="status" className="text-base">
            {m.line}
          </p>
        )}
        {behind !== null && (
          <p data-testid="main-behind" className="text-base">
            {behind}
          </p>
        )}
        {ready && m.problem !== null && (
          <p data-testid="main-problem" className="text-base">
            {m.problem}
          </p>
        )}
        {unverified && <p className="text-meta text-muted-foreground">The checks and the review saw the branch alone.</p>}
        {offer && (
          <>
            {choice !== null && (
              <p data-testid="main-choice" className="text-meta text-muted-foreground">
                {choice}
              </p>
            )}
            <p data-testid="main-about" className="text-meta text-muted-foreground">
              {updateAbout(m.branch!, agentName(task.builder))}
            </p>
            <Button variant="outline" className="w-fit max-w-full" aria-busy={busy || undefined} onClick={update}>
              <span className="truncate">{updateButton(m.branch!, busy)}</span>
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
