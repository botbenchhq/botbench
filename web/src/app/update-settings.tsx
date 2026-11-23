import { useCallback, useEffect, useId, useState } from "react";
import { ApiError, getUpdate, setUpdateMode, startUpdate, type UpdateMode, type UpdateStatus } from "../api/client.ts";
import { Alert } from "../components/header.tsx";
import { canUpdate, UPDATE_MODE_ABOUT, updateStateWords, updateUnderWay, versionAbout } from "./update-words.ts";

/**
 * Settings' "Version" (issue #116): the version this Botbench runs, whether a newer release is published, with its
 * notes' summary and "Update now", and how it is going; and the owner's choice of updating on a tap (the default) or
 * by itself. Read as Settings opens, and again every few seconds while an update is under way.
 */
export function UpdateSettings({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = useCallback(
    (what: string) => (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what} Botbench could not be reached.`);
    },
    [onSignedOut],
  );
  useEffect(() => {
    let live = true;
    getUpdate().then((s) => live && (setStatus(s), setProblem(null)), (err: unknown) => live && failed("The version could not be read.")(err));
    return () => {
      live = false;
    };
  }, [failed]);
  // While an update waits, runs or restarts, its state is read again; a restart answers again once the new version runs.
  useEffect(() => {
    if (status === null || !updateUnderWay(status)) return;
    const timer = setTimeout(() => getUpdate().then(setStatus, () => setStatus({ ...status })), 3000);
    return () => clearTimeout(timer);
  }, [status]);

  const update = (): void => {
    setBusy(true);
    setProblem(null);
    startUpdate()
      .then(setStatus, failed("The update did not start."))
      .finally(() => setBusy(false));
  };
  const choose = (mode: UpdateMode): void => {
    setProblem(null);
    setUpdateMode(mode).then(setStatus, failed("When to update was not saved."));
  };

  const about = status === null ? null : versionAbout(status);
  const stateWords = status === null ? null : updateStateWords(status);
  return (
    <div data-testid="update-settings" className="ds-settings-row__group" role="group" aria-labelledby={`${id}-heading`}>
      <h2 className="ds-settings-row__heading" id={`${id}-heading`}>
        Version
      </h2>
      <div data-testid="version-row" className="ds-settings-row">
        <div className="ds-settings-row__text">
          <p className="ds-settings-row__label">{status === null ? "Botbench" : `Botbench ${status.version}`}</p>
          <p className="ds-settings-row__description" id={`${id}-about`}>
            {about === null ? "Reading the version." : about.lead}
            {about?.notes != null && (
              <>
                {" — "}
                <span data-ds-content="">{about.notes}</span>
              </>
            )}
          </p>
        </div>
        {status !== null && canUpdate(status) && (
          <div className="ds-settings-row__control">
            <button type="button" className="ds-button" aria-describedby={`${id}-about`} disabled={busy} onClick={update}>
              Update now
            </button>
          </div>
        )}
      </div>
      {stateWords !== null && (
        <p role="status" data-testid="update-state" className="ds-settings-row__description">
          {stateWords}
        </p>
      )}
      {status?.state.kind === "failed" && status.state.message !== null && (
        <Alert tone="error" role="alert" testId="update-failed">
          {status.state.message}
        </Alert>
      )}
      <div className="ds-settings-row">
        <div className="ds-settings-row__text">
          <label className="ds-settings-row__label" htmlFor={`${id}-mode`}>
            Updates
          </label>
          <p className="ds-settings-row__description" id={`${id}-mode-about`}>
            {UPDATE_MODE_ABOUT}
          </p>
        </div>
        <div className="ds-settings-row__control">
          <div className="ds-select">
            <select data-testid="update-mode" className="ds-field__control ds-select__control" id={`${id}-mode`} value={status?.mode ?? ""} disabled={status === null || !status.checking} aria-describedby={`${id}-mode-about`} onChange={(e) => choose(e.currentTarget.value as UpdateMode)}>
              {status === null && <option value="">Checking</option>}
              <option value="tap">On a tap</option>
              <option value="auto">Automatically</option>
            </select>
          </div>
        </div>
      </div>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
    </div>
  );
}
