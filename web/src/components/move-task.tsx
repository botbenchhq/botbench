import { useState } from "react";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { ApiError, moveTask, type TaskDetail } from "../api/client.ts";
import { MOVE_HEADING, moveAbout, moveButton, moveRefused } from "../app/handoff-words.ts";
import { Alert } from "./header.tsx";

/**
 * Move a task that is being built to another agent (src/engine/handoff.ts): shown only while its builder is at work,
 * with one button for each agent the server says can take it over now (never the run's reviewer, and only agents that
 * could build it in its run's mode). None of them is the view's primary action.
 */
export function MoveTask({ task, onMoved, onSignedOut }: { task: Pick<TaskDetail, "id" | "status" | "builder" | "moveTo">; onMoved: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const move = (agent: string): void => {
    setBusy(agent);
    setProblem(null);
    moveTask(task.id, agent).then(
      () => {
        setBusy(null);
        onMoved();
      },
      (err: unknown) => {
        setBusy(null);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(moveRefused(err instanceof ApiError ? err.message : null));
        // The task may have moved on meanwhile: show what is so now.
        onMoved();
      },
    );
  };
  if (problem === null && (task.status !== "building" || task.moveTo.length === 0)) return null;
  return (
    <section aria-labelledby="move-heading" data-testid="task-move" className="ds-stack ds-gap-sm">
      <h2 id="move-heading">{MOVE_HEADING}</h2>
      {problem !== null && (
        <Alert tone="error" role="alert">
          <span data-testid="move-refused">{problem}</span>
        </Alert>
      )}
      {task.status === "building" && task.moveTo.length > 0 && (
        <>
          <p data-testid="move-about">{moveAbout(task.builder)}</p>
          <div className="ds-cluster">
            {task.moveTo.map((agent) => (
              <BusyButton key={agent} busy={busy === agent} busyLabel={moveButton(agent, true)} disabled={busy !== null && busy !== agent} onClick={() => move(agent)}>
                {moveButton(agent, false)}
              </BusyButton>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
