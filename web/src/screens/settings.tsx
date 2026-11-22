import { useEffect, useId, useState } from "react";
import { ApiError, getAgents, type AgentState } from "../api/client.ts";
import { chooseAppearance, useAppearance, type Appearance } from "../app/appearance.ts";
import { NotificationSettings } from "../app/notification-settings.tsx";
import { Frame, Page, PageHeader } from "../components/header.tsx";

/** An agent's state in a word or two, from the probe: what the CLI itself reported. */
function agentState(agent: AgentState): string {
  if (agent.problem === null) return "Available";
  if (!agent.installed) return "Not installed";
  if (!agent.supported) return "Unsupported version";
  if (!agent.signedIn) return "Signed out";
  return "Unavailable";
}

/** What Botbench lets the agent do, in words, from the steps the server reports. */
function agentSteps(agent: AgentState): string {
  const can = agent.roles.includes("planner") && agent.roles.includes("builder") ? "Plans and builds tasks." : agent.roles.includes("reviewer") ? "Reviews a run's tasks when you choose it on New run; it cannot plan or build here." : "";
  return can;
}

/** What the probe found, in a sentence: the version and the kind of sign-in when it can be used, else what is wrong. */
function agentAbout(agent: AgentState): string {
  if (agent.problem !== null) return agent.problem;
  const signIn = agent.billing === "subscription" ? "Signed in with a subscription." : agent.billing === "metered" ? "Signed in, billed by use." : "Signed in.";
  return `${agent.version === null ? "" : `Version ${agent.version}. `}${signIn}`;
}

/** The agents Botbench drives, in the order it lists them. */
const AGENTS = [
  { agent: "claude-code", name: "Claude Code" },
  { agent: "codex", name: "Codex" },
];

const MODES: { value: Appearance; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "auto", label: "Match device" },
];

/**
 * Settings (unit 16), with its real sections only. Agents: each agent Botbench can drive, as its CLI reports itself
 * now, and what Botbench lets it do: Claude Code plans and builds, Codex reviews. Appearance: the mode this device shows, saved as it is chosen.
 * Notifications: this device's notifications, on or off (unit 23).
 */
export function SettingsScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [agents, setAgents] = useState<AgentState[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { choice } = useAppearance();
  const id = useId();

  useEffect(() => {
    getAgents().then(setAgents, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `The agents could not be checked. ${err.message}` : "The agents could not be checked: Botbench could not be reached.");
    });
  }, [onSignedOut]);

  return (
    <Frame current={null}>
      <Page pattern="ds-settings-page">
          <PageHeader title="Settings">
            <p className="ds-page-header__description">Each change is saved as you make it.</p>
          </PageHeader>

          <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-agents`}>
            <h2 className="ds-settings-row__heading" id={`${id}-agents`}>
              Agents
            </h2>
            {AGENTS.map(({ agent: key, name }) => {
              const agent = agents?.find((found) => found.agent === key) ?? null;
              return (
                <div key={key} data-testid={`agent-${key}`} className="ds-settings-row">
                  <div className="ds-settings-row__text">
                    <p className="ds-settings-row__label">{name}</p>
                    <p className="ds-settings-row__description">{agent !== null ? `${agentAbout(agent)} ${agentSteps(agent)}`.trim() : problem ?? (agents === null ? `Checking ${name}.` : `${name} is not offered by this Botbench.`)}</p>
                  </div>
                  <div className="ds-settings-row__control">
                    <p data-testid="agent-state" role="status" className="ds-settings-row__status">
                      {agent !== null ? agentState(agent) : problem !== null ? "Could not be checked" : agents === null ? "Checking" : "Not offered"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-appearance`}>
            <h2 className="ds-settings-row__heading" id={`${id}-appearance`}>
              Appearance
            </h2>
            <div className="ds-settings-row">
              <div className="ds-settings-row__text">
                <label className="ds-settings-row__label" htmlFor={`${id}-mode`}>
                  Mode
                </label>
                <p className="ds-settings-row__description" id={`${id}-mode-about`}>
                  Dark is the default. Match device follows this device's own light or dark setting. Kept on this device only.
                </p>
              </div>
              <div className="ds-settings-row__control">
                <div className="ds-select">
                  <select className="ds-field__control ds-select__control" id={`${id}-mode`} value={choice} aria-describedby={`${id}-mode-about`} onChange={(e) => chooseAppearance(e.currentTarget.value as Appearance)}>
                    {MODES.map((mode) => (
                      <option key={mode.value} value={mode.value}>
                        {mode.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          <NotificationSettings onSignedOut={onSignedOut} />
      </Page>
    </Frame>
  );
}
