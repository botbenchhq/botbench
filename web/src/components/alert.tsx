import type { ReactNode } from "react";

/** A message inside a view. `tone` picks the word that names it; the stylesheet draws the matching icon. */
export function Alert({ tone, role, id, testId, title, action, children }: { tone: "note" | "warning" | "error"; role?: "status" | "alert"; id?: string; testId?: string; title?: string; action?: ReactNode; children: ReactNode }) {
  const look = { note: "ds-alert", warning: "ds-alert ds-alert--warning", error: "ds-alert ds-alert--danger" }[tone];
  const label = { note: "Note", warning: "Warning", error: "Error" }[tone];
  return (
    <div className={look} role={role} id={id} data-testid={testId}>
      <div className="ds-alert__content">
        <p className="ds-alert__label">{label}</p>
        {title !== undefined && <p className="ds-alert__title">{title}</p>}
        <p className="ds-alert__body">{children}</p>
        {action !== undefined && <div className="ds-alert__action">{action}</div>}
      </div>
    </div>
  );
}
