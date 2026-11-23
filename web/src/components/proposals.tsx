import { useCallback, useEffect, useId, useState } from "react";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { ApiError, dismissProposal, getWatch, type Proposal, type WatchStatus } from "../api/client.ts";
import { PROPOSALS_ABOUT, proposalLine, startAddress, watchFailure } from "../app/watch-words.ts";
import { Alert } from "./header.tsx";

/**
 * Work's "Issues to start" (issue #73): each open issue of a watched repository that carries its label, proposed as a
 * run, with its title and author as plain text (both written outside the project), and Start and Dismiss. Start opens
 * the composer with the issue attached; nothing is built until the owner sends the run from there. Dismiss takes it off
 * Work for good. A watched repository whose last look failed says so, with what gh said and when it tries again. The
 * section is shown only when there is one or the other; nothing at all while it is read or when it cannot be.
 */
export function Proposals({ refresh, onSignedOut }: { refresh: number; onSignedOut: () => void }) {
  const [found, setFound] = useState<{ watches: WatchStatus[]; proposals: Proposal[] } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();

  const load = useCallback((): void => {
    getWatch().then(setFound, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
    });
  }, [onSignedOut]);
  // Read again each time Work's live updates say the watch or a run changed (`refresh`), and when they come up.
  useEffect(() => load(), [load, refresh]);

  const dismiss = (p: Proposal): void => {
    setBusy(p.id);
    setProblem(null);
    dismissProposal(p.id).then(
      () => {
        setBusy(null);
        setFound((now) => (now === null ? now : { ...now, proposals: now.proposals.filter((q) => q.id !== p.id) }));
      },
      (err: unknown) => {
        setBusy(null);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (err instanceof ApiError && err.status === 404) return load();
        setProblem(err instanceof ApiError ? `Issue #${p.number} was not dismissed. ${err.message}` : `Issue #${p.number} was not dismissed: Botbench could not be reached.`);
      },
    );
  };

  const failed = (found?.watches ?? []).filter((w) => w.state === "failed");
  const proposals = found?.proposals ?? [];
  if (proposals.length === 0 && failed.length === 0) return null;
  return (
    <section data-testid="proposals" aria-labelledby={`${id}-heading`} className="ds-stack ds-gap-sm">
      <h2 id={`${id}-heading`}>Issues to start</h2>
      {proposals.length > 0 && <p>{PROPOSALS_ABOUT}</p>}
      {failed.map((w) => {
        const words = watchFailure(w);
        return (
          <Alert key={w.path} tone="error" role="alert">
            {`${words.lead} `}
            {w.said !== null && <span data-ds-content="">{`${w.said} `}</span>}
            {words.after}
          </Alert>
        );
      })}
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      {proposals.length > 0 && (
        <ul aria-label="Issues to start" className="ds-list">
          {proposals.map((p) => {
            const line = proposalLine(p);
            return (
              <li key={p.id} data-testid="proposal" className="ds-list__row">
                <div className="ds-list__content">
                  <span className="ds-list__body">
                    <span data-ds-content="" className="ds-list__primary">
                      {p.title}
                    </span>
                    <span className="ds-list__secondary">
                      {line.lead}
                      {line.author !== null && <span data-ds-content="">{line.author}</span>}
                      {line.rest}
                    </span>
                  </span>
                </div>
                <div className="ds-list__action">
                  <div className="ds-button-group" role="group" aria-label={`Issue #${p.number}`}>
                    <BusyButton variant="quiet" size="small" busy={busy === p.id} busyLabel="Dismissing" aria-label={`Dismiss issue #${p.number}`} onClick={() => dismiss(p)}>
                      Dismiss
                    </BusyButton>
                    <button type="button" aria-label={`Start a run from issue #${p.number}`} onClick={() => (window.location.hash = startAddress(p))} className="ds-button ds-button--small">
                      Start
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
