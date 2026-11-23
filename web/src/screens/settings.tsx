import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { agentState } from "../app/chat.ts";
import { ApiError, getAgents, getAskEveryCommand, getChatWebAccess, getDefaultMode, getWorkbench, openEventStream, setAskEveryCommand, setChatWebAccess, setDefaultMode, setWorkbench, type AgentState, type RunMode, type WebAccess, type WorkbenchSetting } from "../api/client.ts";
import { chooseAppearance, useAppearance, type Appearance } from "../app/appearance.ts";
import { DeviceSettings } from "../app/device-settings.tsx";
import { MemorySettings } from "../app/memory-settings.tsx";
import { WatchSettings } from "../app/watch-settings.tsx";
import { ExecutionSettings } from "../app/execution-settings.tsx";
import { UpdateSettings } from "../app/update-settings.tsx";
import { NotificationSettings } from "../app/notification-settings.tsx";
import { AgentConnection } from "../components/connect-sheet.tsx";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";
import { Icon } from "../components/icon.tsx";
import { ModePicker } from "../components/mode-choice.tsx";
import { useWide } from "../app/wide.ts";
import { Permissions } from "./trust.tsx";
import { Usage } from "./usage.tsx";
import type { SettingsSection } from "../app/route.ts";

/**
 * Every section of Settings, in the order the two-pane Settings lists them, with the address that opens each.
 * Permissions and Usage keep their own addresses; below 1024px they are screens of their own, reached from the rows at
 * the top of Settings (`about` is what those rows say under the name). Approach from OpenMausBot
 * src/components/settings/settings-places.ts: one ordered list of every place in Settings, which both layouts read.
 */
const SECTIONS: readonly { section: SettingsSection; name: string; href: string; about?: string }[] = [
  { section: "agents", name: "Agents", href: "#/settings/agents" },
  { section: "appearance", name: "Appearance", href: "#/settings/appearance" },
  { section: "notifications", name: "Notifications", href: "#/settings/notifications" },
  { section: "devices", name: "Signed-in devices", href: "#/settings/devices" },
  { section: "workbench", name: "This workbench", href: "#/settings/workbench" },
  { section: "permissions", name: "Permissions", href: "#/trust", about: "What is always allowed, and what ran" },
  { section: "usage", name: "Usage", href: "#/usage", about: "How much each agent did" },
];

/** The screens reached from Settings below 1024px, first on it: each its own screen, with a link back. */
const LINKED = SECTIONS.flatMap(({ href, name, about }) => (about === undefined ? [] : [{ href, name, about }]));

/** What Botbench lets the agent do, in words, from the steps the server reports. */
function agentSteps(agent: AgentState): string {
  const plans = agent.roles.includes("planner");
  const builds = agent.roles.includes("builder");
  const reviews = agent.roles.includes("reviewer");
  const can = plans && builds ? "Plans and builds tasks." : builds && reviews ? "Builds a task or a run's tasks when you choose it under Builder, and reviews a run's tasks when you choose it for a run; it does not plan." : reviews ? "Reviews a run's tasks when you choose it for a run; it cannot plan or build here." : "";
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

/** The same rule the server holds a workbench name to (src/workbench.ts), so a name it would refuse is said before it is sent. */
const WORKBENCH = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/**
 * This workbench's name (Peers P1): its new task branches carry it, so they never clash with another workbench's on a
 * shared remote. Saved with Save name; a name the settings file sets is shown, and changed there.
 */
function WorkbenchName({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [current, setCurrent] = useState<WorkbenchSetting | null>(null);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const failed = (what: string) => (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what.replace(/\.$/, "")}: Botbench could not be reached.`);
  };
  useEffect(() => {
    getWorkbench().then((found) => {
      setCurrent(found);
      setTyped(found.name);
    }, failed("The workbench name could not be read."));
  }, [onSignedOut]);
  const save = (): void => {
    setSaved(false);
    if (!WORKBENCH.test(typed)) return setProblem('A workbench name is 1 to 30 lowercase letters, digits and hyphens, and starts and ends with a letter or digit, such as "jons-mac".');
    setProblem(null);
    setWorkbench(typed).then((found) => {
      setCurrent(found);
      setTyped(found.name);
      setSaved(true);
    }, failed("The workbench name was not saved."));
  };
  const fromFile = current?.setInFile === true;
  return (
    <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-heading`}>
      <h2 className="ds-settings-row__heading" id={`${id}-heading`}>
        Workbench
      </h2>
      <form
        className="ds-settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="ds-settings-row__text">
          <label className="ds-settings-row__label" htmlFor={`${id}-name`}>
            Workbench name
          </label>
          <p className="ds-settings-row__description" id={`${id}-about`}>
            {fromFile
              ? 'Set in the settings file ("workbench"), so it is changed there.'
              : `New task branches carry this name, such as botbench/${current?.name ?? "name"}/run-1/task-1, so they never clash with another workbench's on a shared remote. Changing it affects only new branches.`}
          </p>
          {problem !== null && (
            <p role="alert" id={`${id}-problem`} className="ds-settings-row__error">
              {problem}
            </p>
          )}
          {saved && problem === null && (
            <p role="status" data-testid="workbench-saved" className="ds-settings-row__description">
              Saved.
            </p>
          )}
        </div>
        <div className="ds-settings-row__control ds-cluster ds-gap-sm">
          <input
            data-testid="workbench-name"
            className="ds-field__control"
            id={`${id}-name`}
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={30}
            value={typed}
            readOnly={fromFile || current === null}
            aria-invalid={problem !== null || undefined}
            aria-describedby={problem === null ? `${id}-about` : `${id}-about ${id}-problem`}
            onChange={(e) => {
              setTyped(e.currentTarget.value);
              setSaved(false);
            }}
          />
          {!fromFile && current !== null && (
            <button type="submit" className="ds-button" disabled={typed === current.name}>
              Save name
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * Settings (unit 16), with its real sections only. Agents: each agent Botbench can drive, as its CLI reports itself
 * now, and what Botbench lets it do: Claude Code plans and builds, Codex, Grok and Antigravity review. Runs: the mode New run starts with,
 * and whether every command of a Manual run asks, kept by Botbench. Web: what Claude Code's web tools may do, kept by Botbench. Appearance: the mode this device shows, saved as it is chosen.
 * Notifications: this device's notifications, on or off (unit 23).
 */
/** The choices for web access, in the order they are offered, with what each does. */
const WEB_ACCESS: { value: WebAccess; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "off", label: "Off" },
];

/**
 * Web access: whether Claude Code may fetch pages and search the web without asking, in a chat, a task or a run, asks
 * you each time, or may not; and whether Codex and Grok, which cannot ask, may use their own web search (Allow only), in
 * a chat and in a review. Kept by Botbench and saved as it is chosen; it is read at each request.
 */
function ChatWebAccess({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [value, setValue] = useState<WebAccess | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    getChatWebAccess().then(setValue, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `Web access could not be read. ${err.message}` : "Web access could not be read: Botbench could not be reached.");
    });
  }, [onSignedOut]);
  const choose = (next: WebAccess): void => {
    const before = value;
    setValue(next);
    setProblem(null);
    setChatWebAccess(next).then(setValue, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setValue(before);
      setProblem(err instanceof ApiError ? `Web access was not saved. ${err.message}` : "Web access was not saved: Botbench could not be reached.");
    });
  };
  return (
    <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-chat`}>
      <h2 className="ds-settings-row__heading" id={`${id}-chat`}>
        Web
      </h2>
      <div className="ds-settings-row">
        <div className="ds-settings-row__text">
          <label className="ds-settings-row__label" htmlFor={`${id}-web`}>
            Web access
          </label>
          <p className="ds-settings-row__description" id={`${id}-web-about`}>
            Whether Claude Code may fetch pages and search the web, in a chat, a task or a run. The address or search goes to that site or search service; what comes back goes to Claude Code. Each one shows in the transcript. A run started from a GitHub issue always asks. Codex, Grok and Antigravity search the web, in a chat and when they review a task, only on Allow: their own provider runs the search without asking you first, and their commands reach nothing on the network but that provider.
          </p>
        </div>
        <div className="ds-settings-row__control">
          <div className="ds-select">
            <select data-testid="chat-web-access" className="ds-field__control ds-select__control" id={`${id}-web`} value={value ?? ""} disabled={value === null} aria-describedby={`${id}-web-about`} onChange={(e) => choose(e.currentTarget.value as WebAccess)}>
              {value === null && <option value="">Checking</option>}
              {WEB_ACCESS.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
    </div>
  );
}

/**
 * Ask before every command: off by default. On, every command of a Manual run or a single task asks you, also one kept
 * inside the task's copy. Kept by Botbench and saved as it is chosen; it is read at each request.
 */
function AskEveryCommand({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [value, setValue] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    getAskEveryCommand().then(setValue, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `Ask before every command could not be read. ${err.message}` : "Ask before every command could not be read: Botbench could not be reached.");
    });
  }, [onSignedOut]);
  const choose = (next: boolean): void => {
    const before = value;
    setValue(next);
    setProblem(null);
    setAskEveryCommand(next).then(setValue, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setValue(before);
      setProblem(err instanceof ApiError ? `Ask before every command was not saved. ${err.message}` : "Ask before every command was not saved: Botbench could not be reached.");
    });
  };
  return (
    <>
      <div className="ds-settings-row">
        <div className="ds-settings-row__text">
          <label className="ds-settings-row__label" htmlFor={`${id}-every`}>
            Ask before every command
          </label>
          <p className="ds-settings-row__description" id={`${id}-every-about`}>
            In Manual runs and single tasks, asks you before each command, also one kept inside the task's copy. Off, only commands on the always-ask list or outside the copy ask.
          </p>
        </div>
        <div className="ds-settings-row__control">
          <div className="ds-select">
            <select data-testid="ask-every-command" className="ds-field__control ds-select__control" id={`${id}-every`} value={value === null ? "" : value ? "on" : "off"} disabled={value === null} aria-describedby={`${id}-every-about`} onChange={(e) => choose(e.currentTarget.value === "on")}>
              {value === null && <option value="">Checking</option>}
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </div>
        </div>
      </div>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
    </>
  );
}

export function SettingsScreen({ section, onSignedOut }: { section: SettingsSection | null; onSignedOut: () => void }) {
  const wide = useWide();
  const [agents, setAgents] = useState<AgentState[] | null>(null);
  // Opened at its Agents section (#/settings/agents): that section is brought into view and its heading takes the focus,
  // so a screen reader starts there too.
  const agentsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (section !== "agents") return;
    agentsHeading.current?.scrollIntoView({ block: "start" });
    agentsHeading.current?.focus({ preventScroll: true });
  }, [section]);
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
    // Settings shows each agent's state as it is now, after a sign-in or sign-out too.
    getAgents(true).then(
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

  const agentsGroup = (
    <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-agents`}>
      <h2 ref={agentsHeading} tabIndex={-1} className="ds-settings-row__heading" id={`${id}-agents`}>
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
  );

  const runsGroup = (
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
      <AskEveryCommand onSignedOut={onSignedOut} />
    </div>
  );

  const appearanceGroup = (
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
  );

  if (wide) {
    // From 1024px: the design system's master-detail pattern, with the sections in the list pane and only the chosen
    // one beside it, as a settings page. Agents is chosen when the address names none. Approach from OpenMausBot
    // src/components/settings/SettingsWindow.tsx and SettingsNav.tsx: the list of pages on the left marks the open one
    // as current, and the page beside it is the only one drawn.
    const chosen = SECTIONS.find((s) => s.section === (section ?? "agents"))!;
    const content: Record<SettingsSection, ReactNode> = {
      agents: agentsGroup,
      appearance: appearanceGroup,
      notifications: <NotificationSettings onSignedOut={onSignedOut} />,
      devices: <DeviceSettings onSignedOut={onSignedOut} />,
      workbench: (
        <>
          {runsGroup}
          <ChatWebAccess onSignedOut={onSignedOut} />
          <WatchSettings onSignedOut={onSignedOut} />
          <ExecutionSettings onSignedOut={onSignedOut} />
          <WorkbenchName onSignedOut={onSignedOut} />
          <MemorySettings onSignedOut={onSignedOut} />
          <UpdateSettings onSignedOut={onSignedOut} />
        </>
      ),
      permissions: <Permissions onSignedOut={onSignedOut} />,
      usage: <Usage onSignedOut={onSignedOut} />,
    };
    return (
      <Frame current={null}>
        <main data-testid="settings-panes" className="ds-app-shell__main ds-master-detail min-w-0 px-lg">
          <div className="ds-master-detail__list">
            <PageHeader title="Settings" compact>
              <p className="ds-page-header__description">Each change is saved as you make it.</p>
            </PageHeader>
            <ul data-testid="settings-sections" className="ds-list">
              {SECTIONS.map((s) => (
                <li key={s.section} className="ds-list__row">
                  <a href={s.href} className="ds-list__link" aria-current={s === chosen ? "true" : undefined}>
                    <span className="ds-list__body">
                      <span className="ds-list__primary">{s.name}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          {/* The section's own groups carry its headings, so the region is named by the row that opened it. */}
          <section data-testid="settings-section" className="ds-master-detail__detail ds-settings-page" aria-label={chosen.name}>
            {content[chosen.section]}
          </section>
        </main>
      </Frame>
    );
  }

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

          {agentsGroup}

          {runsGroup}

          <ChatWebAccess onSignedOut={onSignedOut} />

          <WatchSettings onSignedOut={onSignedOut} />

          <ExecutionSettings onSignedOut={onSignedOut} />

          <WorkbenchName onSignedOut={onSignedOut} />

          <MemorySettings onSignedOut={onSignedOut} />

          <UpdateSettings onSignedOut={onSignedOut} />

          {appearanceGroup}

          <NotificationSettings onSignedOut={onSignedOut} />

          <DeviceSettings onSignedOut={onSignedOut} />
      </Page>
    </Frame>
  );
}
