import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * The dialog of a step taken in two steps: it states what will happen, and `onClose` is called with whether that was
 * confirmed. Escape and the cancel button close it and change nothing. No button of it is drawn as a primary action,
 * and focus starts on the one that changes nothing. `losing` is for a step that takes something away: the dialog is
 * then an alert dialog with the cancel button first. `children` is the statement. It is shown while it is rendered:
 * the opener renders it, from its own button or from a menu item.
 */
export function ConfirmDialog({ title, confirmLabel, cancelLabel, disabled, losing = false, testId, onClose, children }: { title: ReactNode; confirmLabel: string; cancelLabel: string; disabled: boolean; losing?: boolean; testId: string; onClose: (confirmed: boolean) => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    // showModal keeps focus inside the dialog, makes the page behind it inert, and closes on Escape.
    if (dialog.current?.open === false) dialog.current.showModal();
    cancel.current?.focus();
  }, []);

  const confirmButton = (
    <button type="submit" value="confirm" disabled={disabled} className={losing ? "ds-button ds-button--danger" : "ds-button"}>
      {confirmLabel}
    </button>
  );
  const cancelButton = (
    <button ref={cancel} type="submit" value="cancel" className="ds-button">
      {cancelLabel}
    </button>
  );

  return (
    <dialog ref={dialog} data-testid={testId} role={losing ? "alertdialog" : undefined} aria-labelledby={titleId} aria-describedby={bodyId} onClose={() => onClose(dialog.current?.returnValue === "confirm")} className={losing ? "ds-dialog ds-confirm-dialog" : "ds-dialog"}>
      <form method="dialog" className="ds-dialog__panel">
        <h2 id={titleId} className="ds-dialog__title">
          {title}
        </h2>
        <div id={bodyId} className="ds-dialog__body">
          {children}
        </div>
        {losing ? (
          <div className="ds-dialog__footer ds-confirm-dialog__actions">
            {cancelButton}
            {confirmButton}
          </div>
        ) : (
          <div className="ds-dialog__footer">
            {confirmButton}
            {cancelButton}
          </div>
        )}
      </form>
    </dialog>
  );
}

/**
 * A secondary action that is taken in two steps: its button only opens a `ConfirmDialog`, and the action runs when
 * that statement is confirmed. `primary` draws the opening button as the view's one primary action, for a step that
 * is the main thing the view is for and asks first only some of the time (Accept, when the checks left files behind).
 * `startOpen` opens the dialog at once, for a step the owner chose elsewhere (Discard, from a row's More menu on Work).
 * `busy`: the confirmed action is being sent. The button carries aria-busy and ignores presses, but stays enabled, so
 * focus, which the closing dialog gives back to it, stays on it. With `busyLabel` it then shows those words in place of
 * its label; its name is those words and then `opener.object`, what the action is about ("Taking back" and the command),
 * so one of several in a list still says which it is. `opener.theirs` marks an object that holds somebody else's words.
 * `disabled` is for another action's running, never its own.
 * `critical` marks a button that must never be hidden.
 */
export function ConfirmAction({ label, opener, primary = false, title, confirmLabel, cancelLabel, disabled, busy = false, busyLabel, critical = false, losing = false, testId, startOpen = false, onConfirm, children }: { label: string; opener?: { small: boolean; name: string; object?: string; theirs?: boolean }; primary?: boolean; title: ReactNode; confirmLabel: string; cancelLabel: string; disabled: boolean; busy?: boolean; busyLabel?: string; critical?: boolean; losing?: boolean; testId: string; startOpen?: boolean; onConfirm: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  const button = useRef<HTMLButtonElement>(null);
  const closed = (confirmed: boolean): void => {
    setOpen(false);
    // A dialog opened at once had no opener to give focus back to; its button is where the action lives.
    if (startOpen) button.current?.focus();
    if (confirmed) onConfirm();
  };

  const saysBusy = busy && busyLabel !== undefined;
  const name = saysBusy ? undefined : opener?.name;
  return (
    <>
      <button ref={button} type="button" disabled={disabled} aria-busy={busy || undefined} data-ds-critical={critical ? "" : undefined} onClick={() => busy || setOpen(true)} aria-label={name} data-ds-content-label={name === undefined ? undefined : ""} className={opener?.small === true ? "ds-button ds-button--quiet ds-button--small" : primary ? "ds-button ds-button--primary" : "ds-button"}>
        {saysBusy ? busyLabel : label}
        {saysBusy && opener?.object !== undefined && (
          <span className="ds-visually-hidden" data-ds-content={opener.theirs === true ? "" : undefined}>
            {` ${opener.object}`}
          </span>
        )}
      </button>
      {open && (
        <ConfirmDialog title={title} confirmLabel={confirmLabel} cancelLabel={cancelLabel} disabled={disabled} losing={losing} testId={testId} onClose={closed}>
          {children}
        </ConfirmDialog>
      )}
    </>
  );
}
