import { useCallback, useEffect, useId, useState } from "react";
import { ApiError, listDevices, signOutDevice, signOutOtherDevices, type SignedInDevice } from "../api/client.ts";
import { ConfirmAction } from "../components/confirm.tsx";

const when = (ts: string): string => new Date(ts).toLocaleString();
const words = (err: unknown): string => (err instanceof Error && err.message ? err.message : "Botbench could not be reached.");

/**
 * The Signed-in devices group of Settings: every device that is signed in, this one marked, each with its own Sign out,
 * and Sign out everywhere else. A device stays signed in for 90 days after it was last used.
 */
export function DeviceSettings({ onSignedOut }: { onSignedOut: () => void }) {
  const [devices, setDevices] = useState<SignedInDevice[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const failed = useCallback(
    (what: string) => (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setNote(`${what} ${words(err)}`);
    },
    [onSignedOut],
  );

  const refresh = useCallback(() => {
    listDevices().then(setDevices, failed("The signed-in devices could not be read."));
  }, [failed]);
  useEffect(refresh, [refresh]);

  const signOut = (device: SignedInDevice): void => {
    setBusy(true);
    setNote(null);
    signOutDevice(device.id)
      .then(() => {
        // This device is signed out: back to the sign-in screen, from the start screen.
        if (device.current) return window.location.assign("/");
        refresh();
      }, failed(`${device.device} was not signed out.`))
      .finally(() => setBusy(false));
  };

  const signOutOthers = (): void => {
    setBusy(true);
    setNote(null);
    signOutOtherDevices()
      .then(refresh, failed("The other devices were not signed out."))
      .finally(() => setBusy(false));
  };

  const others = devices?.filter((d) => !d.current).length ?? 0;
  return (
    <div className="ds-settings-row__group" role="group" aria-labelledby={`${id}-heading`} data-testid="devices">
      <h2 className="ds-settings-row__heading" id={`${id}-heading`}>
        Signed-in devices
      </h2>
      <p className="ds-settings-row__description" id={`${id}-about`} role={note ? "alert" : undefined}>
        {note ?? "A device stays signed in for 90 days after it was last used. Sign out a device you no longer use or do not recognise: it needs the login token to sign in again."}
      </p>
      {devices === null && note === null && (
        <p role="status" className="ds-spinner">
          Reading the signed-in devices.
        </p>
      )}
      {devices?.map((device) => (
        <div key={device.id} className="ds-settings-row" data-testid="device">
          <div className="ds-settings-row__text">
            <p className="ds-settings-row__label">{device.device}</p>
            <p className="ds-settings-row__description">{`Signed in ${when(device.signedInAt)}. Last used ${when(device.lastUsedAt)}.`}</p>
          </div>
          <div className="ds-settings-row__control">
            {device.current && <p className="ds-settings-row__status">This device</p>}
            {device.current ? (
              <ConfirmAction label="Sign out" opener={{ small: false, name: "Sign out this device" }} title="Sign out this device?" confirmLabel="Sign out" cancelLabel="Stay signed in" disabled={busy} losing testId="sign-out-dialog" onConfirm={() => signOut(device)}>
                <p>You will need the login token to sign in again on this device.</p>
              </ConfirmAction>
            ) : (
              <button type="button" className="ds-button" aria-label={`Sign out ${device.device}`} data-ds-content-label="" disabled={busy} onClick={() => signOut(device)}>
                Sign out
              </button>
            )}
          </div>
        </div>
      ))}
      {others > 0 && (
        <div className="ds-settings-row">
          <div className="ds-settings-row__text">
            <p className="ds-settings-row__label">Other devices</p>
            <p className="ds-settings-row__description" id={`${id}-others-about`}>
              Signs out every device except this one, at once.
            </p>
          </div>
          <div className="ds-settings-row__control">
            <button type="button" className="ds-button" aria-describedby={`${id}-others-about`} disabled={busy} onClick={signOutOthers}>
              Sign out everywhere else
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
