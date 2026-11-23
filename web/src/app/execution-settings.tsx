import { useEffect, useId, useState } from "react";
import { ApiError, getRepositoryExecutions, type RepositoryExecution } from "../api/client.ts";
import { Alert } from "../components/header.tsx";
import { folderName } from "./composer.ts";
import { EXECUTION_ABOUT, EXECUTION_HEADING, executionWords, NO_REPOSITORIES } from "./execution-words.ts";

/**
 * Settings' "Where commands run" (src/execution.ts, ADR 0009): each repository of the settings file, and whether its
 * tasks' commands run on this Mac or in a container of the image it names. Set in the settings file, which Botbench
 * never writes, so it is shown here, not changed.
 */
export function ExecutionSettings({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [repositories, setRepositories] = useState<RepositoryExecution[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getRepositoryExecutions().then(
      (found) => live && (setRepositories(found), setProblem(null)),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? `Where commands run could not be read. ${err.message}` : "Where commands run could not be read: Botbench could not be reached.");
      },
    );
    return () => {
      live = false;
    };
  }, [onSignedOut]);

  return (
    <div data-testid="execution-settings" className="ds-settings-row__group" role="group" aria-labelledby={`${id}-heading`}>
      <h2 className="ds-settings-row__heading" id={`${id}-heading`}>
        {EXECUTION_HEADING}
      </h2>
      <p className="ds-settings-row__description">{EXECUTION_ABOUT}</p>
      {problem !== null ? (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      ) : repositories === null ? (
        <p role="status" className="ds-settings-row__description">
          Reading where commands run.
        </p>
      ) : repositories.length === 0 ? (
        <p className="ds-settings-row__description">{NO_REPOSITORIES}</p>
      ) : (
        repositories.map((r) => {
          const words = executionWords(r.execution);
          return (
            <div key={r.path} data-testid="execution" className="ds-settings-row">
              <div className="ds-settings-row__text">
                <p className="ds-settings-row__label">{folderName(r.path)}</p>
                <p className="ds-settings-row__description">{words.about}</p>
              </div>
              <div className="ds-settings-row__control">
                <p className="ds-settings-row__status">{words.kind}</p>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
