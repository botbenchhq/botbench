import { useState } from "react";
import { ApiError, changeRunMode, type RunDetail, type RunMode } from "../api/client.ts";
import { MODE_NAMES, STRICTER_HINT } from "../app/run-words.ts";
import { Alert } from "./header.tsx";
import { MODES } from "./mode-choice.tsx";
import { Option } from "./option.tsx";

/**
 * The run screen's choice of a stricter mode: the run's mode, labelled as the current one, and only the modes stricter
 * than it, as the server offers them (`modeChoices`). Nothing for a manual or a finished run, which has none. Nothing
 * changes until the owner presses the button; the server checks the change again.
 */
export function StricterMode({ run, onChanged, onSignedOut }: { run: Pick<RunDetail, "id" | "mode" | "modeChoices">; onChanged: (next: RunDetail) => void; onSignedOut: () => void }) {
  const [picked, setPicked] = useState<RunMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (run.modeChoices.length === 0) return null;
  // From the run's mode to the strictest, as MODES lists them from the strictest.
  const shown = [...MODES].reverse().filter((option) => option.mode === run.mode || run.modeChoices.includes(option.mode));
  const choice = picked !== null && run.modeChoices.includes(picked) ? picked : null;

  const change = (): void => {
    if (choice === null || busy) return;
    setBusy(true);
    setProblem(null);
    changeRunMode(run.id, choice).then(
      (next) => {
        setBusy(false);
        setPicked(null);
        onChanged(next);
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The mode was not changed. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
      },
    );
  };

  return (
    <section aria-labelledby="mode-change-heading" data-testid="mode-change" className="ds-stack ds-gap-sm">
      <h2 id="mode-change-heading">Make the mode stricter</h2>
      <fieldset className="ds-option-picker" aria-describedby="mode-change-hint">
        <legend className="ds-option-picker__legend ds-visually-hidden">Mode</legend>
        <p id="mode-change-hint" className="ds-option-picker__hint">
          {STRICTER_HINT}
        </p>
        {shown.map((option) => {
          const current = option.mode === run.mode;
          return (
            <Option
              key={option.mode}
              group="mode-change"
              id={`mode-change-${option.mode}`}
              value={option.mode}
              checked={current ? choice === null : choice === option.mode}
              disabled={busy}
              onChange={() => setPicked(current ? null : option.mode)}
              name={option.name}
              description={option.description}
              state={current ? "Current mode" : null}
            />
          );
        })}
      </fieldset>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      <div className="ds-cluster">
        <button type="button" aria-busy={busy} disabled={choice === null || busy} onClick={change} className="ds-button">
          {busy ? "Changing the mode" : choice === null ? "Change mode" : `Change to ${MODE_NAMES[choice]}`}
        </button>
      </div>
    </section>
  );
}
