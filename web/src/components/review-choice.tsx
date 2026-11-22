import { useEffect, useState } from "react";
import { ApiError, getAgentModels, getAgentsAndCap, type ModelList, type ReviewerChoice } from "../api/client.ts";
import { agentName } from "./evidence.tsx";

/** The model part of a select value for an agent with its own default model, when it lists none. It holds a character no model name may. */
const DEFAULT = "?default";

/** A select value: the agent and the model, apart by a space, which no agent name or model name holds. */
const valueOf = (agent: string, model: string): string => `${agent} ${model}`;

/** The reviewers that can review now, as their own probes say, with the models each offers; and, for the others, why not. */
type Offer = { state: "checking" } | { state: "offered"; reviewers: { agent: string; models: ModelList }[]; notOffered: string[]; rounds: number } | { state: "not-offered"; why: string };

/**
 * New run's one choice of reviewer: Off, the default, or one of the agents that review (Codex, Grok, Antigravity) with
 * one of its models. An agent is offered only when it reports itself installed, supported and signed in now; otherwise
 * the screen says why, in its own words.
 */
export function useReviewChoice(onSignedOut: () => void): { offer: Offer; value: string; setValue: (value: string) => void; choice: () => ReviewerChoice | null } {
  const [offer, setOffer] = useState<Offer>({ state: "checking" });
  const [value, setValue] = useState("");
  useEffect(() => {
    let live = true;
    const failed = (err: unknown): void => {
      if (!live) return;
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setOffer({ state: "not-offered", why: "Review is not offered: Botbench could not check the agents that review just now." });
    };
    getAgentsAndCap().then(({ agents, maxRefineRounds }) => {
      if (!live) return;
      const reviewers = agents.filter((agent) => agent.roles.includes("reviewer"));
      if (reviewers.length === 0) return setOffer({ state: "not-offered", why: "Review is not offered by this Botbench." });
      const usable = reviewers.filter((agent) => agent.problem === null);
      const notOffered = reviewers.filter((agent) => agent.problem !== null).map((agent) => `Review by ${agentName(agent.agent)} is not offered: ${agent.problem}`);
      if (usable.length === 0) return setOffer({ state: "not-offered", why: notOffered.join(" ") });
      return Promise.all(usable.map((agent) => getAgentModels(agent.agent).then((models) => ({ agent: agent.agent, models })))).then((offered) => live && setOffer({ state: "offered", reviewers: offered, notOffered, rounds: maxRefineRounds }), failed);
    }, failed);
    return () => {
      live = false;
    };
  }, [onSignedOut]);
  const choice = (): ReviewerChoice | null => {
    if (offer.state !== "offered" || value === "") return null;
    const at = value.indexOf(" ");
    const model = value.slice(at + 1);
    return { agent: value.slice(0, at), model: model === DEFAULT ? null : model };
  };
  return { offer, value, setValue, choice };
}

export function ReviewChoice({ state }: { state: ReturnType<typeof useReviewChoice> }) {
  const { offer } = state;
  if (offer.state === "checking") return null;
  if (offer.state === "not-offered") return <p data-testid="review-not-offered">{offer.why}</p>;
  return (
    <div className="ds-field">
      <label htmlFor="run-review" className="ds-field__label">
        Review
      </label>
      <div className="ds-select">
        <select id="run-review" name="review" value={state.value} onChange={(e) => state.setValue(e.currentTarget.value)} aria-describedby="run-review-about" className="ds-field__control ds-select__control">
          <option value="">Off</option>
          {offer.reviewers.flatMap(({ agent, models }) =>
            models.models.length === 0
              ? [<option key={agent} value={valueOf(agent, DEFAULT)}>{`${agentName(agent)}, its default model`}</option>]
              : models.models.map((model) => (
                  <option key={`${agent} ${model.id}`} value={valueOf(agent, model.id)}>
                    {`${agentName(agent)}, ${model.label ?? model.id}`}
                  </option>
                )),
          )}
        </select>
      </div>
      <p id="run-review-about" className="ds-field__description">
        <span data-testid="review-rounds-cap">{offer.rounds === 0 ? "No rounds of fixes." : `Up to ${offer.rounds} ${offer.rounds === 1 ? "round" : "rounds"} of fixes.`}</span>{" "}
        Off by default. With a reviewer, each task Claude Code builds is read by it after its checks, where it can change nothing and reach no network: Codex in the task's copy, Grok and Antigravity from the changes Botbench sends them, with no tools. When it has concerns, Claude Code is given its review to fix what it agrees with and say why for the rest, the checks run again, and the same reviewer looks again. Its reviews are a model's opinion, shown on the task before you decide.
        {offer.notOffered.length > 0 ? ` ${offer.notOffered.join(" ")}` : ""}
      </p>
    </div>
  );
}
