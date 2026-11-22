import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A secondary action that is taken in two steps: its button only opens a dialog that states what will happen, and the
 * action runs when that statement is confirmed. Escape and the cancel button close it and change nothing. No button
 * of the dialog is drawn as a primary action, and focus starts on the one that changes nothing.
 * `losing` is for a step that takes something away: the dialog is then an alert dialog with the cancel button first.
 * `children` is the statement.
 */
export function ConfirmAction({ label, opener, title, confirmLabel, cancelLabel, disabled, losing = false, testId, onConfirm, children }: { label: string; opener?: { small: boolean; name: string }; title: ReactNode; confirmLabel: string; cancelLabel: string; disabled: boolean; losing?: boolean; testId: string; onConfirm: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!open) return;
    // showModal keeps focus inside the dialog, makes the page behind it inert, and closes on Escape.
    if (dialog.current?.open === false) dialog.current.showModal();
    cancel.current?.focus();
  }, [open]);

  const closed = (): void => {
    const confirmed = dialog.current?.returnValue === "confirm";
    setOpen(false);
    if (confirmed) onConfirm();
  };

  const confirmButton = (
    <button type="submit" value="confirm" disabled={disabled} className={losing ? "gw-button gw-button--danger" : "gw-button"}>
      {confirmLabel}
    </button>
  );
  const cancelButton = (
    <button ref={cancel} type="submit" value="cancel" className="gw-button">
      {cancelLabel}
    </button>
  );

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} aria-label={opener?.name} data-gw-content-label={opener === undefined ? undefined : ""} className={opener?.small === true ? "gw-button gw-button--quiet gw-button--small" : "gw-button"}>
        {label}
      </button>
      {open && (
        <dialog ref={dialog} data-testid={testId} role={losing ? "alertdialog" : undefined} aria-labelledby={titleId} aria-describedby={bodyId} onClose={closed} className={losing ? "gw-dialog gw-confirm-dialog" : "gw-dialog"}>
          <form method="dialog" className="gw-dialog__panel">
            <h2 id={titleId} className="gw-dialog__title">
              {title}
            </h2>
            <div id={bodyId} className="gw-dialog__body">
              {children}
            </div>
            {losing ? (
              <div className="gw-dialog__footer gw-confirm-dialog__actions">
                {cancelButton}
                {confirmButton}
              </div>
            ) : (
              <div className="gw-dialog__footer">
                {confirmButton}
                {cancelButton}
              </div>
            )}
          </form>
        </dialog>
      )}
    </>
  );
}
