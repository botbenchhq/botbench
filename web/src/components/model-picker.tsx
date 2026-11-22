import { useCallback, useEffect, useState } from "react";
import { Option } from "./option.tsx";
import { ApiError, getModels as askModels, timedOut, type ModelList, type StoredEvent } from "../api/client.ts";

/** One request for the model list at a time, shared by every picker on the screen; a failed one is asked again next time. */
let asking: Promise<ModelList> | null = null;
function getModels(): Promise<ModelList> {
  asking ??= askModels().finally(() => {
    asking = null;
  });
  return asking;
}

/** The owner's choice of model, kept per browser so it is not picked again for every prompt. */
const MODEL_KEY = "botbench.model";
/** The same entry under the product's old name (Smelt), read for one release while the new one has never been written. */
const OLD_MODEL_KEY = "smelt.model";
/** The select's value for "another name". It holds a character no model name may, so it can never be one. */
const OTHER = "?other";
/** The select's value while the owner has not chosen and the configured model is not known: the server applies it. */
const CONFIGURED = "?configured";
/** The server's own rule for a model name, repeated here only so a slip is caught before a request is made. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;
const NAME_RULE = "A model name starts with a letter or a digit, continues with letters, digits and . _ : / @ [ ] -, and is at most 100 characters long.";

/** `model` null is the CLI's own default. `other` means the owner typed the name instead of picking it. */
interface Choice {
  model: string | null;
  other: boolean;
}

function loadChoice(key: string): Choice | null {
  try {
    const parsed: unknown = JSON.parse((window.localStorage.getItem(key) ?? (key === MODEL_KEY ? window.localStorage.getItem(OLD_MODEL_KEY) : null)) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const { model, other } = parsed as Record<string, unknown>;
    return (model === null || typeof model === "string") && typeof other === "boolean" ? { model, other } : null;
  } catch {
    return null;
  }
}

function saveChoice(key: string, choice: Choice): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(choice));
  } catch {
    // Private browsing may refuse storage; the choice then lasts until a reload.
  }
}

export type { ModelRequest } from "../app/composer.ts";
import type { ModelRequest } from "../app/composer.ts";

export interface ModelChoiceState {
  list: ModelList | null;
  problem: string | null;
  /** The choice in effect: the owner's, else the configured one once the list is known. */
  choice: Choice | null;
  choose(choice: Choice): void;
  request(): ModelRequest;
}

/** Read the driver's model list once, and hold the owner's choice, kept under `key` (another key for another choice, such as a run's build model). */
export function useModelChoice(onSignedOut: () => void, key: string = MODEL_KEY): ModelChoiceState {
  const [list, setList] = useState<ModelList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stored, setStored] = useState<Choice | null>(() => loadChoice(key));

  useEffect(() => {
    let stale = false;
    getModels().then(
      (models) => !stale && setList(models),
      (err: unknown) => {
        if (stale) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? err.message : timedOut(err) ? "Botbench did not answer in time." : "Botbench could not be reached.");
      },
    );
    return () => {
      stale = true;
    };
  }, [onSignedOut]);

  const listed = (id: string): boolean => list !== null && list.models.some((m) => m.id === id);
  const settled = list !== null || problem !== null;
  // Until the owner chooses, the configured model is the choice. A name the list does not hold (or any name,
  // when there is no list) is shown as typed, so the select never displays one thing while another is sent.
  const base: Choice | null = stored ?? (list === null ? null : { model: list.default, other: false });
  const choice: Choice | null = base !== null && base.model !== null && !base.other && settled && !listed(base.model) ? { model: base.model, other: true } : base;

  const choose = useCallback(
    (next: Choice): void => {
      setStored(next);
      saveChoice(key, next);
    },
    [key],
  );

  const request = (): ModelRequest => {
    // Nothing chosen and the list not read yet: the server's configured model applies, which is what would be preselected.
    if (choice === null) return { ok: true, model: undefined };
    if (!choice.other) return { ok: true, model: choice.model };
    const name = (choice.model ?? "").trim();
    if (name === "") return { ok: false, why: "Enter a model name, or pick one from the list." };
    return MODEL_NAME.test(name) ? { ok: true, model: name } : { ok: false, why: NAME_RULE };
  };

  return { list, problem, choice, choose, request };
}

function sourceWords(state: ModelChoiceState): string {
  if (state.problem !== null) return `The model list could not be read: ${state.problem} Claude Code's default or a name you type can still be chosen.${state.choice === null ? " Until you choose, the model set in Botbench's configuration is used." : ""}`;
  if (state.list === null) return "Reading the models from Claude Code.";
  if (state.list.source === "cli") return "The list is what Claude Code reports on this Mac.";
  return state.list.models.length > 0
    ? "The list comes from Botbench's configuration: Claude Code reported none."
    : "Claude Code reported no list and none is configured. Use Claude Code's default, or name a model.";
}

/** The model the next prompt goes to, in a few words, for a control that opens the picker. */
export function choiceName(state: ModelChoiceState): string {
  const { list, problem, choice } = state;
  if (list === null && problem === null) return "Reading the models";
  if (choice === null) return "The configured model";
  if (choice.other) return choice.model?.trim() || "Other…";
  return choice.model === null ? "Claude Code's default" : modelName(list, choice.model);
}

/**
 * The driver's models as one choice (the design system's option picker): the CLI's own default, each model it lists,
 * and last Other…, which reveals a field for any other name. `legend` is hidden when the view's title says the same.
 */
export function ModelOptions({ state, id = "model", legend = "Model", hideLegend = false }: { state: ModelChoiceState; id?: string; legend?: string; hideLegend?: boolean }) {
  const { list, problem, choice } = state;
  const ready = list !== null || problem !== null;
  const value = choice === null ? CONFIGURED : choice.other ? OTHER : (choice.model ?? "");
  const cliDefault = list?.cliDefault ?? null;
  const pick = (next: string): void => state.choose(next === OTHER ? { model: "", other: true } : { model: next === "" ? null : next, other: false });
  return (
    <fieldset className="ds-option-picker" aria-describedby={`${id}-source`} data-testid={`${id}-options`}>
      <legend className={hideLegend ? "ds-option-picker__legend ds-visually-hidden" : "ds-option-picker__legend"}>{legend}</legend>
      <p id={`${id}-source`} data-testid={`${id}-source`} role="status" className="ds-option-picker__hint">
        {choice?.other === true && ready ? `${sourceWords(state)} Claude Code itself decides whether a name you type is a model.` : sourceWords(state)}
      </p>
      {ready && (
        <>
          {choice === null && <Option group={id} id={`${id}-configured`} value={CONFIGURED} checked onChange={() => {}} name="Model from Botbench's configuration" />}
          <Option group={id} id={`${id}-default`} value="" checked={value === ""} onChange={() => pick("")} name="Claude Code's default" description={cliDefault} />
          {(list?.models ?? []).map((model, at) => (
            <Option key={model.id} group={id} id={`${id}-${at}`} value={model.id} checked={value === model.id} onChange={() => pick(model.id)} name={model.label ?? model.id} description={model.label === undefined || model.label === model.id ? null : model.id} />
          ))}
          <Option group={id} id={`${id}-other`} value={OTHER} checked={value === OTHER} onChange={() => pick(OTHER)} name="Other…" />
          <div className="ds-option-picker__reveal">
            <div className="ds-field">
              <label htmlFor={`${id}-name`} className="ds-field__label">
                {id === "model" ? "Model name" : `${legend} name`}
              </label>
              <input
                id={`${id}-name`}
                name={`${id}-name`}
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={choice?.other === true ? (choice.model ?? "") : ""}
                onChange={(e) => state.choose({ model: e.target.value, other: true })}
                aria-describedby={`${id}-source`}
                className="ds-field__control"
              />
            </div>
          </div>
        </>
      )}
    </fieldset>
  );
}

/**
 * The model of a transcript's newest session, as the driver's own session event names it, and whether a turn of that
 * session's attempt has completed. The CLI names the model when a session starts, before anything has answered.
 */
export function sessionModel(events: readonly StoredEvent[]): { model: string; answered: boolean } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const { attemptId, payload } = events[i]!;
    if (payload.type !== "session_started" || typeof payload.model !== "string") continue;
    const answered = events.some((e) => e.attemptId === attemptId && e.payload.type === "turn_ended" && e.payload.reason === "completed");
    return { model: payload.model, answered };
  }
  return null;
}

/** The name Claude Code itself gives a model: its label for that id, or for the alias the id is the full name of. The id itself when it gives none. */
export function modelName(list: ModelList | null, id: string): string {
  return list?.models.find((model) => model.id === id || model.resolved === id)?.label ?? id;
}

/** The names Claude Code gives its models, for a screen that shows a model and does not choose one. Until the list is read, and when it cannot be, a model is shown by its id. */
export function useModelNames(onSignedOut: () => void): (id: string) => string {
  const [list, setList] = useState<ModelList | null>(null);
  useEffect(() => {
    let stale = false;
    getModels().then(
      (models) => !stale && setList(models),
      (err: unknown) => {
        if (!stale && err instanceof ApiError && err.status === 401) onSignedOut();
      },
    );
    return () => {
      stale = true;
    };
  }, [onSignedOut]);
  return useCallback((id: string) => modelName(list, id), [list]);
}

/** The session's model in words that claim an answer only when a reply completed. */
export const modelState = (session: { model: string; answered: boolean } | null, name: (id: string) => string): string =>
  session === null ? "not started yet" : session.answered ? name(session.model) : `${name(session.model)} (no reply yet)`;
/** The same, as a line that stands alone. */
export const modelWords = (session: { model: string; answered: boolean } | null, name: (id: string) => string): string => `Model: ${modelState(session, name)}`;
