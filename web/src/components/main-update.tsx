import { useState } from "react";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { ApiError, updateWithMain, type TaskDetail } from "../api/client.ts";
import { agentName } from "../app/chat.ts";
import { behindLine, choiceLine, MAIN_HEADING, updateAbout, updateButton, updateRefused } from "../app/main-words.ts";
import { Alert } from "./header.tsx";

/**
 * A task and main (src/engine/branch-update.ts): how far its branch is behind main while it is ready for review, the
 * button that brings it up to date, and what came of the latest update. Shown while it is ready for review, while an
 * update is under way, and once one ended. The button is never the view's primary action: Accept is.
 */
export function MainUpdateSection({ task, onChanged, onSignedOut }: { task: Pick<TaskDetail, "id" | "status" | "builder" | "mainUpdate">; onChanged: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const m = task.mainUpdate;
  const ready = task.status === "awaiting_decision";
  if (!ready && !m.underWay && m.line === null && problem === null) return null;
  const update = (): void => {
    setBusy(true);
    setProblem(null);
    updateWithMain(task.id).then(
      () => {
        setBusy(false);
        onChanged();
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(updateRefused(err instanceof ApiError ? err.message : null));
        onChanged();
      },
    );
  };
  const behind = behindLine(m);
  const offer = ready && !m.underWay && m.behind !== null && m.behind > 0 && m.branch !== null;
  const choice = choiceLine(m);
  return (
    <section aria-labelledby="main-heading" data-testid="main-update" className="ds-stack ds-gap-sm">
      <h2 id="main-heading">{MAIN_HEADING}</h2>
      {problem !== null && (
        <Alert tone="error" role="alert">
          <span data-testid="main-update-refused">{problem}</span>
        </Alert>
      )}
      {m.line !== null && (
        <p data-testid="main-update-line" role="status">
          {m.line}
        </p>
      )}
      {ready && behind !== null && <p data-testid="main-behind">{behind}</p>}
      {ready && m.problem !== null && <p data-testid="main-problem">{m.problem}</p>}
      {offer && (
        <>
          {choice !== null && <p data-testid="main-choice">{choice}</p>}
          <p data-testid="main-about">{updateAbout(m.branch!, agentName(task.builder))}</p>
          <div className="ds-cluster">
            <BusyButton busy={busy} busyLabel={updateButton(m.branch!, true)} onClick={update}>
              {updateButton(m.branch!, false)}
            </BusyButton>
          </div>
        </>
      )}
    </section>
  );
}
