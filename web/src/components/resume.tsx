import { useState } from "react";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { ApiError, resumeTask } from "../api/client.ts";
import { Alert } from "./alert.tsx";

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
  return (
    <div className="ds-stack ds-gap-sm">
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      <p data-testid="resume-note">{note}</p>
      {/* What is resumed names the group, so the button that is busy, and reads "Resuming", still says which task. */}
      <div className="ds-cluster" role={name === undefined ? undefined : "group"} aria-label={name}>
        <BusyButton variant={primary ? "primary" : "secondary"} busy={busy} busyLabel="Resuming" aria-label={name === undefined ? undefined : `Resume ${name}`} onClick={resume}>
          Resume
        </BusyButton>
      </div>
    </div>
  );
}
