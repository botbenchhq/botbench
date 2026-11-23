import { Fragment, useEffect, useState } from "react";
import { ApiError, getAgentModels, getAgentsAndCap, type ModelList, type ReviewerChoice } from "../api/client.ts";
import { REVIEW_DEFAULT, REVIEW_OTHER, reviewRows, type ReviewRow } from "../app/composer.ts";
import { agentName } from "./evidence.tsx";
import { Option } from "./option.tsx";

/** A select value: the agent and the model, apart by a space, which no agent name or model name holds. */
const split = (value: string): { agent: string; model: string } => ({ agent: value.slice(0, value.indexOf(" ")), model: value.slice(value.indexOf(" ") + 1) });

/** The reviewers that can review now, as their own probes say, with the models each offers; and, for the others, why not. */
type Offer = { state: "checking" } | { state: "offered"; reviewers: { agent: string; models: ModelList }[]; unavailable: { agent: string; problem: string }[]; rounds: number } | { state: "not-offered"; why: string; none: boolean };

/**
 * New run's one choice of reviewer: Off, the default, or one of the agents that review (Codex, Grok, Antigravity) with
 * one of its models. An agent is offered only when it reports itself installed, supported and signed in now; otherwise
 * the screen says why, in its own words.
 */
export interface ReviewChoiceState {
  offer: Offer;
  /** The select value as chosen: "" for Off. */
  value: string;
  setValue: (value: string) => void;
  /** The reviewer a run would be started with: null for Off, and for a remembered choice that is not offered now. */
  choice: () => ReviewerChoice | null;
  /** The choice in a few words, for the Review row. */
  words: string;
}

/** Every reviewer option offered now (`reviewRows`), as select values with their words. */
const offered = (offer: Offer): ReviewRow[] => (offer.state === "offered" ? reviewRows(offer.reviewers, agentName) : []);

/** The option a value stands for: its own row, or, for a model of an offered agent that is not a row of its own (one typed, or remembered), that agent's Other…. */
function rowOf(options: readonly ReviewRow[], value: string): ReviewRow | null {
  if (value === "") return null;
  return options.find((option) => option.value === value) ?? options.find((option) => option.other && option.agent === split(value).agent) ?? null;
}

/** `wanted` false leaves the agents unasked (each asks its own program, which takes seconds) until a run is being set up. */
export function useReviewChoice(onSignedOut: () => void, initial = "", wanted = true): ReviewChoiceState {
  const [offer, setOffer] = useState<Offer>({ state: "checking" });
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const failed = (err: unknown): void => {
      if (!live) return;
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setOffer({ state: "not-offered", why: "Review is not offered: Botbench could not check the agents that review just now.", none: false });
    };
    getAgentsAndCap().then(({ agents, maxRefineRounds }) => {
      if (!live) return;
      const reviewers = agents.filter((agent) => agent.roles.includes("reviewer"));
      if (reviewers.length === 0) return setOffer({ state: "not-offered", why: "Review is not offered by this Botbench.", none: true });
      const usable = reviewers.filter((agent) => agent.problem === null);
      const unavailable = reviewers.filter((agent) => agent.problem !== null).map((agent) => ({ agent: agent.agent, problem: agent.problem! }));
      return Promise.all(usable.map((agent) => getAgentModels(agent.agent).then((models) => ({ agent: agent.agent, models })))).then((found) => live && setOffer({ state: "offered", reviewers: found, unavailable, rounds: maxRefineRounds }), failed);
    }, failed);
    return () => {
      live = false;
    };
  }, [onSignedOut, wanted]);
  const options = offered(offer);
  const chosen = rowOf(options, value);
  // Other… with no name typed yet is the agent's own default, and says so.
  const model = chosen === null ? null : split(value).model;
  const typed = model === REVIEW_DEFAULT || model === REVIEW_OTHER ? null : model;
  const choice = (): ReviewerChoice | null => (chosen === null ? null : { agent: chosen.agent, model: typed });
  return { offer, value, setValue, choice, words: chosen === null ? "Off" : `${chosen.name}, ${typed ?? "its default model"}` };
}

/** The rounds of fixes a run started now allows after a review with concerns. */
const roundsWords = (rounds: number): string => (rounds === 0 ? "No rounds of fixes." : `Up to ${rounds} ${rounds === 1 ? "round" : "rounds"} of fixes.`);

/** The reviewer as one choice: Off, each reviewer and model offered now, and the reviewers that cannot review now with why. */
export function ReviewOptions({ state }: { state: ReviewChoiceState }) {
  const { offer } = state;
  if (offer.state === "checking")
    return (
      <p role="status" className="ds-spinner">
        Checking the agents that review.
      </p>
    );
  const options = offered(offer);
  const current = rowOf(options, state.value)?.value ?? "";
  const typed = (agent: string): string => (split(state.value).agent === agent && !options.some((option) => option.value === state.value) ? split(state.value).model : "");
  return (
    <fieldset className="ds-option-picker" aria-describedby="review-hint" data-testid="review-options">
      <legend className="ds-option-picker__legend ds-visually-hidden">Review</legend>
      <p id="review-hint" className="ds-option-picker__hint">
        {offer.state === "offered" ? (
          <>
            <span data-testid="review-rounds-cap">{roundsWords(offer.rounds)}</span> A reviewer reads each task after its checks and can change nothing. Its review is a model's opinion.
          </>
        ) : (
          <span data-testid="review-not-offered">{offer.why}</span>
        )}
      </p>
      <Option group="review" id="review-off" value="" checked={current === ""} onChange={() => state.setValue("")} name="Off" />
      {options.map((option, at) =>
        option.other ? (
          <Fragment key={option.value}>
            <Option group="review" id={`review-${at}`} value={option.value} checked={current === option.value} onChange={() => state.setValue(option.value)} name={option.name} description={option.description} />
            <div className="ds-option-picker__reveal">
              <div className="ds-field">
                <label htmlFor={`review-${at}-name`} className="ds-field__label">{`${option.name} model name`}</label>
                <input id={`review-${at}-name`} type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={typed(option.agent)} onChange={(e) => state.setValue(`${option.agent} ${e.target.value.trim() === "" ? REVIEW_OTHER : e.target.value.trim()}`)} className="ds-field__control" />
              </div>
            </div>
          </Fragment>
        ) : (
          <Option key={option.value} group="review" id={`review-${at}`} value={option.value} checked={current === option.value} onChange={() => state.setValue(option.value)} name={option.name} description={option.description} />
        ),
      )}
      {offer.state === "offered" &&
        offer.unavailable.map(({ agent, problem }) => <Option key={agent} group="review" id={`review-${agent}`} value={agent} checked={false} onChange={() => {}} disabled name={agentName(agent)} description={problem} state="Not available" />)}
    </fieldset>
  );
}
