import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { ApiError, renameChat, type ChatItem } from "../api/client.ts";

/** The longest name a chat can be given; the server holds the same limit (src/engine/chats.ts). */
const MAX_TITLE = 80;

/**
 * Rename a chat: a name of the owner's own, shown in the Work list in place of the chat's first message. Leaving it
 * empty gives the chat back its first message as its name. Only the name is stored: the chat's messages are not
 * touched. `onClose` is called with the chat as it now is, or null when nothing was changed.
 */
export function RenameChatDialog({ chat, onClose, onSignedOut }: { chat: ChatItem; onClose: (renamed: ChatItem | null) => void; onSignedOut: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(chat.named ? chat.title : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const titleId = useId();
  const fieldId = useId();
  const saved = useRef<ChatItem | null>(null);

  useEffect(() => {
    if (dialog.current?.open === false) dialog.current.showModal();
    input.current?.select();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "cancel") return dialog.current?.close();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    renameChat(chat.id, value).then(
      (renamed) => {
        saved.current = renamed;
        dialog.current?.close();
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The chat was not renamed. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
      },
    );
  };

  return (
    <dialog ref={dialog} data-testid="rename-chat" aria-labelledby={titleId} onClose={() => onClose(saved.current)} className="ds-dialog">
      <form onSubmit={submit} className="ds-dialog__panel" noValidate>
        <h2 id={titleId} className="ds-dialog__title">
          Rename the chat
        </h2>
        <div className="ds-dialog__body">
          <div className="ds-field">
            <label className="ds-field__label" htmlFor={fieldId}>
              Chat name
            </label>
            <input
              ref={input}
              id={fieldId}
              className="ds-field__control"
              type="text"
              name="title"
              autoComplete="off"
              maxLength={MAX_TITLE}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={problem !== null || undefined}
              aria-describedby={problem === null ? `${fieldId}-about` : `${fieldId}-about ${fieldId}-error`}
            />
            <p className="ds-field__description" id={`${fieldId}-about`}>{`Up to ${MAX_TITLE} characters. Leave it empty to name the chat by its first message again. The messages stay as they are.`}</p>
            {problem !== null && (
              <p className="ds-field__error" id={`${fieldId}-error`} role="alert">
                {problem}
              </p>
            )}
          </div>
        </div>
        <div className="ds-dialog__footer">
          <BusyButton type="submit" value="save" variant="primary" busy={busy} busyLabel="Saving">
            Save name
          </BusyButton>
          <button type="submit" value="cancel" className="ds-button">
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
