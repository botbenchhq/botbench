import { useCallback, useEffect, useId, useState } from "react";
import { ApiError, getPushKey, listDevices, newPairingCode, signOutDevice, signOutOtherDevices, type SignedInDevice } from "../../api/client.ts";
import { clock, counted, fullDate } from "../../app/format.ts";
import { notificationState, sendTest, STATE_WORDS, turnOff, turnOn, type NotificationState } from "../../app/notifications.ts";
import { byteCapacity, MAX_VERSION } from "../../app/qr.ts";
import { groupCode, signInAddress } from "../../app/sign-in-code.ts";
import { QrCode } from "../../components/qr-code.tsx";
import { DeviceCode } from "./codes.tsx";
import { About, Busy, Confirm, More, Note, Panel, Reading, Row, SectionHeading, StateWord } from "./parts.tsx";

/** Whether the encoder can draw this text: at most what a version-10 symbol holds. */
const qrFits = (text: string): boolean => new TextEncoder().encode(text).length <= byteCapacity(MAX_VERSION);

const words = (err: unknown): string => (err instanceof Error && err.message ? err.message : "Botbench could not be reached.");

/** How often the device list is read again while a code is shown, so the device it adds appears at once. */
const ADDED_POLL_MS = 2000;

interface Code {
  code: string;
  expiresAt: string;
  minutes: number;
  newestBefore: number;
}

/**
 * Signed-in devices: every device that is signed in, this one marked, each with its own Sign out, Sign out everywhere
 * else, and Add a device: a one-time code for signing in on another device without the login token, as text and as a
 * QR code of the sign-in address with the code in it. Asking again replaces the code shown, and the server cancels the
 * old one. While the code is shown the device list is read again every few seconds: the device the code adds is listed,
 * and named, here at once, and the code is taken off the screen.
 */
export function Devices({ onSignedOut }: { onSignedOut: () => void }) {
  const [devices, setDevices] = useState<SignedInDevice[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // What is being sent: the id of the device being signed out, "others", or "code". Its button is busy; the others wait.
  const [busy, setBusy] = useState<number | "others" | "code" | null>(null);
  const [pairing, setPairing] = useState<Code | null>(null);
  const [expired, setExpired] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [codeProblem, setCodeProblem] = useState<string | null>(null);

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
      listDevices().then(
        (found) => {
          const fresh = found.find((d) => d.id > pairing.newestBefore);
          if (fresh === undefined) return;
          setDevices(found);
          setAdded(fresh.device);
        },
        () => undefined, // a missed read is tried again at the next tick
      );
    }, ADDED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pairing, expired, added]);

  const ask = (): void => {
    setBusy("code");
    setCodeProblem(null);
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
          setCodeProblem(`No code was made. ${words(err)}`);
        },
      )
      .finally(() => setBusy(null));
  };

  const signOut = (device: SignedInDevice): void => {
    setBusy(device.id);
    setNote(null);
    signOutDevice(device.id)
      .then(() => {
        // This device is signed out: back to the sign-in screen, from the start screen.
        if (device.current) return window.location.assign("/");
        refresh();
      }, failed(`${device.device} was not signed out.`))
      .finally(() => setBusy(null));
  };

  const signOutOthers = (): void => {
    setBusy("others");
    setNote(null);
    signOutOtherDevices()
      .then(refresh, failed("The other devices were not signed out."))
      .finally(() => setBusy(null));
  };

  const others = devices?.filter((d) => !d.current).length ?? 0;
  const shown = pairing !== null && !expired && added === null ? pairing : null;
  const waits = busy !== null;
  return (
    <section aria-labelledby="settings-devices" data-testid="devices" className="flex flex-col gap-3">
      <SectionHeading
        id="settings-devices"
        right={
          <span data-testid="add-device">
            <Busy size="sm" aria-describedby="settings-devices-add" busy={busy === "code"} busyLabel="Making a code" disabled={waits && busy !== "code"} onClick={ask}>
              {pairing === null ? "Add a device" : "Make a new code"}
            </Busy>
          </span>
        }
      >
        Signed-in devices
      </SectionHeading>
      <About id="settings-devices-add">Add a device signs in a phone or another computer with a one-time code, without the login token.</About>
      {note !== null && (
        <Note tone="error" role="alert">
          {note}
        </Note>
      )}
      {codeProblem !== null && (
        <Note tone="error" role="alert">
          {codeProblem}
        </Note>
      )}
      {added !== null && (
        <Note tone="note" role="status" testId="device-added">
          <span data-ds-content="">{`${added} was added with the code and is signed in. If you did not add it, sign it out below.`}</span>
        </Note>
      )}
      {pairing !== null && expired && added === null && (
        <Note tone="warning" role="alert">
          The code has expired and can no longer be used. Make a new code to add a device.
        </Note>
      )}
      {shown !== null && (
        <Panel data-testid="pairing" className="flex flex-col gap-4 p-5 text-sm">
          <ol className="flex list-decimal flex-col gap-4 pl-5">
            <li>
              {qrFits(signInAddress(window.location.origin, shown.code)) ? (
                <>
                  <p className="pb-3">
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
            <li>
              <p className="pb-2">Enter this code there, if the QR code did not fill it in:</p>
              <DeviceCode code={shown.code} testId="pairing-code" />
            </li>
          </ol>
          <About>{`It works once, for ${counted(shown.minutes, "minute", "minutes")}: until ${clock(shown.expiresAt)}. Making a new code stops this one working.`}</About>
        </Panel>
      )}
      {devices === null && note === null && <Reading>Reading the signed-in devices.</Reading>}
      {devices !== null && (
        <Panel className="divide-y">
          {devices.map((device) => (
            <div key={device.id} data-testid="device" className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-6">
              <div className="flex min-w-0 flex-col gap-0.5 sm:min-w-56 sm:flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  <span data-ds-content="">{device.device}</span>
                  {device.current && <span className="inline-flex h-6 items-center rounded-sm bg-fill px-2 text-xs font-medium">This device</span>}
                </p>
                <About>{`Signed in ${fullDate(device.signedInAt)}. Last used ${fullDate(device.lastUsedAt)}.`}</About>
              </div>
              {/* The device names the group, so a Sign out that is busy, and reads "Signing out", still says which device. */}
              <div role="group" aria-label={device.device} data-ds-content-label="" className="shrink-0">
                {device.current ? (
                  <Confirm label="Sign out" opener={{ name: "Sign out this device", object: "this device" }} title="Sign out this device?" confirmLabel="Sign out" cancelLabel="Stay signed in" disabled={waits && busy !== device.id} busy={busy === device.id} busyLabel="Signing out" losing testId="sign-out-dialog" onConfirm={() => signOut(device)}>
                    <p>You will need the login token to sign in again on this device.</p>
                  </Confirm>
                ) : (
                  <Busy aria-label={busy === device.id ? undefined : `Sign out ${device.device}`} data-ds-content-label="" busy={busy === device.id} busyLabel="Signing out" disabled={waits && busy !== device.id} onClick={() => signOut(device)}>
                    Sign out
                  </Busy>
                )}
              </div>
            </div>
          ))}
          {others > 0 && (
            <Row
              label="Other devices"
              about={<About id="settings-devices-others">Signs out every device except this one, at once.</About>}
              control={
                <Busy aria-describedby="settings-devices-others" busy={busy === "others"} busyLabel="Signing out" disabled={waits && busy !== "others"} onClick={signOutOthers}>
                  Sign out everywhere else
                </Busy>
              }
            />
          )}
        </Panel>
      )}
      <About>A device stays signed in for 90 days after it was last used.</About>
      <More about="Signed-in devices">
        <p>Sign out a device you no longer use or do not recognise: it needs the login token, or a new code from Add a device, to sign in again.</p>
      </More>
    </section>
  );
}

const nwords = (err: unknown): string => (err instanceof Error && err.message ? err.message : "Botbench could not be reached.");

/**
 * Notifications (unit 23): this device's state in words, the one control that changes it, and a test notification once
 * it is on. Each control exists only in the state where it works.
 */
export function Notifications({ onSignedOut }: { onSignedOut: () => void }) {
  const [state, setState] = useState<NotificationState | null>(null);
  const [key, setKey] = useState<string | null>(null);
  // What is being sent: its button is busy and keeps the focus; the other waits.
  const [busy, setBusy] = useState<"switch" | "test" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const id = useId();

  const failed = (what: string) => (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setNote(`${what} ${nwords(err)}`);
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
    setBusy("switch");
    setNote(null);
    setTestNote(null);
    (on ? turnOn(key!) : turnOff())
      .then((next) => {
        setState(next);
        if (on && next === "off") setNote("Notifications were not allowed. Choose Allow notifications to be asked again.");
      }, failed(on ? "Notifications could not be allowed." : "Notifications could not be stopped."))
      .finally(() => setBusy(null));
  };

  const test = () => {
    setBusy("test");
    setTestNote(null);
    sendTest()
      .then(
        () => setTestNote("Sent. It should appear on this device within a few seconds."),
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
          if (err instanceof ApiError && err.status === 410) setState("off");
          setTestNote(nwords(err));
        },
      )
      .finally(() => setBusy(null));
  };

  const switchable = state === "on" || state === "off";
  return (
    <section role="group" aria-labelledby={`${id}-heading`} data-testid="notifications" className="flex flex-col gap-3">
      <SectionHeading id={`${id}-heading`}>Notifications</SectionHeading>
      <Panel className="divide-y">
        <Row
          label={
            <span className="flex flex-wrap items-center gap-2">
              This device
              <StateWord tone={state === "on" ? "good" : "quiet"} testId="notifications-state" role="status">
                {state === null ? "Checking" : STATE_WORDS[state]}
              </StateWord>
            </span>
          }
          about={
            <>
              <About>Botbench tells this device when an approval is waiting or a task is ready for review. A notification says only that: never a command, code or a file.</About>
              {switchable && (
                <About id={`${id}-switch-about`} role={note ? "alert" : undefined} className={note ? "text-destructive" : undefined}>
                  {note ?? (state === "on" ? "Stop: this device stops being notified. Other devices keep their own setting." : "Allow: your browser asks whether Botbench may notify this device.")}
                </About>
              )}
            </>
          }
          control={
            switchable ? (
              <Busy aria-describedby={`${id}-switch-about`} busy={busy === "switch"} busyLabel={state === "on" ? "Stopping" : "Allowing"} disabled={busy === "test" || (state === "off" && key === null)} onClick={() => change(state === "off")}>
                {state === "on" ? "Stop notifications" : "Allow notifications"}
              </Busy>
            ) : undefined
          }
        />
        {state === "on" && (
          <Row
            label="Test"
            about={
              <About id={`${id}-test-about`} role={testNote ? "status" : undefined}>
                {testNote ?? "Sends one notification to this device, which opens Settings."}
              </About>
            }
            control={
              <Busy aria-describedby={`${id}-test-about`} busy={busy === "test"} busyLabel="Sending" disabled={busy === "switch"} onClick={test}>
                Send a test notification
              </Busy>
            }
          />
        )}
      </Panel>
    </section>
  );
}
