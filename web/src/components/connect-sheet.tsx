import { useEffect, useId, useRef, useState } from "react";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { ApiError, cancelConnect, disconnectAgent, getConnect, sendConnectCode, startConnect, type ConnectState } from "../api/client.ts";
import { ConfirmAction } from "./confirm.tsx";
import { CopyField } from "./decision.tsx";
import { Alert } from "./header.tsx";
import { Icon } from "./icon.tsx";

const active = (state: ConnectState["state"]): boolean => state === "starting" || state === "waiting" || state === "checking";
const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Where the link goes, as the reader can check it before following it: the host, and the path when it is short. */
function place(url: string): string {
  const { hostname, pathname } = new URL(url);
  return pathname.length > 1 && pathname.length <= 24 ? `${hostname}${pathname}` : hostname;
}

/** The code as issued, for a screen reader, and in its groups for the eye, with Copy code. */
export function DeviceCode({ code, testId = "connect-code" }: { code: string; testId?: string }) {
  const [copied, setCopied] = useState("");
  const copy = (): void => {
    // The clipboard is only there on a secure page (HTTPS, or this Mac itself) and may still refuse.
    const written = navigator.clipboard === undefined ? Promise.reject(new Error("no clipboard")) : navigator.clipboard.writeText(code);
    written.then(
      () => setCopied("Code copied"),
      () => setCopied("Not copied. Select the code and copy it by hand."),
    );
  };
  const groups = code.split("-");
  return (
    <div className="ds-device-code__entry">
      <p className="ds-device-code__code" data-testid={testId}>
        <span className="ds-visually-hidden">Code: {code}</span>
        <span aria-hidden="true">
          {groups.map((group, i) => (
            <span key={i}>
              {i > 0 && "-"}
              <span className="ds-device-code__group">{group}</span>
            </span>
          ))}
        </span>
      </p>
      <span className="ds-copy-button">
        <button type="button" className="ds-button ds-button--small" onClick={copy}>
          <Icon name="copy" className="ds-button__icon" />
          Copy code
        </button>
        <span className="ds-copy-button__status" role="status">
          {copied}
        </span>
      </span>
    </div>
  );
}

/** The field for the code the vendor's page shows after sign-in, which goes back to the agent waiting for it. */
function PasteCode({ driver, disabled, onState }: { driver: string; disabled: boolean; onState: (state: ConnectState) => void }) {
  const id = useId();
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = (): void => {
    if (sending) return;
    setSending(true);
    setProblem(null);
    sendConnectCode(driver, code).then(
      (state) => (setCode(""), onState(state)),
      (err: unknown) => setProblem(err instanceof ApiError ? err.message : "Botbench could not be reached. Check the connection and send the code again."),
    ).finally(() => setSending(false));
  };
  return (
    <form
      className="ds-stack ds-gap-sm"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="ds-field">
        <label className="ds-field__label" htmlFor={id}>
          Code from the sign-in page
        </label>
        <input className="ds-field__control" id={id} type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={code} disabled={disabled} aria-describedby={problem === null ? undefined : `${id}-error`} onChange={(e) => setCode(e.currentTarget.value)} />
        {problem !== null && (
          <p className="ds-field__error" id={`${id}-error`}>
            {problem}
          </p>
        )}
      </div>
      <div>
        <BusyButton type="submit" busy={sending} busyLabel="Sending" disabled={disabled || code.trim() === ""}>
          Send code
        </BusyButton>
      </div>
    </form>
  );
}

/**
 * Connect an agent (U26): Botbench runs the agent's own sign-in, and this sheet shows what it printed, the vendor's
 * page and its code, until the sign-in ends. Closing the sheet while it waits cancels the sign-in. `state` is the
 * sign-in as the server last reported it; `onState` takes a newer answer.
 */
export function ConnectSheet({ driver, product, state, onState, onClose }: { driver: string; product: string; state: ConnectState | null; onState: (state: ConnectState) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const flow = state?.state ?? "starting";

  const begin = (): void => {
    setProblem(null);
    startConnect(driver).then(onState, (err: unknown) => {
      const message = err instanceof ApiError ? err.message : "Botbench could not be reached. Check the connection and try again.";
      // A sign-in already under way (from a sheet closed too early, or another tab) is shown rather than refused.
      if (err instanceof ApiError && err.status === 409) getConnect(driver).then((current) => (active(current.state) ? onState(current) : setProblem(message)), () => setProblem(message));
      else setProblem(message);
    });
  };

  const started = useRef(false);
  useEffect(() => {
    if (dialog.current?.open === false) dialog.current.showModal();
    if (started.current) return;
    started.current = true;
    begin();
    // The sheet is drawn once per Connect press, and starts one sign-in.
  }, []);

  /** Closing while the sign-in waits stops it: nothing is left waiting for a page nobody has open. */
  const close = (): void => {
    if (state !== null && active(state.state)) {
      cancelConnect(driver).then(onState, () => {}).finally(onClose);
    } else onClose();
  };

  let body;
  if (problem !== null) {
    body = (
      <Alert tone="error" role="alert" title={`${product} could not be connected`} action={<button type="button" className="ds-button ds-button--small" onClick={begin}>Try again</button>}>
        {problem}
      </Alert>
    );
  } else if (flow === "cancelled") {
    body = (
      <Alert tone="note" role="status" title="The sign-in was stopped" action={<button type="button" className="ds-button ds-button--small" onClick={begin}>Try again</button>}>
        Nothing was connected.
      </Alert>
    );
  } else if (state === null || flow === "starting" || flow === "idle") {
    body = (
      <p className="ds-spinner" role="status">
        Asking {product} for a sign-in link
      </p>
    );
  } else if (flow === "succeeded") {
    body = (
      <div className="ds-alert ds-alert--success" role="status" data-testid="connect-result">
        <div className="ds-alert__content">
          <p className="ds-alert__label">Done</p>
          <p className="ds-alert__title">{product} is connected</p>
          <p className="ds-alert__body">It is signed in on this Mac and ready to use.</p>
        </div>
      </div>
    );
  } else if (flow === "failed") {
    body = (
      <div data-testid="connect-result">
        <Alert tone="error" role="alert" title={`${product} was not connected`} action={<button type="button" className="ds-button ds-button--small" onClick={begin}>Try again</button>}>
          {state.reason ?? "The sign-in ended without signing in."}
        </Alert>
      </div>
    );
  } else {
    const url = state.url!;
    body = (
      <div className="ds-device-code" data-testid="connect-waiting">
        <ol className="ds-device-code__steps">
          <li className="ds-device-code__step">
            <p>
              Open the sign-in page at <span data-ds-content="">{place(url)}</span> on this device or another one, and sign in.
              {state.keptByBotbench && ` This is a sign-in for Botbench alone: ${product} in a terminal or its app keeps its own.`}
            </p>
          </li>
          {state.code !== null && (
            <li className="ds-device-code__step">
              <p>Enter this code there:</p>
              <DeviceCode code={state.code} />
            </li>
          )}
          {state.takesCode ? (
            <li className="ds-device-code__step">
              <p>{state.keptByBotbench ? "The page then shows a code. Copy it, or the page's whole address, and paste it here." : "The page then shows a code. Copy it and paste it here."}</p>
              <PasteCode driver={driver} disabled={flow !== "waiting"} onState={onState} />
            </li>
          ) : (
            <li className="ds-device-code__step">
              <p>Approve on that page, then come back here. This view updates by itself.</p>
            </li>
          )}
        </ol>
        <div className="ds-device-code__status">
          <p className="ds-spinner" role="status">
            {flow === "checking" ? `Checking the sign-in with ${product}` : "Waiting for you to sign in"}
          </p>
          {state.expiresAt !== null && <p className="ds-device-code__note">Botbench stops waiting at {timeOf(state.expiresAt)}.</p>}
        </div>
      </div>
    );
  }

  const waitingUrl = state !== null && active(state.state) ? state.url : null;
  return (
    <dialog
      ref={dialog}
      className="ds-sheet"
      data-testid="connect-sheet"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="ds-sheet__header">
        <h2 className="ds-sheet__title" id={titleId}>
          Connect {product}
        </h2>
        <button type="button" className="ds-button ds-button--quiet" aria-label={`Close Connect ${product}`} onClick={close}>
          <Icon name="x" className="ds-button__icon" />
        </button>
      </div>
      <div className="ds-sheet__body">{body}</div>
      <div className="ds-sheet__footer">
        {waitingUrl !== null && (
          <a className="ds-button ds-button--primary" href={waitingUrl} target="_blank" rel="noopener noreferrer">
            Open sign-in page
          </a>
        )}
        {state !== null && active(state.state) ? (
          <button type="button" className="ds-button" onClick={close}>
            Cancel connecting
          </button>
        ) : (
          <button type="button" className="ds-button" onClick={onClose}>
            {flow === "succeeded" ? "Done" : "Close"}
          </button>
        )}
      </div>
    </dialog>
  );
}

/**
 * Connect or Disconnect, in an agent's row of Settings. Connect is offered while the agent is installed, a version
 * Botbench can drive, and signed out; Disconnect, behind a confirmation, while it is signed in. Neither is drawn for
 * an agent Botbench cannot run a sign-in for. An agent whose sign-in can only be finished on the Mac shows the command.
 * `onChanged` is called when the agent may have signed in or out, so the row reads it again.
 */
export function AgentConnection({ agent, product, installed, supported, signedIn, version, onChanged }: { agent: string; product: string; installed: boolean; supported: boolean; signedIn: boolean; version: number; onChanged: () => void }) {
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read again whenever the row is (`version`): a sign-in that moved on, here or in another tab, is told over the live updates.
  useEffect(() => {
    getConnect(agent).then(setConnect, () => setConnect(null));
  }, [agent, version]);

  const sheet = open && connect !== null && (
    <ConnectSheet
      driver={agent}
      product={product}
      state={connect.state === "idle" ? null : connect}
      onState={setConnect}
      onClose={() => {
        setOpen(false);
        onChanged();
      }}
    />
  );
  // The sheet stays open over the row's change, so its result is read where it was started.
  if (connect === null || !installed || !supported) return sheet || null;
  const disconnect = (): void => {
    setBusy(true);
    setProblem(null);
    disconnectAgent(agent)
      .then(onChanged, (err: unknown) => setProblem(err instanceof ApiError ? err.message : "Botbench could not be reached. Check the connection and try again."))
      .finally(() => setBusy(false));
  };
  if (signedIn) {
    return (
      <>
        <ConfirmAction label="Disconnect" opener={{ small: true, name: `Disconnect ${product}`, object: product }} title={`Disconnect ${product}?`} confirmLabel="Disconnect" cancelLabel="Keep connected" disabled={false} busy={busy} busyLabel="Disconnecting" losing testId={`disconnect-${agent}`} onConfirm={disconnect}>
          {connect.keptByBotbench ? (
            <>Botbench removes the sign-in it keeps for {product} in its own folder. {product} is then not connected in Botbench until you connect it again. {product} in a terminal or its app, signed in on its own, is not changed.</>
          ) : (
            <>
              Botbench runs <code data-ds-content="">{connect.signOutCommand}</code>, {product}'s own sign-out. It is then signed out on this Mac, in a terminal too, until it is connected again.
            </>
          )}
        </ConfirmAction>
        {problem !== null && (
          <p className="ds-field__error" role="alert">
            {problem}
          </p>
        )}
        {sheet}
      </>
    );
  }
  if (connect.kind === "on-the-mac") {
    return (
      <div className="ds-stack ds-gap-sm">
        <p>Sign in on the Mac: run this in a terminal there.</p>
        <CopyField label="Command" value={connect.terminalCommand} testId={`sign-in-command-${agent}`} buttonName="Copy command" />
      </div>
    );
  }
  return (
    <>
      <button type="button" className="ds-button ds-button--small" aria-label={`Connect ${product}`} onClick={() => (setConnect({ ...connect, state: "idle", url: null, code: null, expiresAt: null, reason: null }), setOpen(true))}>
        Connect
      </button>
      {sheet}
    </>
  );
}
