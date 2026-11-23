import { useCallback, useEffect, useId, useState } from "react";
import { ApiError, getAgents, getDefaultMode, openEventStream, setDefaultMode, type AgentState, type RunMode } from "../api/client.ts";
import { chooseAppearance, useAppearance, type Appearance } from "../app/appearance.ts";
import { DeviceSettings } from "../app/device-settings.tsx";
import { NotificationSettings } from "../app/notification-settings.tsx";
import { AgentConnection } from "../components/connect-sheet.tsx";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";
import { Icon } from "../components/icon.tsx";
import { ModePicker } from "../components/mode-choice.tsx";

/** The screens reached from Settings, first on it: each its own screen, with a link back. */
const LINKED: readonly { href: string; name: string; about: string }[] = [
  { href: "#/trust", name: "Permissions", about: "What is always allowed, and what ran" },
  { href: "#/usage", name: "Usage", about: "How much each agent did" },
];

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
  const can = agent.roles.includes("planner") && agent.roles.includes("builder") ? "Plans and builds tasks." : agent.roles.includes("reviewer") ? "Reviews a run's tasks when you choose it for a run; it cannot plan or build here." : "";
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
  { agent: "grok", name: "Grok" },
  { agent: "antigravity", name: "Antigravity" },
];

const MODES: { value: Appearance; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "auto", label: "Match device" },
];

/**
 * Settings (unit 16), with its real sections only. Agents: each agent Botbench can drive, as its CLI reports itself
 * now, and what Botbench lets it do: Claude Code plans and builds, Codex, Grok and Antigravity review. Runs: the mode New run starts with,
 * kept by Botbench. Appearance: the mode this device shows, saved as it is chosen.
 * Notifications: this device's notifications, on or off (unit 23).
 */
export function SettingsScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [agents, setAgents] = useState<AgentState[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { choice } = useAppearance();
  const id = useId();
  const [runMode, setRunMode] = useState<RunMode | null>(null);
  const [modeProblem, setModeProblem] = useState<string | null>(null);

  useEffect(() => {
    getDefaultMode().then(setRunMode, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setModeProblem(err instanceof ApiError ? `The default mode could not be read. ${err.message}` : "The default mode could not be read: Botbench could not be reached.");
    });
  }, [onSignedOut]);

  const chooseMode = (mode: RunMode): void => {
    const before = runMode;
    setRunMode(mode);
    setModeProblem(null);
    setDefaultMode(mode).then(setRunMode, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setRunMode(before);
      setModeProblem(err instanceof ApiError ? `The default mode was not saved. ${err.message}` : "The default mode was not saved: Botbench could not be reached.");
    });
  };

  /** How often the agents were read: each row's Connect reads its sign-in again with them. */
  const [version, setVersion] = useState(0);

  const refresh = useCallback((): void => {
    getAgents().then(
      (found) => (setAgents(found), setVersion((v) => v + 1)),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(err instanceof ApiError ? `The agents could not be checked. ${err.message}` : "The agents could not be checked: Botbench could not be reached.");
      },
    );
  }, [onSignedOut]);

  useEffect(() => {
    refresh();
    // An agent connected or disconnected, here or in another tab, is told over the live updates; the agents are then read again.
    return openEventStream(0, { onEvent: () => {}, onConnection: () => {}, onSignedOut, onAgent: (a) => a.state !== "starting" && a.state !== "waiting" && refresh() });
  }, [refresh, onSignedOut]);

  return (
    <Frame current={null}>
      <Page pattern="ds-settings-page">
          <PageHeader title="Settings">
            <p className="ds-page-header__description">Each change is saved as you make it.</p>
          </PageHeader>

          <ul data-testid="settings-links" className="ds-list">
            {LINKED.map((link) => (
              <li key={link.href} className="ds-list__row">
                <a href={link.href} className="ds-list__link">
                  <span className="ds-list__body">
                    <span className="ds-list__primary">{link.name}</span>
                    <span className="ds-list__secondary">{link.about}</span>
                  </span>
                  <Icon name="chevron-right" className="ds-list__icon" />
                </a>
              </li>
            ))}
          </ul>

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
                    {agent !== null && <AgentConnection agent={key} product={name} installed={agent.installed} supported={agent.supported} signedIn={agent.signedIn} version={version} onChanged={refresh} />}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-runs`}>
            <h2 className="ds-settings-row__heading" id={`${id}-runs`}>
              Runs
            </h2>
            <ModePicker name="default-mode" legend="Default mode" hint="A new run starts with this mode chosen. You can pick another for each run." value={runMode} onChange={chooseMode} />
            {modeProblem !== null && (
              <Alert tone="error" role="alert">
                {modeProblem}
              </Alert>
            )}
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

          <DeviceSettings onSignedOut={onSignedOut} />
      </Page>
    </Frame>
  );
}
