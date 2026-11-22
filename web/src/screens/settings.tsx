import { useEffect, useId, useState } from "react";
import { ApiError, getDriver, type DriverState } from "../api/client.ts";
import { chooseAppearance, useAppearance, type Appearance } from "../app/appearance.ts";
import { Frame, Page, PageHeader } from "../components/header.tsx";

/** An agent's state in a word or two, from the probe: what the CLI itself reported. */
function agentState(driver: DriverState): string {
  if (driver.problem === null) return "Available";
  if (!driver.installed) return "Not installed";
  if (!driver.supported) return "Unsupported version";
  if (!driver.signedIn) return "Signed out";
  return "Unavailable";
}

/** What the probe found, in a sentence: the version and the kind of sign-in when it can be used, else what is wrong. */
function agentAbout(driver: DriverState): string {
  if (driver.problem !== null) return driver.problem;
  const signIn = driver.billing === "subscription" ? "Signed in with a subscription." : driver.billing === "metered" ? "Signed in, billed by use." : "Signed in.";
  return `${driver.version === null ? "" : `Version ${driver.version}. `}${signIn}`;
}

const MODES: { value: Appearance; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "auto", label: "Match device" },
];

/**
 * Settings (unit 16), with its real sections only. Agents: each agent Botbench can drive, as its CLI reports itself
 * now; Claude Code is the only one so far. Appearance: the mode this device shows, saved as it is chosen.
 */
export function SettingsScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [driver, setDriver] = useState<DriverState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { choice } = useAppearance();
  const id = useId();

  useEffect(() => {
    getDriver().then(setDriver, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `Claude Code could not be checked. ${err.message}` : "Claude Code could not be checked: Botbench could not be reached.");
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
            <div data-testid="agent-claude-code" className="ds-settings-row">
              <div className="ds-settings-row__text">
                <p className="ds-settings-row__label">Claude Code</p>
                <p className="ds-settings-row__description">{driver !== null ? agentAbout(driver) : problem ?? "Checking Claude Code."}</p>
              </div>
              <div className="ds-settings-row__control">
                <p data-testid="agent-state" role="status" className="ds-settings-row__status">
                  {driver !== null ? agentState(driver) : problem !== null ? "Could not be checked" : "Checking"}
                </p>
              </div>
            </div>
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
      </Page>
    </Frame>
  );
}
