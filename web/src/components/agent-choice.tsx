import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, getAgentModels, getAgentsAndCap, timedOut, type AgentsAnswer, type ChatTarget, type ModelList } from "../api/client.ts";
import { agentAbout, agentList, agentName, CLAUDE, chatOffer, chipWords, defaultFirst, readChatAgents, readKnownAgents, type AgentPick, type AgentRow, type ChatAgents, type Offered } from "../app/chat.ts";
import { choiceName, idUnder, ModelOptions, ModelRadio, MoreModels, type ModelChoiceState } from "./model-picker.tsx";

/** What the device remembers of who a chat asks. */
const KEY = "botbench.chatAgents";

function load(): ChatAgents {
  try {
    return readChatAgents(window.localStorage.getItem(KEY));
  } catch {
    return readChatAgents(null);
  }
}

/** What the device kept of the agents' last check, so the choice lists them at once. */
const KNOWN_KEY = "botbench.agents";

function loadKnown(): Offered[] | null {
  try {
    return readKnownAgents(window.localStorage.getItem(KNOWN_KEY));
  } catch {
    return null;
  }
}

/**
 * The agents a chat can ask: as their last check found them (`known`, null while nothing is known), whether they are
 * being checked again, why the check failed, and each other agent's models, or why they could not be read.
 */
export interface AgentOffer {
  known: Offered[] | null;
  checking: boolean;
  failed: string | null;
  models: Record<string, ModelList | { problem: string }>;
}

export interface ChatAgentsState {
  offer: AgentOffer;
  choice: ChatAgents;
  pick(pick: AgentPick): void;
  setModel(agent: string, model: string | null): void;
}

const failure = (err: unknown): string => (err instanceof ApiError ? err.message : timedOut(err) ? "Botbench did not answer in time." : "Botbench could not be reached.");

/**
 * Who a chat asks: one agent, or several at once, kept on the device. The agents are asked for once, when the screen
 * opens; Botbench answers from its last check at once, and when that check is being made again, the screen asks once
 * more for the new one. Until then the last check kept on the device stands.
 */
export function useChatAgents(onSignedOut: () => void): ChatAgentsState {
  const [choice, setChoice] = useState<ChatAgents>(load);
  const [offer, setOffer] = useState<AgentOffer>(() => ({ known: loadKnown(), checking: true, failed: null, models: {} }));
  useEffect(() => {
    let live = true;
    const asked = new Set<string>();
    const failed = (err: unknown): void => {
      if (!live) return;
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setOffer((o) => ({ ...o, checking: false, failed: failure(err) }));
    };
    const got = (answer: AgentsAnswer, again: boolean): void => {
      if (!live) return;
      const known = chatOffer(answer.agents);
      try {
        window.localStorage.setItem(KNOWN_KEY, JSON.stringify(known));
      } catch {
        // Private browsing may refuse storage; the agents are then checked again on the next visit.
      }
      setOffer((o) => ({ ...o, known, checking: again, failed: null }));
      // Claude Code's models have their own list and picker; each other usable agent's are asked of its program, once.
      for (const a of known) {
        if (a.agent === CLAUDE || a.problem !== null || asked.has(a.agent)) continue;
        asked.add(a.agent);
        getAgentModels(a.agent).then(
          (list) => live && setOffer((o) => ({ ...o, models: { ...o.models, [a.agent]: list } })),
          (err: unknown) => live && setOffer((o) => ({ ...o, models: { ...o.models, [a.agent]: { problem: failure(err) } } })),
        );
      }
      if (again) getAgentsAndCap(true).then((next) => got(next, false), failed);
    };
    getAgentsAndCap().then((answer) => got(answer, answer.checking), failed);
    return () => {
      live = false;
    };
  }, [onSignedOut]);

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

/** The model list an agent other than Claude Code reported, once it has. */
const listOf = (state: ChatAgentsState, agent: string): ModelList | null => {
  const list = state.offer.models[agent];
  return list === undefined || "problem" in list ? null : list;
};

/** The model an agent other than Claude Code is asked with, in a few words. */
export function otherModelName(state: ChatAgentsState, agent: string): string {
  const model = state.choice.models[agent] ?? null;
  if (model === null) return `${agentName(agent)}'s default`;
  return listOf(state, agent)?.models.find((m) => m.id === model)?.label ?? model;
}

/** Who the next message goes to, for the composer's chip: the model, then the agent as its qualifier. */
export function chatChip(state: ChatAgentsState, claude: ModelChoiceState): { value: string; qualifier: string | null } {
  const { pick } = state.choice;
  if (pick.kind === "several") return { value: "Ask several", qualifier: `${pick.agents.length} agents` };
  return pick.agent === CLAUDE ? chipWords(choiceName(claude), "Claude Code") : chipWords(otherModelName(state, pick.agent), agentName(pick.agent));
}

/** The value "Ask several" has in the agent choice: it holds a character no agent name does. */
const SEVERAL = "?several";

/** In a repository, the builder is Claude Code: the one line under the agents that says why, and what to do. */
export const BUILDER_ONLY = "Only Claude Code can work in a repository. Remove the repository to ask the others.";

/** Why the agents other than Claude Code see only the chat. */
const CHAT_ALONE = "Codex, Grok and Antigravity answer from the conversation alone: they cannot read your files or change anything here. Botbench gives each the chat so far.";

/**
 * The Agent and model view, in two levels shown together: a row of agents at the top that never scrolls away (Claude
 * Code, Codex, Grok, Antigravity, then Ask several), and under it the agent shown, with its version and sign-in state,
 * and its models as a plain list; Ask several shows the agents to tick. Choosing an agent that can answer asks it;
 * choosing one that cannot only shows why, and what to do, where its models would be. With a repository (`repository`
 * set), Claude Code is the agent, the others are Chat only, the view offers to remove the repository, and the models
 * are the caller's (`models`).
 */
export function AgentOptions({ state, claude, repository = null, models = null }: { state: ChatAgentsState; claude: ModelChoiceState; repository?: { remove(): void } | null; models?: ReactNode }) {
  const { offer, choice } = state;
  const list = agentList({ known: offer.known, checking: offer.checking, failed: offer.failed, inRepository: repository !== null });
  const picked = choice.pick.kind === "several" ? SEVERAL : choice.pick.agent;
  // The agent shown under the row: the one asked, or one that cannot answer, chosen to see why.
  const [looked, setLooked] = useState<string>(picked);
  const shown = repository !== null ? CLAUDE : looked;
  const ticked = choice.pick.kind === "several" ? choice.pick.agents : [];
  const rowRef = useRef<HTMLFieldSetElement>(null);
  // Removing the repository keeps this view; the focus goes to the agent chosen, as the button it was on is gone.
  const removed = useRef(false);
  useEffect(() => {
    if (repository !== null || !removed.current) return;
    removed.current = false;
    rowRef.current?.querySelector<HTMLElement>("input:checked")?.focus();
  }, [repository]);
  const choose = (value: string): void => {
    setLooked(value);
    if (value === SEVERAL) return state.pick({ kind: "several", agents: ticked.length > 0 ? ticked : list.several.tickable });
    if (list.rows.find((r) => r.agent === value)?.problem === null) state.pick({ kind: "one", agent: value });
  };
  const row = list.rows.find((r) => r.agent === shown);
  const modelOf = (agent: string): string => (agent === CLAUDE ? choiceName(claude) : otherModelName(state, agent));
  const otherList = row !== undefined && row.agent !== CLAUDE ? offer.models[row.agent] : undefined;
  return (
    <div className="ds-stack ds-gap-md min-h-0 flex-1">
      <fieldset ref={rowRef} className="ds-filter-chips" data-testid="agent-options">
        <legend className="ds-filter-chips__legend ds-visually-hidden">Agent</legend>
        <div className="ds-filter-chips__list">
          {list.rows.map((a) => (
            <label key={a.agent} className="ds-filter-chips__chip">
              <input className="ds-filter-chips__input" type="radio" name="agent" value={a.agent} checked={shown === a.agent} disabled={a.disabled} onChange={() => choose(a.agent)} />
              {a.label}
            </label>
          ))}
          <label className="ds-filter-chips__chip">
            <input className="ds-filter-chips__input" type="radio" name="agent" value={SEVERAL} checked={shown === SEVERAL} disabled={list.several.disabled} onChange={() => choose(SEVERAL)} />
            {list.several.label}
          </label>
        </div>
      </fieldset>
      {list.line !== null && (
        <p role="status" data-testid="agents-line" className={offer.failed === null ? "ds-spinner" : "ds-radio__description"}>
          {list.line}
        </p>
      )}
      {repository !== null && (
        <div className="ds-stack ds-gap-sm">
          <p data-testid="builder-only" className="ds-radio__description">
            {BUILDER_ONLY}
          </p>
          <div>
            <button
              type="button"
              className="ds-button ds-button--small"
              onClick={() => {
                removed.current = true;
                repository.remove();
              }}
            >
              Remove the repository
            </button>
          </div>
        </div>
      )}
      <div data-testid="agent-shown" className="ds-stack ds-gap-lg min-h-0 flex-1 overflow-y-auto">
        {shown === SEVERAL ? (
          <fieldset className="ds-checkbox__group" aria-describedby="several-about">
            <legend className="ds-checkbox__legend">Agents to ask</legend>
            <p id="several-about" data-testid="several-about" className="ds-radio__description">
              Your message and the chat so far, with what each agent wrote, go to every agent you tick.
            </p>
            {list.several.tickable.map((agent) => (
              <div key={agent} className="ds-checkbox">
                <input className="ds-checkbox__input" type="checkbox" id={`several-${agent}`} checked={ticked.includes(agent)} onChange={(e) => state.pick({ kind: "several", agents: e.target.checked ? [...ticked, agent] : ticked.filter((x) => x !== agent) })} />
                <label className="ds-checkbox__label" htmlFor={`several-${agent}`}>
                  {`${agentName(agent)}, ${modelOf(agent)}`}
                </label>
              </div>
            ))}
          </fieldset>
        ) : row === undefined ? null : row.problem !== null ? (
          <div className="ds-alert ds-alert--warning" data-testid="agent-problem">
            <div className="ds-alert__content">
              <p className="ds-alert__label">{`${row.name}: ${row.state ?? "Unavailable"}`}</p>
              <p className="ds-alert__body">{row.problem}</p>
            </div>
          </div>
        ) : repository !== null ? (
          <>
            <div className="ds-stack ds-gap-xs">
              <p className="ds-radio__legend">{row.name}</p>
              <p data-testid="model-about" className="ds-radio__description">
                {agentAbout(row)}
              </p>
            </div>
            {models}
          </>
        ) : row.agent === CLAUDE ? (
          <ModelOptions state={claude} legend="Claude Code" about={agentAbout(row)} />
        ) : otherList === undefined ? (
          <AgentHeading row={row} line={row.state === null ? "Reading its models." : null} />
        ) : "problem" in otherList ? (
          <AgentHeading row={row} line={`${row.name}'s models could not be read: ${otherList.problem} Its own default is used.`} />
        ) : (
          <OtherModels state={state} row={row} list={otherList} />
        )}
      </div>
    </div>
  );
}

/** An agent other than Claude Code with no list to show: its name, version and state, and why. */
function AgentHeading({ row, line }: { row: AgentRow; line: string | null }) {
  return (
    <div className="ds-stack ds-gap-xs" data-testid={`model-${row.agent}-about`}>
      <p className="ds-radio__legend">{row.name}</p>
      <p className="ds-radio__description">{agentAbout(row)}</p>
      <p className="ds-radio__description">{CHAT_ALONE}</p>
      {line !== null && (
        <p role="status" className="ds-radio__description">
          {line}
        </p>
      )}
    </div>
  );
}

/** An agent other than Claude Code: its default first, four more models, the rest behind More models…. */
function OtherModels({ state, row, list }: { state: ChatAgentsState; row: AgentRow; list: ModelList }) {
  const agent = row.agent;
  const chosen = state.choice.models[agent] ?? null;
  const id = `model-${agent}`;
  const first = defaultFirst(row.name, list.cliDefault, list.models, chosen);
  return (
    <fieldset className="ds-radio__group" data-testid={`${id}-options`}>
      <legend className="ds-radio__legend">{row.name}</legend>
      <p className="ds-radio__description">{agentAbout(row)}</p>
      <p className="ds-radio__description">{CHAT_ALONE}</p>
      <ModelRadio group={id} id={`${id}-default`} value="" checked={chosen === null} onChange={() => state.setModel(agent, null)} name={first.label} tag={list.cliDefault === null ? null : "default"} />
      <MoreModels models={first.models} chosen={first.models.find((m) => m.id === chosen) ?? null} option={(model, at) => <ModelRadio key={model.id} group={id} id={`${id}-${at}`} value={model.id} checked={chosen === model.id} onChange={() => state.setModel(agent, model.id)} name={model.label ?? model.id} description={idUnder(model)} />} />
    </fieldset>
  );
}

/**
 * Under a round several agents answered: one plain action that asks one agent, chosen here, to compare the answers.
 * Nothing is sent until an agent is pressed.
 */
export function CompareAction({ agents, claude, onCompare, busy }: { agents: ChatAgentsState; claude: ModelChoiceState; onCompare: (to: ChatTarget) => void; busy: boolean }) {
  const offered = (agents.offer.known ?? []).filter((a) => a.problem === null);
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
