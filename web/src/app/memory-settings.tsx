import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, editMemoryNote, forgetMemoryNote, getMemory, type MemoryList, type MemoryNote } from "../api/client.ts";
import { ConfirmAction } from "../components/confirm.tsx";
import { Alert } from "../components/header.tsx";

/** The note being edited: what the owner typed, the version it was read at, and why it was not saved. */
type Editing = { id: number; text: string; hash: string; saving: boolean; problem: string | null; now: string | null };

const when = (ts: string): string => new Date(ts).toLocaleString();

/** One note at rest: its text, when it was saved or edited, and Edit and Forget. Its text is always a React child, never markup. */
function NoteRow({ note, number, busy, onEdit, onForget }: { note: MemoryNote; number: number; busy: boolean; onEdit: () => void; onForget: () => void }) {
  return (
    <>
      <span className="ds-editable-list__text ds-stack ds-gap-xs">
        <span data-ds-content="">{note.text}</span>
        <span className="ds-settings-row__description">{note.editedAt === null ? `Saved ${when(note.savedAt)}` : `Edited ${when(note.editedAt)}`}</span>
      </span>
      <span className="ds-editable-list__actions">
        <button type="button" data-memory-edit={note.id} disabled={busy} data-ds-content-label="" aria-label={`Edit note ${number}: ${note.text}`} onClick={onEdit} className="ds-button ds-button--quiet ds-button--small">
          Edit
        </button>
        <ConfirmAction label="Forget" opener={{ small: true, name: `Forget note ${number}: ${note.text}` }} title="Forget this note?" confirmLabel="Forget" cancelLabel="Keep it" disabled={busy} losing testId={`memory-forget-${note.id}`} onConfirm={onForget}>
          <p>Botbench removes it from memory and keeps no copy there. Agents are no longer given it. Chats and runs that already had it keep their words.</p>
        </ConfirmAction>
      </span>
    </>
  );
}

/** The editor a note's row turns into. Enter saves; Escape cancels. */
function NoteEditor({ editing, number, max, onChange, onSave, onCancel }: { editing: Editing; number: number; max: number; onChange: (text: string) => void; onSave: () => void; onCancel: () => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave();
  };
  const described = [`${id}-about`, ...(editing.now === null ? [] : [`${id}-now`]), ...(editing.problem === null ? [] : [`${id}-problem`])].join(" ");
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && !editing.saving && onCancel()} className="ds-editable-list__editor" noValidate>
      <div className="ds-field">
        <label htmlFor={`${id}-text`} className="ds-field__label">{`Note ${number}`}</label>
        <input ref={input} data-testid="memory-note-text" id={`${id}-text`} type="text" autoComplete="off" maxLength={max} readOnly={editing.saving} value={editing.text} onChange={(e) => onChange(e.currentTarget.value)} aria-invalid={editing.problem !== null || undefined} aria-describedby={described} className="ds-field__control" />
        <p id={`${id}-about`} className="ds-field__description">{`One line, at most ${max.toLocaleString("en")} characters.`}</p>
        {editing.now !== null && (
          <p id={`${id}-now`} data-ds-content="" className="ds-field__description">
            {`The note now: ${editing.now}`}
          </p>
        )}
        {editing.problem !== null && (
          <p role="alert" id={`${id}-problem`} className="ds-field__error">
            {editing.problem}
          </p>
        )}
      </div>
      <div className="ds-editable-list__editor-actions">
        <button type="submit" aria-busy={editing.saving} className="ds-button ds-button--small">
          {editing.saving ? "Saving note" : "Save note"}
        </button>
        <button type="button" disabled={editing.saving} onClick={onCancel} className="ds-button ds-button--quiet ds-button--small">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Settings → Memory (ADR 0006): the notes Botbench keeps because the owner began a chat message with "Remember:" or
 * "Remember that", newest first. Each can be edited in its row, or forgotten after a question. An edit carries the
 * version the screen read, so one made on a note that changed since (in another tab) is refused, and the owner sees the
 * note as it is now before trying again.
 */
export function MemorySettings({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [list, setList] = useState<MemoryList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [focusEdit, setFocusEdit] = useState<number | null>(null);
  const group = useRef<HTMLDivElement>(null);

  const failed = (what: string) => (err: unknown): void => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what.replace(/\.$/, "")}: Botbench could not be reached.`);
  };
  const load = (): Promise<MemoryList | null> =>
    getMemory().then(
      (found) => (setList(found), found),
      (err: unknown) => (failed("Memory could not be read.")(err), null),
    );
  useEffect(() => {
    void load();
  }, [onSignedOut]);
  // After Save or Cancel, the focus goes back to the row's Edit button.
  useEffect(() => {
    if (focusEdit === null) return;
    group.current?.querySelector<HTMLButtonElement>(`[data-memory-edit="${focusEdit}"]`)?.focus();
    setFocusEdit(null);
  }, [focusEdit, list, editing]);

  const close = (noteId: number): void => {
    setEditing(null);
    setFocusEdit(noteId);
  };
  const save = (): void => {
    if (editing === null) return;
    if (editing.text.trim() === "") return setEditing({ ...editing, problem: "Write the note, or cancel to keep it as it was. To remove it, use Forget." });
    const sent = editing;
    setEditing({ ...sent, saving: true, problem: null });
    editMemoryNote(sent.id, sent.text, sent.hash).then(
      (saved) => {
        setList((was) => (was === null ? was : { ...was, notes: was.notes.map((n) => (n.id === saved.id ? saved : n)) }));
        close(saved.id);
      },
      async (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        const message = err instanceof ApiError ? err.message : "The note was not saved: Botbench could not be reached. Your text is still here. Save again once it is.";
        // Changed or forgotten since this screen read it: what is there now is read, and nothing was overwritten.
        if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
          const found = await load();
          const now = found?.notes.find((n) => n.id === sent.id);
          if (now === undefined) {
            setEditing(null);
            setProblem(message);
            return;
          }
          return setEditing({ ...sent, saving: false, problem: message, hash: now.hash, now: now.text });
        }
        setEditing({ ...sent, saving: false, problem: message });
      },
    );
  };
  const forget = (note: MemoryNote): void => {
    setForgetting(true);
    setProblem(null);
    const at = notes.findIndex((n) => n.id === note.id);
    forgetMemoryNote(note.id, note.hash).then(
      (found) => {
        setList(found);
        setForgetting(false);
        // The focus goes to the Edit button of the note that took its place, or of the one before it when it was last.
        const next = found.notes[at] ?? found.notes[at - 1];
        if (next !== undefined) setFocusEdit(next.id);
      },
      (err: unknown) => {
        setForgetting(false);
        failed("The note was not forgotten.")(err);
        void load();
      },
    );
  };

  const notes = list?.notes ?? [];
  return (
    <div ref={group} data-testid="memory-settings" className="ds-settings-row__group" role="group" aria-labelledby={`${id}-heading`}>
      <h2 className="ds-settings-row__heading" id={`${id}-heading`}>
        Memory
      </h2>
      <p className="ds-settings-row__description">
        {`Start a chat message with "Remember:" or "Remember that" and Botbench keeps the rest of it as a note, in your words. Every agent of a later chat, and the planner and builder of a later run, is given your notes. Botbench keeps them on this Mac, in its data folder, and never adds them to a repository. An agent given them sends them to its provider with the rest of its prompt, as it does your messages.${list === null ? "" : ` At most ${list.maxNoteChars.toLocaleString("en")} characters a note, and ${list.maxKb} KB in all.`}`}
      </p>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      {list === null ? (
        problem === null && <p role="status" className="ds-settings-row__description">Reading memory.</p>
      ) : (
        <div className="ds-editable-list">
          {notes.length === 0 ? (
            <div className="ds-empty-state ds-empty-state--compact">
              <h3 className="ds-empty-state__title">No notes yet</h3>
              <p className="ds-empty-state__body">Start a chat message with "Remember:" to add the first one.</p>
            </div>
          ) : (
            <ol data-testid="memory-notes" className="ds-editable-list__items" aria-label="Notes in memory, newest first">
              {notes.map((note, i) => (
                <li key={note.id} className="ds-editable-list__item">
                  {editing?.id === note.id ? (
                    <NoteEditor editing={editing} number={i + 1} max={list.maxNoteChars} onChange={(text) => setEditing({ ...editing, text })} onSave={save} onCancel={() => close(note.id)} />
                  ) : (
                    <NoteRow note={note} number={i + 1} busy={forgetting || editing !== null} onEdit={() => setEditing({ id: note.id, text: note.text, hash: note.hash, saving: false, problem: null, now: null })} onForget={() => forget(note)} />
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
