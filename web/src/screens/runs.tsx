import { useCallback, useEffect, useState } from "react";
import { ApiError, listRuns, openEventStream, type RunSummary } from "../api/client.ts";
import { Alert, Frame, NewLink, Page, PageHeader } from "../components/header.tsx";
import { runFacts, runLook, runWord } from "../components/run-status.ts";
import { StatusBadge } from "../components/status.tsx";

export function RunsScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback((): void => {
    listRuns().then(
      (list) => {
        setRuns(list);
        setFailed(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else setFailed(err instanceof ApiError ? `The runs could not be read. ${err.message}` : "The runs could not be read: Botbench could not be reached.");
      },
    );
  }, [onSignedOut]);

  // Read the list whenever the stream comes up, and again each time any run reaches a new state or its planner starts or stops waiting on an approval.
  useEffect(() => {
    load();
    return openEventStream(0, { onEvent: () => {}, onConnection: (connected) => connected && load(), onSignedOut, onRun: load, onApproval: load });
  }, [load, onSignedOut]);

  return (
    <Frame current="runs">
      <Page>
        <PageHeader title="Runs" action={<NewLink href="#/runs/new">New run</NewLink>} />
        {failed !== null && (
          <Alert tone="error" role="alert">
            {failed}
          </Alert>
        )}
        {runs === null ? (
          failed === null && (
            <p role="status" data-testid="run-list-state" className="ds-spinner">
              Reading runs.
            </p>
          )
        ) : runs.length === 0 ? (
          <div className="ds-empty-state">
            <h2 data-testid="run-list-state" className="ds-empty-state__title">
              No runs yet
            </h2>
            <p className="ds-empty-state__body">A run makes a list of tasks from a prompt or a spec file, for you to edit and approve. Start one with New run.</p>
          </div>
        ) : (
          <ul data-testid="run-list" className="ds-list">
            {runs.map((run) => (
              <li key={run.id} className="ds-list__row">
                <a href={`#/runs/${run.id}`} className="ds-list__link">
                  <span className="ds-run-status">
                    <span data-ds-content="" className="ds-run-status__title">
                      {run.title}
                    </span>
                    <span className="ds-run-status__station">
                      <StatusBadge look={runLook(run)}>{runWord(run)}</StatusBadge>
                    </span>
                    <span className="ds-run-status__facts">{runFacts(run)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Page>
    </Frame>
  );
}
