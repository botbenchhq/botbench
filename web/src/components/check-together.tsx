import { useCallback, useEffect, useId, useState } from "react";
import { ApiError, getCheckTogether, setCheckTogetherRequired, startCheckTogether, type CheckTogetherView, type CombinedCheck } from "../api/client.ts";
import { checkButton, commitsLine, othersCodeLine, outcomeLine, requirementLine, staleLine } from "../app/check-together.ts";
import { CommandEvidence } from "./evidence.tsx";
import { Alert } from "./header.tsx";
import { LOOKS } from "./looks.ts";
import { StatusBadge } from "./status.tsx";

/** How often the section is read again while a check together runs. */
const WHILE_RUNNING_MS = 3000;

/**
 * "Check together" on a task's screen, under its own checks (Peers P4): the owner's setting for the repository, each
 * check together with another workbench's open pull request (what it ran on, what it found, and whether it is out of
 * date), and a button for each open pull request it can be checked with. Nothing at all is shown for a task with no
 * result and nothing to check, also while it is read or when it cannot be read.
 */
export function CheckTogether({ taskId, repo, ready, onSignedOut }: { taskId: number; repo: string; ready: boolean; onSignedOut: () => void }) {
  const id = useId();
  const [view, setView] = useState<CheckTogetherView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const failed = useCallback(
    (err: unknown): void => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? err.message : "Botbench could not be reached.");
    },
    [onSignedOut],
  );
  const load = useCallback(() => {
    getCheckTogether(taskId).then(setView, failed);
  }, [taskId, failed]);
  useEffect(() => load(), [load, ready]);
  // While one runs, it is read again until it has ended.
  useEffect(() => {
    if (view?.running == null) return;
    const timer = setTimeout(load, WHILE_RUNNING_MS);
    return () => clearTimeout(timer);
  }, [view, load]);

  if (view === null || (view.checks.length === 0 && view.offers.length === 0 && view.running === null && !view.required)) return null;

  const check = (number: number): void => {
    setProblem(null);
    setAsking(true);
    startCheckTogether(taskId, number).then(load, failed).finally(() => setAsking(false));
  };
  const changeRequired = (required: boolean): void => {
    setProblem(null);
    setAsking(true);
    setCheckTogetherRequired(repo, required).then(load, failed).finally(() => setAsking(false));
  };

  return (
    <section aria-labelledby={`${id}-heading`} data-testid="check-together" className="ds-stack ds-gap-sm">
      <h2 id={`${id}-heading`}>Check together</h2>
      <p>Botbench merges this task's work with another workbench's open pull request in a temporary copy, runs this repository's setup commands and checks there, then removes the copy. Nothing is pushed or merged anywhere else.</p>
      <p data-testid="check-together-required">{requirementLine(view)}</p>
      <div className="ds-cluster ds-gap-sm">
        <button type="button" className="ds-button ds-button--small" disabled={asking} onClick={() => changeRequired(!view.required)}>
          {view.required ? "Stop requiring it on this repository" : "Require it on this repository"}
        </button>
      </div>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      {view.viewProblem !== null && <p>{`The other workbenches' pull requests could not be read: ${view.viewProblem}`}</p>}
      {view.running !== null && (
        <p role="status" className="ds-spinner">
          {`Checking together with pull request #${view.running}.`}
        </p>
      )}
      {view.checks.length > 0 && (
        <ol data-testid="check-together-results" className="ds-stack ds-gap-sm">
          {view.checks.map((c) => (
            <Result key={c.id} check={c} />
          ))}
        </ol>
      )}
      {ready && view.offers.length > 0 && (
        <ul aria-label="Open pull requests from other workbenches" className="ds-list">
          {view.offers.map((offer) => (
            <li key={offer.number} className="ds-list__row">
              <div className="ds-list__content">
                <span className="ds-list__body">
                  <span className="ds-list__primary">
                    {`Pull request #${offer.number}: `}
                    <span data-ds-content="">{offer.title}</span>
                  </span>
                  <span className="ds-list__secondary">
                    <span data-ds-content="">{offer.workbench}</span>
                    {offer.overlaps.length === 0 ? " · changes none of this task's files" : ` · also changes ${offer.overlaps.length === 1 ? "1 of this task's files" : `${offer.overlaps.length} of this task's files`}`}
                  </span>
                </span>
              </div>
              <button type="button" data-testid="check-together-start" className="ds-button ds-button--small" disabled={asking || view.running !== null} onClick={() => check(offer.number)}>
                {checkButton(offer.number)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One stored check together: whose code it included, what it ran on, what it found, whether it still counts, and each command. */
function Result({ check }: { check: CombinedCheck }) {
  const stale = staleLine(check);
  const look = check.outcome === "passed" ? LOOKS.checkPassed : LOOKS.checkFailed;
  const word = check.outcome === "passed" ? "Passed together:" : check.outcome === "conflict" ? "Conflict:" : check.outcome === "failed" ? "Failed together:" : "Did not run:";
  return (
    <li data-testid="check-together-result" className="ds-stack ds-gap-sm">
      <h3>{`With ${check.workbench}'s pull request #${check.pullRequest}`}</h3>
      <p>
        <StatusBadge look={LOOKS.outsideText}>Another workbench's code</StatusBadge>
        {` ${othersCodeLine(check)}`}
      </p>
      <p>{commitsLine(check)}</p>
      <p data-testid="check-together-outcome">
        <StatusBadge look={look}>{word}</StatusBadge>
        {` ${outcomeLine(check)}`}
      </p>
      {stale !== null && (
        <p data-testid="check-together-stale">
          <span className="ds-badge ds-badge--warning">Out of date</span>
          {` ${stale}`}
        </p>
      )}
      {check.conflicts.length > 0 && (
        <ul aria-label="Files in conflict" className="ds-list ds-list--dense">
          {check.conflicts.map((file) => (
            <li key={file} className="ds-list__row">
              <div className="ds-list__content">
                <code data-ds-content="" className="ds-list__primary">
                  {file}
                </code>
              </div>
            </li>
          ))}
        </ul>
      )}
      <CommandEvidence rows={check.commands.map((c) => ({ ...c, round: 1 }))} what={{ one: "command", many: "commands" }} failedFirst />
    </li>
  );
}
