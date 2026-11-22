import { useState } from "react";
import { ApiError, resumeTask } from "../api/client.ts";
import { Alert } from "./header.tsx";

/**
 * Resume for a stopped task: what it will do, in the server's words, and the button that does it. `name` names the
 * task in the button's accessible name where several tasks are listed. `primary` draws it as the view's primary action.
 */
export function ResumeControl({ taskId, note, name, primary, onResumed, onSignedOut }: { taskId: number; note: string; name?: string; primary: boolean; onResumed: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const resume = (): void => {
    setBusy(true);
    setProblem(null);
    resumeTask(taskId).then(
      () => {
        setBusy(false);
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
  const label = busy ? "Resuming" : "Resume";
  return (
    <div className="ds-stack ds-gap-sm">
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      <p data-testid="resume-note">{note}</p>
      <div className="ds-cluster">
        <button type="button" aria-busy={busy} disabled={busy} aria-label={name === undefined ? undefined : `${label} ${name}`} onClick={resume} className={primary ? "ds-button ds-button--primary" : "ds-button"}>
          {label}
        </button>
      </div>
    </div>
  );
}
