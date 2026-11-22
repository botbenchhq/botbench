import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getAgentModels, getAgents, timedOut, type ChatTarget, type ModelList } from "../api/client.ts";
import { agentName, CLAUDE, chatOffer, readChatAgents, type AgentPick, type ChatAgents, type Offered } from "../app/chat.ts";
import { choiceName, ModelOptions, type ModelChoiceState } from "./model-picker.tsx";
import { Option } from "./option.tsx";

/** What the device remembers of who a chat asks. */
const KEY = "botbench.chatAgents";

function load(): ChatAgents {
  try {
    return readChatAgents(window.localStorage.getItem(KEY));
  } catch {
    return readChatAgents(null);
  }
}

/** The agents a chat can ask, as their own checks say now, and each one's models; or why they could not be checked. */
export type AgentOffer = { state: "checking" } | { state: "ready"; agents: Offered[]; models: Record<string, ModelList> } | { state: "failed"; why: string };

export interface ChatAgentsState {
  offer: AgentOffer;
  choice: ChatAgents;
  pick(pick: AgentPick): void;
  setModel(agent: string, model: string | null): void;
}

/**
 * Who a chat asks: one agent, or several at once, kept on the device. `wanted` false leaves the agents unchecked (each
 * check runs that agent's own program, which takes seconds) until the choice is opened, or another agent than Claude Code is remembered.
 */
export function useChatAgents(onSignedOut: () => void, wanted: boolean): ChatAgentsState {
  const [choice, setChoice] = useState<ChatAgents>(load);
  const [offer, setOffer] = useState<AgentOffer>({ state: "checking" });
  const needed = wanted || !(choice.pick.kind === "one" && choice.pick.agent === CLAUDE);
  // Asked once per screen: the answer stays for as long as the screen does.
  const asked = useRef(false);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  useEffect(() => {
    if (!needed || asked.current) return;
    asked.current = true;
    const failed = (err: unknown): void => {
      if (!live.current) return;
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setOffer({ state: "failed", why: err instanceof ApiError ? err.message : timedOut(err) ? "Botbench did not answer in time." : "Botbench could not be reached." });
    };
    getAgents().then((agents) => {
      const offered = chatOffer(agents);
      // Claude Code's models have their own list and picker; each other usable agent's are asked of its program.
      const others = offered.filter((a) => a.agent !== CLAUDE && a.problem === null);
      return Promise.all(others.map((a) => getAgentModels(a.agent).then((list) => [a.agent, list] as const))).then((lists) => live.current && setOffer({ state: "ready", agents: offered, models: Object.fromEntries(lists) }));
    }, failed).catch(failed);
  }, [needed, onSignedOut]);

  const save = useCallback((next: ChatAgents): void => {
    setChoice(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Private browsing may refuse storage; the choice then lasts until a reload.
    }
  }, []);
  return {
    offer,
    choice,
    pick: (pick) => save({ ...choice, pick }),
    setModel: (agent, model) => save({ ...choice, models: { ...choice.models, [agent]: model } }),
  };
}

/** The model an agent other than Claude Code is asked with, in a few words. */
export function otherModelName(state: ChatAgentsState, agent: string): string {
  const model = state.choice.models[agent] ?? null;
  if (model === null) return `${agentName(agent)}'s default`;
  const list = state.offer.state === "ready" ? state.offer.models[agent] : undefined;
  return list?.models.find((m) => m.id === model)?.label ?? model;
}

/** Who the next message goes to, for the composer's chip: the model, then the agent as its qualifier. */
export function chatChip(state: ChatAgentsState, claude: ModelChoiceState): { value: string; qualifier: string } {
  const { pick } = state.choice;
  if (pick.kind === "several") return { value: "Ask several", qualifier: `${pick.agents.length} agents` };
  return pick.agent === CLAUDE ? { value: choiceName(claude), qualifier: "Claude Code" } : { value: otherModelName(state, pick.agent), qualifier: agentName(pick.agent) };
}

/** The value "Ask several" has in the agent choice: it holds a character no agent name does. */
const SEVERAL = "?several";

/**
 * The Model view of a chat: the agent as one choice (Claude Code, Codex, Grok, Antigravity, each with its state, or Ask
 * several with a tick for each usable agent), then the chosen agent's models.
 */
export function AgentOptions({ state, claude }: { state: ChatAgentsState; claude: ModelChoiceState }) {
  const { offer, choice } = state;
  const value = choice.pick.kind === "several" ? SEVERAL : choice.pick.agent;
  const ticked = choice.pick.kind === "several" ? choice.pick.agents : [];
  const agents = offer.state === "ready" ? offer.agents : [];
  const usable = agents.filter((a) => a.problem === null);
  const one = choice.pick.kind === "one" ? choice.pick.agent : null;
  return (
    <div className="ds-stack ds-gap-lg">
      <fieldset className="ds-option-picker" aria-describedby="agent-hint" data-testid="agent-options">
        <legend className="ds-option-picker__legend">Agent</legend>
        <p id="agent-hint" data-testid="agent-hint" className="ds-option-picker__hint">
          Codex, Grok and Antigravity answer from the conversation alone: they cannot read your files or change anything here. Botbench gives each the chat so far.
        </p>
        {offer.state === "checking" && (
          <p role="status" className="ds-spinner">
            Checking the agents.
          </p>
        )}
        {offer.state === "failed" && (
          <p role="status" className="ds-option-picker__hint">
            {`The agents could not be checked: ${offer.why} Claude Code can still be asked.`}
          </p>
        )}
        {(offer.state === "ready" ? agents : [{ agent: CLAUDE, name: "Claude Code", problem: null }]).map((a) => (
          <Option
            key={a.agent}
            group="agent"
            id={`agent-${a.agent}`}
            value={a.agent}
            checked={value === a.agent}
            disabled={a.problem !== null}
            onChange={() => state.pick({ kind: "one", agent: a.agent })}
            name={a.name}
            description={a.problem ?? (a.agent === CLAUDE ? choiceName(claude) : otherModelName(state, a.agent))}
            state={a.problem === null ? null : "Not available"}
          />
        ))}
        {usable.length >= 2 && (
          <>
            <Option group="agent" id="agent-several" value={SEVERAL} checked={value === SEVERAL} onChange={() => state.pick({ kind: "several", agents: ticked.length > 0 ? ticked : usable.map((a) => a.agent) })} name="Ask several" description="The same message to each agent you tick, at the same time." />
            <div className="ds-option-picker__reveal">
              <fieldset className="ds-checkbox__group" aria-describedby="several-about">
                <legend className="ds-checkbox__legend">Agents to ask</legend>
                <p id="several-about" data-testid="several-about" className="ds-option-picker__hint">
                  Your message and the chat so far, with what each agent wrote, go to every agent you tick.
                </p>
                {usable.map((a) => (
                  <div key={a.agent} className="ds-checkbox">
                    <input
                      className="ds-checkbox__input"
                      type="checkbox"
                      id={`several-${a.agent}`}
                      checked={ticked.includes(a.agent)}
                      onChange={(e) => state.pick({ kind: "several", agents: e.target.checked ? [...ticked, a.agent] : ticked.filter((x) => x !== a.agent) })}
                    />
                    <label className="ds-checkbox__label" htmlFor={`several-${a.agent}`}>
                      {`${a.name}, ${a.agent === CLAUDE ? choiceName(claude) : otherModelName(state, a.agent)}`}
                    </label>
                  </div>
                ))}
              </fieldset>
            </div>
          </>
        )}
      </fieldset>
      {one === CLAUDE && <ModelOptions state={claude} legend="Model" />}
      {one !== null && one !== CLAUDE && offer.state === "ready" && offer.models[one] !== undefined && <OtherModels state={state} agent={one} list={offer.models[one]} />}
    </div>
  );
}

/** An agent's own default and each model it lists. */
function OtherModels({ state, agent, list }: { state: ChatAgentsState; agent: string; list: ModelList }) {
  const chosen = state.choice.models[agent] ?? null;
  const id = `model-${agent}`;
  return (
    <fieldset className="ds-option-picker" data-testid={`${id}-options`}>
      <legend className="ds-option-picker__legend">Model</legend>
      <Option group={id} id={`${id}-default`} value="" checked={chosen === null} onChange={() => state.setModel(agent, null)} name={`${agentName(agent)}'s default`} description={list.cliDefault} />
      {list.models.map((model, at) => (
        <Option key={model.id} group={id} id={`${id}-${at}`} value={model.id} checked={chosen === model.id} onChange={() => state.setModel(agent, model.id)} name={model.label ?? model.id} description={model.label === undefined || model.label === model.id ? null : model.id} />
      ))}
    </fieldset>
  );
}

/** In a repository, the builder is Claude Code: the one line that says why the others are not offered. */
export const BUILDER_ONLY = "Only Claude Code can work in a repository. Codex, Grok and Antigravity can be asked in a chat with no repository.";

/**
 * Under a round several agents answered: one plain action that asks one agent, chosen here, to compare the answers.
 * Nothing is sent until an agent is pressed.
 */
export function CompareAction({ agents, claude, onCompare, busy }: { agents: ChatAgentsState; claude: ModelChoiceState; onCompare: (to: ChatTarget) => void; busy: boolean }) {
  const offered = agents.offer.state === "ready" ? agents.offer.agents.filter((a) => a.problem === null) : [];
  const request = claude.request();
  return (
    <li data-testid="compare-action">
      <details className="ds-disclosure">
        <summary className="ds-disclosure__summary">Ask one to compare the answers</summary>
        <div className="ds-disclosure__content ds-stack ds-gap-sm">
          <p className="ds-option-picker__hint">It is sent the question and each answer, and asked where they agree, where they differ and which it would act on.</p>
          <div className="ds-cluster ds-gap-xs">
            {offered.map((a) => (
              <button
                key={a.agent}
                type="button"
                className="ds-button ds-button--small"
                disabled={busy || (a.agent === CLAUDE && !request.ok)}
                onClick={() => onCompare(a.agent === CLAUDE ? { agent: a.agent, ...(request.ok && request.model !== undefined ? { model: request.model } : {}) } : { agent: a.agent, model: agents.choice.models[a.agent] ?? null })}
              >
                {`Ask ${a.name}`}
              </button>
            ))}
          </div>
        </div>
      </details>
    </li>
  );
}
