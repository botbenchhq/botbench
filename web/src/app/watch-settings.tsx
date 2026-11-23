import { useEffect, useId, useState } from "react";
import { ApiError, getWatch, type WatchStatus } from "../api/client.ts";
import { Alert } from "../components/header.tsx";
import { folderName } from "./composer.ts";
import { NO_WATCH, watchAbout, watchFailure, watchStateWords } from "./watch-words.ts";

/**
 * Settings' "Watched issues" (issue #73): each repository whose settings file entry has a "watch", with its label, how
 * often it is looked at, that the label is not trust (anyone with triage access can apply it), and how its last
 * look went: when it worked, or why it did not, with what gh said and when it tries again. The watch is set in the
 * settings file, which Botbench never writes, so it is shown here, not changed.
 */
export function WatchSettings({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [watches, setWatches] = useState<WatchStatus[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Read as Settings opens; Work is where the watch's changes show as they come.
  useEffect(() => {
    let live = true;
    getWatch().then(
      (found) => live && (setWatches(found.watches), setProblem(null)),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? `The watched repositories could not be read. ${err.message}` : "The watched repositories could not be read: Botbench could not be reached.");
      },
    );
    return () => {
      live = false;
    };
  }, [onSignedOut]);

  return (
    <div data-testid="watch-settings" className="ds-settings-row__group" role="group" aria-labelledby={`${id}-heading`}>
      <h2 className="ds-settings-row__heading" id={`${id}-heading`}>
        Watched issues
      </h2>
      {problem !== null ? (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      ) : watches === null ? (
        <p role="status" className="ds-settings-row__description">
          Reading the watched repositories.
        </p>
      ) : watches.length === 0 ? (
        <p className="ds-settings-row__description">{NO_WATCH}</p>
      ) : (
        watches.map((w) => {
          const failure = w.state === "failed" ? watchFailure(w) : null;
          return (
            <div key={w.path} className="ds-stack ds-gap-sm">
              <div data-testid="watch" className="ds-settings-row">
                <div className="ds-settings-row__text">
                  <p className="ds-settings-row__label">{folderName(w.path)}</p>
                  <p className="ds-settings-row__description">{watchAbout(w)}</p>
                </div>
                <div className="ds-settings-row__control">
                  <p role="status" className="ds-settings-row__status">
                    {watchStateWords(w)}
                  </p>
                </div>
              </div>
              {failure !== null && (
                <Alert tone="error" role="alert">
                  {`${failure.lead} `}
                  {w.said !== null && <span data-ds-content="">{`${w.said} `}</span>}
                  {failure.after}
                </Alert>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
