import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button, buttonVariants } from "@/ui/button";
import { Input } from "@/ui/input";
import { cn } from "@/ui/lib/utils";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/ui/sheet";
import { ApiError, cancelConnect, disconnectAgent, getAgentsAndCap, getConnect, getFallbacks, openEventStream, sendConnectCode, setFallbacks, startConnect, type AgentState, type ConnectState, type FallbackSetting } from "../../api/client.ts";
import { agentName, agentState } from "../../app/chat.ts";
import { clock } from "../../app/format.ts";
import { FALLBACK_ABOUT, FALLBACK_LABEL, fallbackOrders, orderWords } from "../../app/handoff-words.ts";
import { CopyField, DeviceCode } from "./codes.tsx";
import { About, Busy, Confirm, FieldLabel, More, Note, Panel, Reading, SectionHeading, Select, StateWord } from "./parts.tsx";

/** The agents Botbench drives, in the order it lists them. */
export const AGENTS = [
  { agent: "claude-code", name: "Claude Code" },
  { agent: "codex", name: "Codex" },
  { agent: "grok", name: "Grok" },
  { agent: "antigravity", name: "Antigravity" },
];

/** What Botbench lets the agent do, in words, from the steps the server reports. */
function agentSteps(agent: AgentState): string {
  const plans = agent.roles.includes("planner");
  const builds = agent.roles.includes("builder");
  const reviews = agent.roles.includes("reviewer");
  return plans && builds ? "Plans and builds tasks." : builds && reviews ? "Builds a task or a run's tasks when you choose it under Builder, and reviews a run's tasks when you choose it for a run; it does not plan." : reviews ? "Reviews a run's tasks when you choose it for a run; it cannot plan or build here." : "";
}

/** What the check found, in a sentence: the version and the kind of sign-in when it can be used, else what is wrong. */
function agentAbout(agent: AgentState): string {
  if (agent.problem !== null) return agent.problem;
  const signIn = agent.billing === "subscription" ? "Signed in with a subscription." : agent.billing === "metered" ? "Signed in, billed by use." : "Signed in.";
  return `${agent.version === null ? "" : `Version ${agent.version}. `}${signIn}`;
}

const active = (state: ConnectState["state"]): boolean => state === "starting" || state === "waiting" || state === "checking";

/** Where the link goes, as the reader can check it before following it: the host, and the path when it is short. */
function place(url: string): string {
  const { hostname, pathname } = new URL(url);
  return pathname.length > 1 && pathname.length <= 24 ? `${hostname}${pathname}` : hostname;
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
    sendConnectCode(driver, code)
      .then(
        (state) => (setCode(""), onState(state)),
        (err: unknown) => setProblem(err instanceof ApiError ? err.message : "Botbench could not be reached. Check the connection and send the code again."),
      )
      .finally(() => setSending(false));
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <FieldLabel htmlFor={id}>Code from the sign-in page</FieldLabel>
      <Input id={id} type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={code} disabled={disabled} aria-describedby={problem === null ? undefined : `${id}-error`} onChange={(e) => setCode(e.currentTarget.value)} />
      {problem !== null && (
        <p id={`${id}-error`} className="text-meta text-destructive">
          {problem}
        </p>
      )}
      <div>
        <Busy type="submit" busy={sending} busyLabel="Sending" disabled={disabled || code.trim() === ""}>
          Send code
        </Busy>
      </div>
    </form>
  );
}

/**
 * Connect an agent: Botbench runs the agent's own sign-in, and this sheet shows what it printed, the vendor's page and
 * its code, until the sign-in ends. Closing the sheet while it waits cancels the sign-in. `state` is the sign-in as the
 * server last reported it; `onState` takes a newer answer. The credentials stay with the agent's own program.
 */
function ConnectSheet({ driver, product, state, onState, onClose }: { driver: string; product: string; state: ConnectState | null; onState: (state: ConnectState) => void; onClose: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const flow = state?.state ?? "starting";

  const begin = (): void => {
    setProblem(null);
    startConnect(driver).then(onState, (err: unknown) => {
      const message = err instanceof ApiError ? err.message : "Botbench could not be reached. Check the connection and try again.";
      // A sign-in already under way (from a sheet closed too early, or another tab) is shown, not refused.
      if (err instanceof ApiError && err.status === 409) getConnect(driver).then((current) => (active(current.state) ? onState(current) : setProblem(message)), () => setProblem(message));
      else setProblem(message);
    });
  };

  // The sheet is drawn once per Connect press, and starts one sign-in.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin();
  }, []);

  /** Closing while the sign-in waits stops it: nothing is left waiting for a page nobody has open. */
  const close = (): void => {
    if (state !== null && active(state.state)) cancelConnect(driver).then(onState, () => {}).finally(onClose);
    else onClose();
  };

  const again = (
    <Button type="button" variant="outline" size="sm" onClick={begin}>
      Try again
    </Button>
  );
  let body;
  if (problem !== null) {
    body = (
      <Note tone="error" role="alert" title={`${product} could not be connected`} action={again}>
        {problem}
      </Note>
    );
  } else if (flow === "cancelled") {
    body = (
      <Note tone="note" role="status" title="The sign-in was stopped" action={again}>
        Nothing was connected.
      </Note>
    );
  } else if (state === null || flow === "starting" || flow === "idle") {
    body = <Reading>{`Asking ${product} for a sign-in link`}</Reading>;
  } else if (flow === "succeeded") {
    body = (
      <Note tone="success" role="status" title={`${product} is connected`} testId="connect-result">
        It is signed in on this Mac and ready to use.
      </Note>
    );
  } else if (flow === "failed") {
    body = (
      <div data-testid="connect-result">
        <Note tone="error" role="alert" title={`${product} was not connected`} action={again}>
          {state.reason ?? "The sign-in ended without signing in."}
        </Note>
      </div>
    );
  } else {
    const url = state.url!;
    body = (
      <div data-testid="connect-waiting" className="flex flex-col gap-4">
        <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
          <li>
            <p>
              Open the sign-in page at <span data-ds-content="">{place(url)}</span> on this device or another one, and sign in.
              {state.keptByBotbench && ` This is a sign-in for Botbench alone: ${product} in a terminal or its app keeps its own.`}
            </p>
          </li>
          {state.code !== null && (
            <li>
              <p className="pb-2">Enter this code there:</p>
              <DeviceCode code={state.code} />
            </li>
          )}
          {state.takesCode ? (
            <li>
              <p className="pb-2">{state.keptByBotbench ? "The page then shows a code. Copy it, or the page's whole address, and paste it here." : "The page then shows a code. Copy it and paste it here."}</p>
              <PasteCode driver={driver} disabled={flow !== "waiting"} onState={onState} />
            </li>
          ) : (
            <li>
              <p>Approve on that page, then come back here. This view updates by itself.</p>
            </li>
          )}
        </ol>
        <Reading>{flow === "checking" ? `Checking the sign-in with ${product}` : "Waiting for you to sign in"}</Reading>
        {state.expiresAt !== null && <About>{`Botbench stops waiting at ${clock(state.expiresAt)}.`}</About>}
      </div>
    );
  }

  const waitingUrl = state !== null && active(state.state) ? state.url : null;
  return (
    <Sheet open onOpenChange={(open) => open || close()}>
      <SheetContent data-testid="connect-sheet" showCloseButton={false} className="w-full gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="p-5">
          <SheetTitle className="text-heading font-semibold">{`Connect ${product}`}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-5">{body}</div>
        <SheetFooter className="p-5">
          {waitingUrl !== null && (
            <a data-testid="connect-open" href={waitingUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants())}>
              Open sign-in page
            </a>
          )}
          {state !== null && active(state.state) ? (
            <Button type="button" variant="outline" onClick={close}>
              Cancel connecting
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={onClose}>
              {flow === "succeeded" ? "Done" : "Close"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Connect or Disconnect, in an agent's card. Connect is offered while the agent is installed, a version Botbench can
 * drive, and signed out; Disconnect, behind a confirmation, while it is signed in. Neither is drawn for an agent
 * Botbench cannot run a sign-in for. An agent whose sign-in can only be finished on the Mac shows the command.
 * `onChanged` is called when the agent may have signed in or out, so the card reads it again.
 */
function AgentConnection({ agent, product, installed, supported, signedIn, version, onChanged }: { agent: string; product: string; installed: boolean; supported: boolean; signedIn: boolean; version: number; onChanged: () => void }) {
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read again whenever the card is (`version`): a sign-in that moved on, here or in another tab, is told over the live updates.
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
  // The sheet stays open over the card's change, so its result is read where it was started.
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
        <Confirm label="Disconnect" size="sm" opener={{ name: `Disconnect ${product}`, object: product }} title={`Disconnect ${product}?`} confirmLabel="Disconnect" cancelLabel="Keep connected" disabled={false} busy={busy} busyLabel="Disconnecting" losing testId={`disconnect-${agent}`} onConfirm={disconnect}>
          {connect.keptByBotbench ? (
            <p>{`Botbench removes the sign-in it keeps for ${product} in its own folder. ${product} is then not connected in Botbench until you connect it again. ${product} in a terminal or its app, signed in on its own, is not changed.`}</p>
          ) : (
            <p>
              Botbench runs <code data-ds-content="">{connect.signOutCommand}</code>, {product}'s own sign-out. It is then signed out on this Mac, in a terminal too, until it is connected again.
            </p>
          )}
        </Confirm>
        {problem !== null && (
          <p role="alert" className="basis-full text-meta text-destructive">
            {problem}
          </p>
        )}
        {sheet}
      </>
    );
  }
  if (connect.kind === "on-the-mac") {
    return (
      <div className="flex basis-full flex-col gap-2 text-sm">
        <p>Sign in on the Mac: run this in a terminal there.</p>
        <CopyField label="Command" value={connect.terminalCommand} testId={`sign-in-command-${agent}`} buttonName="Copy command" />
      </div>
    );
  }
  return (
    <>
      <Button type="button" size="sm" aria-label={`Connect ${product}`} onClick={() => (setConnect({ ...connect, state: "idle", url: null, code: null, expiresAt: null, reason: null }), setOpen(true))}>
        Connect
      </Button>
      {sheet}
    </>
  );
}

/**
 * The builder's fallback list (src/engine/handoff.ts): the agents a run set to Switch moves a task to when its builder
 * reaches its usage limit, in order. Stored by Botbench and kept across restarts; offered as each order of the agents
 * that can build here.
 */
function FallbackList({ onSignedOut }: { onSignedOut: () => void }) {
  const id = useId();
  const [value, setValue] = useState<FallbackSetting | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The last choice reached Botbench: said under the row, since a select shows the choice before it is kept.
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    getFallbacks().then(setValue, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(err instanceof ApiError ? `The list of agents to switch to could not be read. ${err.message}` : "The list of agents to switch to could not be read: Botbench could not be reached.");
    });
  }, [onSignedOut]);
  const choose = (list: string[]): void => {
    const before = value;
    if (before !== null) setValue({ ...before, list });
    setProblem(null);
    setSaved(false);
    setFallbacks(list).then(
      (kept) => {
        setValue(kept);
        setSaved(true);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setValue(before);
        setProblem(err instanceof ApiError ? `The list of agents to switch to was not saved. ${err.message}` : "The list of agents to switch to was not saved: Botbench could not be reached.");
      },
    );
  };
  const orders = value === null ? [] : fallbackOrders(value.agents);
  const current = value === null ? "" : value.list.join(",");
  return (
    <Panel data-testid="fallbacks" className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel htmlFor={`${id}-fallbacks`} className="text-base">
            {FALLBACK_LABEL}
          </FieldLabel>
          <About id={`${id}-fallbacks-about`}>Tried in this order, in a run you set to Switch to the next agent.</About>
          <More about={FALLBACK_LABEL}>
            <p>{FALLBACK_ABOUT}</p>
          </More>
          {saved && problem === null && (
            <About role="status" data-testid="fallbacks-saved">
              Saved.
            </About>
          )}
        </div>
        <Select data-testid="fallback-list" id={`${id}-fallbacks`} value={current} disabled={value === null} aria-describedby={`${id}-fallbacks-about`} onChange={(e) => choose(e.currentTarget.value.split(","))} className="w-full shrink-0 sm:w-64">
          {value === null && <option value="">Checking</option>}
          {orders.map((order) => (
            <option key={order.join(",")} value={order.join(",")}>
              {orderWords(order)}
            </option>
          ))}
        </Select>
      </div>
      {value !== null && value.list.length > 0 && (
        <ol data-testid="fallback-order" aria-label="The order now" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4 text-sm">
          {value.list.map((agent, i) => (
            <li key={agent} className="flex items-center gap-2">
              <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary">
                {i + 1}
              </span>
              <span className="font-semibold">{agentName(agent)}</span>
              <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground" />
            </li>
          ))}
          <li className="text-muted-foreground">With no agent left to take it, the task waits for the limit to reset.</li>
        </ol>
      )}
      {problem !== null && (
        <Note tone="error" role="alert">
          {problem}
        </Note>
      )}
    </Panel>
  );
}

/**
 * Agents and models: each agent Botbench can drive, as its own program reports itself now (its state as a word, one
 * line of what the check found and what it does here, and Connect or Disconnect), then the order agents are tried in
 * when a builder reaches its usage limit. `focusHeading`: opened from the home screen's "Connect an agent", the
 * section's heading takes the focus.
 */
export function AgentsGroup({ onSignedOut }: { onSignedOut: () => void }) {
  const [agents, setAgents] = useState<AgentState[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** How often the agents were read: each card's Connect reads its sign-in again with them. */
  const [version, setVersion] = useState(0);

  const refresh = useCallback((): void => {
    // Settings shows each agent's state as it is now, after a sign-in or sign-out too.
    setChecking(true);
    getAgentsAndCap(true)
      .then(
        (found) => {
          setAgents(found.agents);
          setCheckedAt(found.checkedAt);
          setProblem(null);
          setVersion((v) => v + 1);
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
          setProblem(err instanceof ApiError ? `The agents could not be checked. ${err.message}` : "The agents could not be checked: Botbench could not be reached.");
        },
      )
      .finally(() => setChecking(false));
  }, [onSignedOut]);

  useEffect(() => {
    refresh();
    // An agent connected or disconnected, here or in another tab, is told over the live updates; the agents are then read again.
    return openEventStream(0, { onEvent: () => {}, onConnection: () => {}, onSignedOut, onAgent: (a) => a.state !== "starting" && a.state !== "waiting" && refresh() });
  }, [refresh, onSignedOut]);

  const usable = agents?.filter((a) => a.problem === null).length ?? null;
  return (
    <>
      <section aria-labelledby="settings-agents" className="flex flex-col gap-4">
        <SectionHeading
          id="settings-agents"
          right={
            <div className="flex flex-wrap items-center gap-3">
              {checkedAt !== null && <About data-testid="agents-checked">{`Checked at ${clock(checkedAt)}`}</About>}
              <Busy size="sm" busy={checking && agents !== null} busyLabel="Checking" onClick={refresh}>
                Check again
              </Busy>
            </div>
          }
        >
          Connection health
        </SectionHeading>
        {usable !== null && agents !== null && <p data-testid="agents-summary" className="text-sm text-muted-foreground">{`${usable} of ${agents.length} agents can take work now.`}</p>}
        <div data-testid="agents" className="grid gap-4 md:grid-cols-2">
          {AGENTS.map(({ agent: key, name }) => {
            const agent = agents?.find((found) => found.agent === key) ?? null;
            const state = agent !== null ? agentState(agent) : problem !== null ? "Could not be checked" : agents === null ? "Checking" : "Not offered";
            return (
              <Panel key={key} data-testid={`agent-${key}`} className="flex flex-col gap-3 p-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-base font-semibold">{name}</h3>
                  <StateWord tone={state === "Available" ? "good" : state === "Signed out" ? "attention" : "quiet"} testId="agent-state" role="status">
                    {state}
                  </StateWord>
                </div>
                <p className="text-meta text-muted-foreground">{agent !== null ? `${agentAbout(agent)} ${agentSteps(agent)}`.trim() : (problem ?? (agents === null ? `Checking ${name}.` : `${name} is not offered by this Botbench.`))}</p>
                {agent !== null && (
                  <div className="mt-auto flex flex-wrap items-center justify-end gap-2">
                    <AgentConnection agent={key} product={name} installed={agent.installed} supported={agent.supported} signedIn={agent.signedIn} version={version} onChanged={refresh} />
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      </section>
      <FallbackList onSignedOut={onSignedOut} />
    </>
  );
}
