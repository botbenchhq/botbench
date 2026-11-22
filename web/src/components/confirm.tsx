import { useState, type ReactNode } from "react";

/**
 * A secondary action that is taken in two steps: its button only opens a statement of what will happen, and the
 * action runs when that statement is confirmed. Neither button is drawn as a primary action. `children` is the
 * statement, shown between the first tap and the second.
 */
export function ConfirmAction({ label, confirmLabel, cancelLabel, disabled, testId, onConfirm, children }: { label: string; confirmLabel: string; cancelLabel: string; disabled: boolean; testId: string; onConfirm: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="min-h-touch self-start rounded-sm border border-muted px-lg font-medium">
        {label}
      </button>
    );
  }
  return (
    <div data-testid={testId} className="flex flex-col gap-md rounded-sm bg-border p-md">
      {children}
      <div className="flex flex-wrap gap-sm">
        <button type="button" disabled={disabled} onClick={onConfirm} className="min-h-touch rounded-sm border border-accent bg-surface px-lg font-medium">
          {confirmLabel}
        </button>
        <button type="button" disabled={disabled} onClick={() => setOpen(false)} className="min-h-touch rounded-sm border border-muted bg-surface px-lg font-medium">
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
