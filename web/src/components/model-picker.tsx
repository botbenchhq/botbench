import { useCallback, useEffect, useState } from "react";
import { ApiError, getModels, timedOut, type ModelList, type StoredEvent } from "../api/client.ts";

/** The owner's choice of model, kept per browser so it is not picked again for every prompt. */
const MODEL_KEY = "smelt.model";
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

function loadChoice(): Choice | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(MODEL_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const { model, other } = parsed as Record<string, unknown>;
    return (model === null || typeof model === "string") && typeof other === "boolean" ? { model, other } : null;
  } catch {
    return null;
  }
}

function saveChoice(choice: Choice): void {
  try {
    window.localStorage.setItem(MODEL_KEY, JSON.stringify(choice));
  } catch {
    // Private browsing may refuse storage; the choice then lasts until a reload.
  }
}

/** What a request should carry: a name, null for the CLI's own default, or nothing when the configured model applies. */
export type ModelRequest = { ok: true; model: string | null | undefined } | { ok: false; why: string };

export interface ModelChoiceState {
  list: ModelList | null;
  problem: string | null;
  /** The choice in effect: the owner's, else the configured one once the list is known. */
  choice: Choice | null;
  choose(choice: Choice): void;
  request(): ModelRequest;
}

/** Read the driver's model list once, and hold the owner's choice. */
export function useModelChoice(onSignedOut: () => void): ModelChoiceState {
  const [list, setList] = useState<ModelList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stored, setStored] = useState<Choice | null>(loadChoice);

  useEffect(() => {
    let stale = false;
    getModels().then(
      (models) => !stale && setList(models),
      (err: unknown) => {
        if (stale) return;
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? err.message : timedOut(err) ? "Smelt did not answer in time." : "Smelt could not be reached.");
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

  const choose = useCallback((next: Choice): void => {
    setStored(next);
    saveChoice(next);
  }, []);

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
  if (state.problem !== null) return `The model list could not be read: ${state.problem} Claude Code's default or a name you type can still be chosen.${state.choice === null ? " Until you choose, the model set in Smelt's configuration is used." : ""}`;
  if (state.list === null) return "Reading the models from Claude Code.";
  if (state.list.source === "cli") return "The list is what Claude Code reports on this Mac.";
  return state.list.models.length > 0
    ? "The list comes from Smelt's configuration: Claude Code reported none."
    : "Claude Code reported no list and none is configured. Use Claude Code's default, or name a model.";
}

/** A labelled select of the driver's models, the CLI's own default, and "Other…" with a field for any other name. */
export function ModelPicker({ state }: { state: ModelChoiceState }) {
  const { list, problem, choice } = state;
  const ready = list !== null || problem !== null;
  const value = choice === null ? CONFIGURED : choice.other ? OTHER : (choice.model ?? "");
  const cliDefault = list?.cliDefault ?? null;
  return (
    <div className="gw-stack gw-gap-sm">
      <div className="gw-field">
        <label htmlFor="model" className="gw-field__label">
          Model
        </label>
        <div className="gw-select">
          <select
            id="model"
            name="model"
            value={ready ? value : ""}
            disabled={!ready}
            onChange={(e) => {
              if (e.target.value === CONFIGURED) return;
              state.choose(e.target.value === OTHER ? { model: "", other: true } : { model: e.target.value === "" ? null : e.target.value, other: false });
            }}
            aria-describedby="model-source"
            className="gw-field__control gw-select__control"
          >
            {ready ? (
              <>
                {choice === null && <option value={CONFIGURED}>Model from Smelt's configuration</option>}
                <option value="">{cliDefault === null ? "Claude Code's default" : `Claude Code's default (${cliDefault})`}</option>
                {(list?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label === undefined || model.label === model.id ? model.id : `${model.label} · ${model.id}`}
                  </option>
                ))}
                <option value={OTHER}>Other…</option>
              </>
            ) : (
              <option value="">Reading the models.</option>
            )}
          </select>
        </div>
        <p id="model-source" data-testid="model-source" role="status" className="gw-field__description">
          {choice?.other === true && ready ? `${sourceWords(state)} Claude Code itself decides whether a name you type is a model.` : sourceWords(state)}
        </p>
      </div>
      {ready && choice?.other === true && (
        <div className="gw-field">
          <label htmlFor="model-other" className="gw-field__label">
            Model name
          </label>
          <input
            id="model-other"
            name="model-other"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={choice.model ?? ""}
            onChange={(e) => state.choose({ model: e.target.value, other: true })}
            aria-describedby="model-source"
            className="gw-field__control"
          />
        </div>
      )}
    </div>
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
