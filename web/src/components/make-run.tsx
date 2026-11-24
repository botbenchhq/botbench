import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, getRunSource, type RunSourceView } from "../api/client.ts";
import { ABOUT, handOff, MAKE_RUN, makeRun, messagePreview, NOTE_LABEL, PICK_ABOUT, PICK_HEADING, type MakeRunSource } from "../app/run-source.ts";

/** The note of Make this a run and what its button does, whichever screen draws the field: the note, the reason it is refused, and `make`, which opens the composer with it. */
export function useMakeRun(source: MakeRunSource, chatRepo: string | null = null) {
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const make = (): void => {
    // The server checks the note again on Send; here the owner is told at once, in the same words.
    const made = makeRun(source, note, chatRepo);
    if ("refused" in made) {
      setProblem(made.refused);
      return box.current?.focus();
    }
    setProblem(null);
    handOff(made.handOff);
    window.location.hash = made.address;
  };
  return { note, setNote, problem, setProblem, box, make };
}

/**
 * The note field and Make this a run: the note opens the composer on Plan a run, where the owner can still change it
 * and every setting. Nothing is stored here, and nothing is sent: the composer sends, on Send. `messages`: for a chat,
 * the owner's own messages in it, any of which may be put in the note.
 */
function MakeRunForm({ source, about, messages, chatRepo = null, onCancel }: { source: MakeRunSource; about: string; messages?: readonly { text: string; at: string }[]; chatRepo?: string | null; /** In a dialog, a view of its own, where Make this a run is the primary action. */ onCancel?: () => void }) {
  const { note, setNote, problem, setProblem, box, make } = useMakeRun(source, chatRepo);
  const fieldId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "cancel") return onCancel?.();
    make();
  };
  const described = [`${fieldId}-about`, problem === null ? null : `${fieldId}-error`].filter((id) => id !== null).join(" ");
  return (
    <form onSubmit={submit} className="ds-stack ds-gap-sm" noValidate>
      {messages !== undefined && messages.length > 0 && (
        <div className="ds-stack ds-gap-xs">
          <h3 id={`${fieldId}-pick`}>{PICK_HEADING}</h3>
          <p>{PICK_ABOUT}</p>
          <ul data-testid="make-run-messages" aria-labelledby={`${fieldId}-pick`} className="ds-list ds-list--dense">
            {messages.map((message, i) => (
              <li key={`${message.at} ${i}`} className="ds-list__row">
                <div className="ds-list__content">
                  <span className="ds-list__body">
                    <span data-ds-content="" className="ds-list__primary">
                      {messagePreview(message.text)}
                    </span>
                  </span>
                </div>
                <div className="ds-list__action">
                  {/* The name holds the owner's own words, which the screen-words check does not read as Botbench's. */}
                  <button
                    type="button"
                    className="ds-button ds-button--quiet ds-button--small"
                    data-ds-content-label=""
                    aria-label={`Use ${messagePreview(message.text, 60)}`}
                    onClick={() => {
                      setNote(message.text);
                      setProblem(null);
                      box.current?.focus();
                    }}
                  >
                    Use
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ds-field">
        <label htmlFor={fieldId} className="ds-field__label">
          {NOTE_LABEL}
        </label>
        <textarea ref={box} id={fieldId} data-testid="make-run-note" value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={problem !== null || undefined} aria-describedby={described} className="ds-field__control ds-textarea" />
        <p id={`${fieldId}-about`} className="ds-field__description">
          {about}
        </p>
        {problem !== null && (
          <p id={`${fieldId}-error`} data-testid="make-run-problem" role="alert" className="ds-field__error">
            {problem}
          </p>
        )}
      </div>
      <div className="ds-cluster">
        <button type="submit" value="make" data-testid="make-run" className={onCancel === undefined ? "ds-button" : "ds-button ds-button--primary"}>
          {MAKE_RUN}
        </button>
        {onCancel !== undefined && (
          <button type="submit" value="cancel" className="ds-button ds-button--quiet">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * On a chat: Make this a run, in a dialog with the note field and the owner's own messages to pick from, read from the
 * chat as Botbench recorded it. `attemptId`: any attempt of the chat. `repo`: the repository the chat reads on this
 * device, which the composer then opens on.
 */
export function MakeRunDialog({ attemptId, repo, onClose, onSignedOut }: { attemptId: number; repo?: string; onClose: () => void; onSignedOut: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [source, setSource] = useState<RunSourceView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (dialog.current?.open === false) dialog.current.showModal();
    let live = true;
    getRunSource({ kind: "chat", id: attemptId }).then(
      (found) => live && setSource(found),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? err.message : "The chat could not be read: Botbench could not be reached.");
      },
    );
    return () => {
      live = false;
    };
  }, [attemptId, onSignedOut]);
  const close = (): void => dialog.current?.close();
  return (
    <dialog ref={dialog} data-testid="make-run-dialog" aria-labelledby={titleId} onClose={onClose} className="ds-dialog">
      <div className="ds-dialog__panel">
        <h2 id={titleId} className="ds-dialog__title">
          {MAKE_RUN}
        </h2>
        <div className="ds-dialog__body ds-stack ds-gap-sm">
          {problem !== null ? (
            <>
              <p role="alert">{problem}</p>
              <div className="ds-cluster">
                <button type="button" className="ds-button" onClick={close}>
                  Close
                </button>
              </div>
            </>
          ) : source === null ? (
            <p role="status" className="ds-spinner">
              Reading the chat.
            </p>
          ) : (
            <MakeRunForm source={{ kind: "chat", id: source.id }} about={ABOUT.chat} messages={source.messages ?? []} chatRepo={repo ?? null} onCancel={close} />
          )}
        </div>
      </div>
    </dialog>
  );
}
