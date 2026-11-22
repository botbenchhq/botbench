import { useEffect, useState } from "react";
import { ApiError, getAgentModels, getAgentsAndCap, type ModelList, type ReviewerChoice } from "../api/client.ts";
import { agentName } from "./evidence.tsx";
import { Option } from "./option.tsx";

/** The model part of a select value for an agent with its own default model, when it lists none. It holds a character no model name may. */
const DEFAULT = "?default";

/** A select value: the agent and the model, apart by a space, which no agent name or model name holds. */
const valueOf = (agent: string, model: string): string => `${agent} ${model}`;

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

/** Every reviewer and model offered now, as select values with their words. */
function offered(offer: Offer): { value: string; agent: string; model: string }[] {
  if (offer.state !== "offered") return [];
  return offer.reviewers.flatMap(({ agent, models }) =>
    models.models.length === 0 ? [{ value: valueOf(agent, DEFAULT), agent: agentName(agent), model: "its default model" }] : models.models.map((model) => ({ value: valueOf(agent, model.id), agent: agentName(agent), model: model.label ?? model.id })),
  );
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
  const chosen = options.find((option) => option.value === value) ?? null;
  const choice = (): ReviewerChoice | null => {
    if (chosen === null) return null;
    const at = value.indexOf(" ");
    const model = value.slice(at + 1);
    return { agent: value.slice(0, at), model: model === DEFAULT ? null : model };
  };
  return { offer, value, setValue, choice, words: chosen === null ? "Off" : `${chosen.agent}, ${chosen.model}` };
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
  const current = options.some((option) => option.value === state.value) ? state.value : "";
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
      {options.map((option, at) => (
        <Option key={option.value} group="review" id={`review-${at}`} value={option.value} checked={current === option.value} onChange={() => state.setValue(option.value)} name={option.agent} description={option.model} />
      ))}
      {offer.state === "offered" &&
        offer.unavailable.map(({ agent, problem }) => <Option key={agent} group="review" id={`review-${agent}`} value={agent} checked={false} onChange={() => {}} disabled name={agentName(agent)} description={problem} state="Not available" />)}
    </fieldset>
  );
}
