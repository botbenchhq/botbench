import { useCallback, useEffect, useId, useState } from "react";
import { ApiError, listDevices, newPairingCode, signOutDevice, signOutOtherDevices, type SignedInDevice } from "../api/client.ts";
import { ConfirmAction } from "../components/confirm.tsx";
import { DeviceCode } from "../components/connect-sheet.tsx";
import { Alert } from "../components/header.tsx";
import { QrCode } from "../components/qr-code.tsx";
import { byteCapacity, MAX_VERSION } from "./qr.ts";
import { groupCode, signInAddress } from "./sign-in-code.ts";
import { clock, counted, fullDate } from "./format.ts";

/** Whether the encoder can draw this text: at most what a version-10 symbol holds. */
const qrFits = (text: string): boolean => new TextEncoder().encode(text).length <= byteCapacity(MAX_VERSION);

const words = (err: unknown): string => (err instanceof Error && err.message ? err.message : "Botbench could not be reached.");

/** How often the device list is read again while a code is shown, so the device it adds appears at once. */
const ADDED_POLL_MS = 2000;

/**
 * Add a device: a one-time code for signing in on another device without the login token, as text and as a QR code of
 * the sign-in address with the code in it. Asking again replaces the code shown, and the server cancels the old one.
 * While the code is shown the device list is read again every few seconds: the device the code adds is listed, and
 * named, here at once, and the code is taken off the screen.
 */
function AddDevice({ onSignedOut, onDevices }: { onSignedOut: () => void; onDevices: (devices: SignedInDevice[]) => void }) {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; minutes: number; newestBefore: number } | null>(null);
  const [expired, setExpired] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();

  // Once the code has expired it is taken off the screen, so nobody copies a code that cannot work.
  useEffect(() => {
    if (pairing === null) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);

  // Watch for the device the code signs in: one newer than every device listed before the code was made.
  useEffect(() => {
    if (pairing === null || expired || added !== null) return;
    const timer = window.setInterval(() => {
      listDevices().then((devices) => {
        const fresh = devices.find((d) => d.id > pairing.newestBefore);
        if (fresh === undefined) return;
        onDevices(devices);
        setAdded(fresh.device);
      }, () => undefined); // a missed read is tried again at the next tick
    }, ADDED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pairing, expired, added, onDevices]);

  const ask = (): void => {
    setBusy(true);
    setProblem(null);
    listDevices()
      .then((before) => newPairingCode().then((made) => ({ ...made, newestBefore: Math.max(0, ...before.map((d) => d.id)) })))
      .then(
        ({ code, expiresAt, newestBefore }) => {
          setExpired(false);
          setAdded(null);
          setPairing({ code: groupCode(code), expiresAt, newestBefore, minutes: Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000)) });
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
          setProblem(`No code was made. ${words(err)}`);
        },
      )
      .finally(() => setBusy(false));
  };

  const shown = pairing !== null && !expired && added === null ? pairing : null;
  return (
    <>
      <div className="ds-settings-row" data-testid="add-device">
        <div className="ds-settings-row__text">
          <p className="ds-settings-row__label">Add a device</p>
          <p className="ds-settings-row__description" id={`${id}-about`}>
            Sign in on a phone or another computer with a one-time code, without the login token.
          </p>
        </div>
        <div className="ds-settings-row__control">
          <button type="button" className="ds-button" aria-describedby={`${id}-about`} disabled={busy} onClick={ask}>
            {pairing === null ? "Add a device" : "Make a new code"}
          </button>
        </div>
      </div>
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      {added !== null && (
        <Alert tone="note" role="status" testId="device-added">
          {`${added} was added with the code and is signed in. If you did not add it, sign it out above.`}
        </Alert>
      )}
      {pairing !== null && expired && added === null && (
        <Alert tone="warning" role="alert">
          The code has expired and can no longer be used. Make a new code to add a device.
        </Alert>
      )}
      {shown !== null && (
        <div className="ds-device-code" data-testid="pairing">
          <ol className="ds-device-code__steps">
            <li className="ds-device-code__step">
              {qrFits(signInAddress(window.location.origin, shown.code)) ? (
                <>
                  <p>
                    On the other device, scan this QR code with the camera, or open <span data-ds-content="">{window.location.origin}</span> and choose Code.
                  </p>
                  <QrCode text={signInAddress(window.location.origin, shown.code)} label={`QR code of the sign-in address with the code ${shown.code}`} testId="pairing-qr" />
                </>
              ) : (
                // An address too long for the QR code: the code alone still adds the device.
                <p>
                  On the other device, open <span data-ds-content="">{window.location.origin}</span> and choose Code.
                </p>
              )}
            </li>
            <li className="ds-device-code__step">
              <p>Enter this code there, if the QR code did not fill it in:</p>
              <DeviceCode code={shown.code} testId="pairing-code" />
            </li>
          </ol>
          <div className="ds-device-code__status">
            <p className="ds-device-code__note">{`It works once, for ${counted(shown.minutes, "minute", "minutes")}: until ${clock(shown.expiresAt)}. Making a new code stops this one working.`}</p>
          </div>
        </div>
      )}
    </>
  );
}

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
        {note ?? "A device stays signed in for 90 days after it was last used. Sign out a device you no longer use or do not recognise: it needs the login token, or a new code from Add a device, to sign in again."}
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
            <p className="ds-settings-row__description">{`Signed in ${fullDate(device.signedInAt)}. Last used ${fullDate(device.lastUsedAt)}.`}</p>
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
      <AddDevice onSignedOut={onSignedOut} onDevices={setDevices} />
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
