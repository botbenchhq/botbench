import type { RunMode } from "../api/client.ts";

/** Each mode in the order it is offered, with its name and what it does in one line. */
export const MODES: { mode: RunMode; name: string; description: string; warning?: string }[] = [
  { mode: "manual", name: "Manual", description: "You approve the plan, each command that is not allowed in advance, and the result." },
  { mode: "semi", name: "Semi-autonomous", description: "You approve the plan and the result. Commands run without asking, kept away from your sign-ins and the network." },
  {
    mode: "full",
    name: "Fully autonomous",
    description: "Builds without asking you, and refuses what would need you. Work whose every check passed, and that its reviewer, if any, said looks right, is accepted; the rest waits for you.",
    warning: "Accepts work without you",
  },
];

/** A run's mode as the run and task screens say it. */
export const MODE_SENTENCE: Record<RunMode, string> = {
  manual: "Manual: you approve the plan, each command that is not allowed in advance, and the result.",
  semi: "Semi-autonomous: commands run without asking, kept away from your sign-ins and the network. You approve the plan and the result.",
  full: "Fully autonomous: Botbench builds without asking you, refuses what would need you, and accepts work whose every check passed and that its reviewer, if any, said looks right. The rest waits for you.",
};

/** The three modes as one choice (the design system's option picker). */
export function ModePicker({ name, legend, hint, value, onChange }: { name: string; legend: string; hint: string; value: RunMode | null; onChange: (mode: RunMode) => void }) {
  return (
    <fieldset className="ds-option-picker" aria-describedby={`${name}-hint`} data-testid={`${name}-picker`}>
      <legend className="ds-option-picker__legend">{legend}</legend>
      <p className="ds-option-picker__hint" id={`${name}-hint`}>
        {hint}
      </p>
      {MODES.map((option) => (
        <label key={option.mode} className="ds-option-picker__option">
          <input
            className="ds-option-picker__input"
            type="radio"
            name={name}
            value={option.mode}
            checked={value === option.mode}
            onChange={() => onChange(option.mode)}
            aria-labelledby={`${name}-${option.mode}-name`}
            aria-describedby={`${option.warning === undefined ? "" : `${name}-${option.mode}-state `}${name}-${option.mode}-description`}
          />
          <span className="ds-option-picker__body">
            <span className="ds-option-picker__text">
              <span className="ds-option-picker__name" id={`${name}-${option.mode}-name`}>
                {option.name}
              </span>
              <span className="ds-option-picker__description" id={`${name}-${option.mode}-description`}>
                {option.description}
              </span>
            </span>
            {option.warning !== undefined && (
              <span className="ds-option-picker__state ds-option-picker__state--warning" id={`${name}-${option.mode}-state`}>
                {option.warning}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
