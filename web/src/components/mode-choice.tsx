import { Option } from "./option.tsx";
import type { RunMode } from "../api/client.ts";
import { MODE_NAMES } from "../app/run-words.ts";

/** Each mode in the order it is offered, from the strictest, with its name and what it does in one line. */
export const MODES: { mode: RunMode; name: string; description: string; warning?: string }[] = [
  { mode: "manual", name: MODE_NAMES.manual, description: "You approve the plan and decide on each result." },
  { mode: "semi", name: MODE_NAMES.semi, description: "Builds without waiting for plan approval. You decide on each result." },
  {
    mode: "full",
    name: MODE_NAMES.full,
    description: "Plans, builds and accepts on its own when checks pass.",
    warning: "Accepts work without you",
  },
];

/**
 * The three modes as one choice (the design system's option picker). With `only`, the other modes cannot be chosen
 * and say so: a task started on its own is always manual.
 */
export function ModePicker({ name, legend, hint, value, onChange, hideLegend = false, only, refused }: { name: string; legend: string; hint: string; value: RunMode | null; onChange: (mode: RunMode) => void; hideLegend?: boolean; only?: RunMode; /** A mode that cannot be chosen, and the words its row says instead (the hint says why). */ refused?: { mode: RunMode; state: string } }) {
  return (
    <fieldset className="ds-option-picker" aria-describedby={`${name}-hint`} data-testid={`${name}-picker`}>
      <legend className={hideLegend ? "ds-option-picker__legend ds-visually-hidden" : "ds-option-picker__legend"}>{legend}</legend>
      <p className="ds-option-picker__hint" id={`${name}-hint`}>
        {hint}
      </p>
      {MODES.map((option) => {
        const closed = refused?.mode === option.mode;
        const shut = (only !== undefined && option.mode !== only) || closed;
        const state = closed ? refused.state : shut ? "Runs only" : (option.warning ?? null);
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
