import { Option } from "./option.tsx";
import type { RunMode } from "../api/client.ts";

/** Each mode in the order it is offered, with its name and what it does in one line. */
export const MODES: { mode: RunMode; name: string; description: string; warning?: string }[] = [
  { mode: "manual", name: "Manual", description: "Asks before every command and decision." },
  { mode: "semi", name: "Semi-autonomous", description: "Runs commands on its own. You approve the plan and the result." },
  {
    mode: "full",
    name: "Fully autonomous",
    description: "Plans, builds and accepts on its own when checks pass.",
    warning: "Accepts work without you",
  },
];

/** A run's mode as the run and task screens say it. */
export const MODE_SENTENCE: Record<RunMode, string> = {
  manual: "Manual: you approve the plan, each command that is not allowed in advance, and the result.",
  semi: "Semi-autonomous: commands run without asking, kept away from your sign-ins and the network. You approve the plan and the result.",
  full: "Fully autonomous: Botbench builds without asking you, refuses what would need you, and accepts work whose every check passed and that its reviewer, if any, said looks right. The rest waits for you.",
};

/**
 * The three modes as one choice (the design system's option picker). With `only`, the other modes cannot be chosen
 * and say so: a task started on its own is always manual.
 */
export function ModePicker({ name, legend, hint, value, onChange, hideLegend = false, only }: { name: string; legend: string; hint: string; value: RunMode | null; onChange: (mode: RunMode) => void; hideLegend?: boolean; only?: RunMode }) {
  return (
    <fieldset className="ds-option-picker" aria-describedby={`${name}-hint`} data-testid={`${name}-picker`}>
      <legend className={hideLegend ? "ds-option-picker__legend ds-visually-hidden" : "ds-option-picker__legend"}>{legend}</legend>
      <p className="ds-option-picker__hint" id={`${name}-hint`}>
        {hint}
      </p>
      {MODES.map((option) => {
        const shut = only !== undefined && option.mode !== only;
        const state = shut ? "Runs only" : (option.warning ?? null);
        return (
          <Option
            key={option.mode}
            group={name}
            id={`${name}-${option.mode}`}
            value={option.mode}
            checked={(only ?? value) === option.mode}
            disabled={shut}
            onChange={() => onChange(option.mode)}
            name={option.name}
            description={option.description}
            state={state}
            warning={!shut && option.warning !== undefined}
          />
        );
      })}
    </fieldset>
  );
}
