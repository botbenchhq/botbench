import { useEffect, useId, useState } from "react";
import { ApiError, getPushKey } from "../api/client.ts";
import { notificationState, sendTest, STATE_WORDS, turnOff, turnOn, type NotificationState } from "./notifications.ts";

const words = (err: unknown): string => (err instanceof Error && err.message ? err.message : "Botbench could not be reached.");

/**
 * The Notifications group of Settings (unit 23): this device's state in words, the one control that changes it, and a
 * test notification once it is on. Each control exists only in the state where it works.
 */
export function NotificationSettings({ onSignedOut }: { onSignedOut: () => void }) {
  const [state, setState] = useState<NotificationState | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const id = useId();

  const failed = (what: string) => (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setNote(`${what} ${words(err)}`);
  };

  useEffect(() => {
    notificationState().then(setState, (err: unknown) => {
      setState("off");
      failed("This device's notifications could not be checked.")(err);
    });
    getPushKey().then(setKey, () => undefined);
    // Checked once on opening; the state changes only through the controls below or the browser's own settings.
  }, []);

  const change = (on: boolean) => {
    setBusy(true);
    setNote(null);
    setTestNote(null);
    (on ? turnOn(key!) : turnOff())
      .then((next) => {
        setState(next);
        if (on && next === "off") setNote("Notifications were not allowed. Choose Allow notifications to be asked again.");
      }, failed(on ? "Notifications could not be allowed." : "Notifications could not be stopped."))
      .finally(() => setBusy(false));
  };

  const test = () => {
    setBusy(true);
    setTestNote(null);
    sendTest()
      .then(
        () => setTestNote("Sent. It should appear on this device within a few seconds."),
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
          if (err instanceof ApiError && err.status === 410) setState("off");
          setTestNote(words(err));
        },
      )
      .finally(() => setBusy(false));
  };

  const switchable = state === "on" || state === "off";
  return (
    <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-heading`} data-testid="notifications">
      <h2 className="ds-settings-row__heading" id={`${id}-heading`}>
        Notifications
      </h2>
      <div className="ds-settings-row">
        <div className="ds-settings-row__text">
          <p className="ds-settings-row__label">This device</p>
          <p className="ds-settings-row__description">Botbench tells this device when an approval is waiting or a task is ready for review. A notification says only that: never a command, code or a file.</p>
        </div>
        <div className="ds-settings-row__control">
          <p data-testid="notifications-state" role="status" className="ds-settings-row__status">
            {state === null ? "Checking" : STATE_WORDS[state]}
          </p>
        </div>
      </div>
      {switchable ? (
        <div className="ds-settings-row">
          <div className="ds-settings-row__text">
            <p className="ds-settings-row__label">{state === "on" ? "Stop" : "Allow"}</p>
            <p className="ds-settings-row__description" id={`${id}-switch-about`} role={note ? "alert" : undefined}>
              {note ?? (state === "on" ? "This device stops being notified. Other devices keep their own setting." : "Your browser asks whether Botbench may notify this device.")}
            </p>
          </div>
          <div className="ds-settings-row__control">
            <button type="button" className="ds-button" aria-describedby={`${id}-switch-about`} disabled={busy || (state === "off" && key === null)} onClick={() => change(state === "off")}>
              {state === "on" ? "Stop notifications" : "Allow notifications"}
            </button>
          </div>
        </div>
      ) : null}
      {state === "on" ? (
        <div className="ds-settings-row">
          <div className="ds-settings-row__text">
            <p className="ds-settings-row__label">Test</p>
            <p className="ds-settings-row__description" id={`${id}-test-about`} role={testNote ? "status" : undefined}>
              {testNote ?? "Sends one notification to this device, which opens Settings."}
            </p>
          </div>
          <div className="ds-settings-row__control">
            <button type="button" className="ds-button" aria-describedby={`${id}-test-about`} disabled={busy} onClick={test}>
              Send a test notification
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
