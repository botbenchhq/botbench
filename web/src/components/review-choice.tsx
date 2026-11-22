import { useEffect, useState } from "react";
import { ApiError, getAgentModels, getAgents, type ModelList, type ReviewerChoice } from "../api/client.ts";

/** The select's value for Codex with its own default model, when it lists none. It holds a character no model name may. */
const DEFAULT = "?default";

/** Whether Codex can review now, as its own probe says, and the models it offers; or why it cannot. */
type Offer = { state: "checking" } | { state: "offered"; models: ModelList } | { state: "not-offered"; why: string };

/**
 * New run's one choice of reviewer: Off, the default, or Codex with one of its models. Codex is offered only when it
 * reports itself installed, supported and signed in now; otherwise the screen says why, in its own words.
 */
export function useReviewChoice(onSignedOut: () => void): { offer: Offer; value: string; setValue: (value: string) => void; choice: () => ReviewerChoice | null } {
  const [offer, setOffer] = useState<Offer>({ state: "checking" });
  const [value, setValue] = useState("");
  useEffect(() => {
    let live = true;
    const failed = (err: unknown): void => {
      if (!live) return;
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setOffer({ state: "not-offered", why: "Review by Codex is not offered: Botbench could not check Codex just now." });
    };
    getAgents().then((agents) => {
      const codex = agents.find((agent) => agent.agent === "codex" && agent.roles.includes("reviewer"));
      if (!live) return;
      if (codex === undefined) return setOffer({ state: "not-offered", why: "Review by Codex is not offered by this Botbench." });
      if (codex.problem !== null) return setOffer({ state: "not-offered", why: `Review by Codex is not offered: ${codex.problem}` });
      return getAgentModels("codex").then((models) => live && setOffer({ state: "offered", models }), failed);
    }, failed);
    return () => {
      live = false;
    };
  }, [onSignedOut]);
  const choice = (): ReviewerChoice | null => (offer.state !== "offered" || value === "" ? null : { agent: "codex", model: value === DEFAULT ? null : value });
  return { offer, value, setValue, choice };
}

export function ReviewChoice({ state }: { state: ReturnType<typeof useReviewChoice> }) {
  const { offer } = state;
  if (offer.state === "checking") return null;
  if (offer.state === "not-offered") return <p data-testid="review-not-offered">{offer.why}</p>;
  const models = offer.models.models;
  return (
    <div className="ds-field">
      <label htmlFor="run-review" className="ds-field__label">
        Review
      </label>
      <div className="ds-select">
        <select id="run-review" name="review" value={state.value} onChange={(e) => state.setValue(e.currentTarget.value)} aria-describedby="run-review-about" className="ds-field__control ds-select__control">
          <option value="">Off</option>
          {models.length === 0 ? (
            <option value={DEFAULT}>Codex, its default model</option>
          ) : (
            models.map((model) => (
              <option key={model.id} value={model.id}>
                {`Codex, ${model.label ?? model.id}`}
              </option>
            ))
          )}
        </select>
      </div>
      <p id="run-review-about" className="ds-field__description">
        Off by default. With Codex, each task Claude Code builds is read by Codex after its checks, in the task's copy, where Codex can change nothing and reach no network. Its review is a model's opinion, shown on the task before you decide.
      </p>
    </div>
  );
}
