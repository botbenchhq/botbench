import { useState, type FormEvent } from "react";
import { ApiError, sendTaskNote, type TaskDetail } from "../api/client.ts";
import { Alert } from "./header.tsx";
import { NOTE_ABOUT, NOTE_ABOUT_READY, NOTE_HEADING, NOTE_LABEL, NOTE_NOT_DELIVERED, NOTE_REPLACED, NOTE_SEND, NOTE_SENDING, NOTE_WAITING, NOTE_WAITING_LABEL, NOTE_WAITING_ROUND, notDeliveredLine, noteRefused } from "./task-note-words.ts";

/**
 * The owner's note to a task's builder (src/engine/notes.ts). On a building task: a small message box and Send note,
 * with the note that waits, if one does, and whether it replaced another. On a task that is ready for review the same
 * box, saying that the note takes the builder's session up again and the work is checked and reviewed again
 * (src/engine/note-rounds.ts). On any task: why a send was just refused (it stays when the task, read again, is no
 * longer building and the box has gone), and the latest note when it was not delivered, with why. A delivered note is
 * in the transcript, as the owner's message, and not here.
 */
export function TaskNote({ task, onChanged, onSignedOut }: { task: Pick<TaskDetail, "id" | "status" | "waitingNote" | "undeliveredNote">; onChanged: () => void; onSignedOut: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const send = (event: FormEvent): void => {
    event.preventDefault();
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
  return (
    <>
      {refused !== null && (
        <Alert tone="error" role="alert">
          <span data-testid="note-refused">{refused}</span>
        </Alert>
      )}
      {task.undeliveredNote !== null && (
        <Alert tone="warning" testId="note-undelivered" title={NOTE_NOT_DELIVERED}>
          {notDeliveredLine(task.undeliveredNote.reason)}
          <span data-ds-content="">{task.undeliveredNote.text}</span>
        </Alert>
      )}
      {(task.status === "building" || ready) && (
        <section aria-labelledby="note-heading" data-testid="task-note" className="ds-stack ds-gap-sm">
          <h2 id="note-heading">{NOTE_HEADING}</h2>
          {waiting !== null && (
            <div className="ds-stack ds-gap-sm">
              <p role="status" data-testid="note-waiting">
                {waiting.forRound ? NOTE_WAITING_ROUND : NOTE_WAITING}
              </p>
              {waiting.replacedOne && <p data-testid="note-replaced">{NOTE_REPLACED}</p>}
              <dl className="ds-key-value">
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">{NOTE_WAITING_LABEL}</dt>
                  <dd data-testid="note-text" data-ds-content="" className="ds-key-value__value">
                    {waiting.text}
                  </dd>
                </div>
              </dl>
            </div>
          )}
          <form onSubmit={send} className="ds-stack ds-gap-sm">
            <div className="ds-field">
              <label htmlFor="task-note-text" className="ds-field__label">
                {NOTE_LABEL}
              </label>
              <textarea id="task-note-text" value={text} readOnly={busy} onChange={(e) => setText(e.target.value)} aria-describedby="task-note-about" className="ds-field__control ds-textarea" />
              <p id="task-note-about" data-testid="note-about" className="ds-field__description">
                {ready ? NOTE_ABOUT_READY : NOTE_ABOUT}
              </p>
            </div>
            <div className="ds-cluster">
              <button type="submit" aria-busy={busy} disabled={busy} className="ds-button">
                {busy ? NOTE_SENDING : NOTE_SEND}
              </button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}
