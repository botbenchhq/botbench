import { useState } from "react";
import { ApiError, discardTask, type TaskDetail } from "../api/client.ts";
import { ConfirmAction } from "./confirm.tsx";
import { Leftovers } from "./decision.tsx";
import { Alert } from "./header.tsx";
import { plural } from "../app/format.ts";

/** How a task ended without being ready for review, in the words of its state. */
const ENDED: Partial<Record<TaskDetail["status"], string>> = { failed: "failed", interrupted: "was stopped", cancelled: "was cancelled", drafted: "drafted a message and changed no file" };

/**
 * What a task that failed, was stopped or was cancelled left behind, and Discard, which removes it after asking: its
 * separate copy of the project and Botbench's branch. Such a task was never ready for review, so nothing is decided.
 * Shown while something is left, also after a discard that could not finish; once nothing is, that it was discarded.
 */
export function DiscardSection({ task, startOpen = false, onDiscarded, onSignedOut }: { task: TaskDetail; startOpen?: boolean; onDiscarded: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ended = ENDED[task.status];
  const remains = task.remains;
  if (ended === undefined) return null;
  if (remains === null) return task.remainsProblem === null ? null : <Alert tone="error" role="alert">{task.remainsProblem}</Alert>;
  if (!remains.copy && !remains.branch) {
    // Nothing is left now. Once discarded, the work its reason above speaks of is gone with the copy and the branch.
    return remains.discardedAt === null ? null : <p data-testid="discarded">Discarded. Nothing of this task is left: its copy of the project and its branch are gone, with the work on them. Nothing was merged or pushed.</p>;
  }

  const left = [remains.copy && "its separate copy of the project", remains.branch && `its branch ${task.branch ?? ""}`].filter((part): part is string => typeof part === "string");
  const send = (): void => {
    setBusy(true);
    setProblem(null);
    // The owner confirmed exactly the files this screen showed; the server refuses, and lists them again, if they changed since.
    discardTask(task.id, remains.files).then(
      () => {
        setBusy(false);
        onDiscarded();
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`Nothing was discarded. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
        onDiscarded();
      },
    );
  };

  return (
    <section aria-labelledby="discard-heading" className="ds-stack ds-gap-sm">
      <h2 id="discard-heading">What the task left</h2>
      <p>{`This task ${ended}, so there is nothing to review. Botbench kept ${left.join(" and ")}, so you can look at what it did. Discard removes ${plural(left.length, "it", "both")} when you no longer want ${plural(left.length, "it", "them")}.`}</p>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      <div className="ds-cluster">
        <ConfirmAction label="Discard" title="Discard what this task left?" confirmLabel="Discard" cancelLabel="Keep them" disabled={false} busy={busy} busyLabel="Discarding" losing testId="discard" startOpen={startOpen} onConfirm={send}>
          <p>{`This removes ${left.join(" and ")}. The work on ${remains.branch ? "the branch" : "it"} is gone for good. Nothing is merged or pushed.`}</p>
          {remains.files.length > 0 && (
            <>
              <p>These files are in the task's copy and are not on the branch, and go with it:</p>
              <Leftovers files={remains.files} />
            </>
          )}
        </ConfirmAction>
      </div>
    </section>
  );
}
