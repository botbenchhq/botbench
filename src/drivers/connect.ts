import os from "node:os";
import type { DriverProbe } from "./contract.ts";
import { killProcessGroup, launch, runCli, type CliChild } from "./launch.ts";
import { pastedCode, signInFailure, type SignInDefinition, type SignInKind, type SignInPrompt } from "./sign-in.ts";

/*
 * Connecting an agent from Settings (U26): one sign-in process per agent at a time, started through `launch` with the
 * same environment rules as a turn, its link and code held in this process's memory only and dropped when it ends.
 * Nothing of a sign-in is written to the database, the event log or Botbench's own log. Success is the CLI ending
 * with exit 0 and its probe then reporting it signed in; Botbench reads no output of the CLI to decide it.
 */

/** Where a sign-in stands. "checking": the code the owner pasted went to the CLI, or the CLI ended and is being probed. */
export type FlowState = "starting" | "waiting" | "checking" | "succeeded" | "failed" | "cancelled";

/** What the client is shown of an agent's sign-in. The link and code are present only while it waits. */
export interface FlowView {
  driver: string;
  kind: SignInKind;
  /** The sign-in as the owner would run it in a terminal on the Mac. */
  terminalCommand: string;
  /** The CLI's own sign-out, as Disconnect runs it. Empty when Botbench keeps the sign-in (`keptByBotbench`). */
  signOutCommand: string;
  /** The sign-in is kept in Botbench's own folder, apart from the CLI's in a terminal: Disconnect removes it there. */
  keptByBotbench: boolean;
  /** The CLI waits for the code the vendor's page shows, pasted back. */
  takesCode: boolean;
  state: FlowState | "idle";
  url: string | null;
  code: string | null;
  /** When Botbench stops waiting, as an ISO time. */
  expiresAt: string | null;
  /** Why it failed, in the CLI's own words where it gave them. */
  reason: string | null;
}

/** Refused, with the HTTP status that says why. */
export class ConnectError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConnectError";
    this.status = status;
  }
}

/** An agent that can be connected: its CLI's sign-in, and the probe that says whether it is now signed in. */
export interface ConnectableAgent {
  signIn: SignInDefinition;
  probe(): Promise<DriverProbe>;
}

export interface ConnectOptions {
  agents: readonly ConnectableAgent[];
  /** Called when an agent's sign-in changed state, or it was signed out. Carries no link and no code. */
  onChange?(driver: string, state: FlowState | "signed-out"): void;
  /** How long the CLI has to print its link and code. */
  startLimitMs?: number;
}

export interface Connect {
  /** The agent's sign-in as it stands. */
  view(driver: string): FlowView;
  /** Start the CLI's sign-in. Resolves once it has printed its link (and code), or has ended. 409 while one runs. */
  start(driver: string): Promise<FlowView>;
  /** Hand the code the vendor's page showed to the CLI waiting for it. */
  sendCode(driver: string, code: unknown): FlowView;
  /** Stop the sign-in and its whole process group. */
  cancel(driver: string): Promise<FlowView>;
  /** Run the CLI's own sign-out, then probe again. 409 while a sign-in runs. */
  signOut(driver: string): Promise<DriverProbe>;
  /** Stop every sign-in. */
  close(): Promise<void>;
}

const START_LIMIT_MS = 30_000;
const SIGN_OUT_LIMIT_MS = 30_000;
/** More than any sign-in prints; output beyond it is not kept. */
const MAX_OUTPUT = 64 * 1024;

interface Flow {
  agent: ConnectableAgent;
  state: FlowState;
  prompt: SignInPrompt | null;
  expiresAt: string | null;
  reason: string | null;
  child: CliChild | null;
  pgid: number;
  timers: NodeJS.Timeout[];
  /** Settles once the process has closed and the end is recorded. */
  ended: Promise<void>;
}

const active = (state: FlowState): boolean => state === "starting" || state === "waiting" || state === "checking";
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} minutes`;

export function createConnect(options: ConnectOptions): Connect {
  const agents = new Map(options.agents.map((agent) => [agent.signIn.driver, agent]));
  const flows = new Map<string, Flow>();
  const signingOut = new Set<string>();
  const startLimitMs = options.startLimitMs ?? START_LIMIT_MS;

  const agentOf = (driver: string): ConnectableAgent => {
    const agent = agents.get(driver);
    if (agent === undefined) throw new ConnectError(404, "Botbench cannot connect that agent.");
    return agent;
  };

  const viewOf = (agent: ConnectableAgent, flow: Flow | undefined): FlowView => {
    const { signIn } = agent;
    const waiting = flow !== undefined && active(flow.state);
    return {
      driver: signIn.driver,
      kind: signIn.kind,
      terminalCommand: signIn.terminalCommand,
      signOutCommand: signIn.signOutCommand,
      keptByBotbench: signIn.keptByBotbench === true,
      takesCode: signIn.takesCode,
      state: flow?.state ?? "idle",
      url: waiting ? (flow.prompt?.url ?? null) : null,
      code: waiting ? (flow.prompt?.code ?? null) : null,
      expiresAt: waiting ? flow.expiresAt : null,
      reason: flow?.reason ?? null,
    };
  };

  const changed = (driver: string, state: FlowState | "signed-out"): void => options.onChange?.(driver, state);

  /** Record how the sign-in ended, once: a later end (a timer, the process closing) changes nothing. */
  const finish = (flow: Flow, state: "succeeded" | "failed" | "cancelled", reason: string | null = null): void => {
    if (!active(flow.state)) return;
    flow.state = state;
    flow.reason = reason;
    flow.prompt = null;
    for (const timer of flow.timers) clearTimeout(timer);
    changed(flow.agent.signIn.driver, state);
  };

  const stopGroup = (flow: Flow): Promise<void> => (flow.pgid ? killProcessGroup(flow.pgid, { graceMs: 1000 }).catch(() => {}) : Promise.resolve());

  const start = async (driver: string): Promise<FlowView> => {
    const agent = agentOf(driver);
    const { signIn } = agent;
    if (signIn.kind === "on-the-mac") throw new ConnectError(409, `${signIn.product} can only be signed in on the Mac itself. Run \`${signIn.terminalCommand}\` in a terminal there.`);
    const current = flows.get(driver);
    if ((current !== undefined && active(current.state)) || signingOut.has(driver)) throw new ConnectError(409, `${signIn.product} is already being connected or disconnected. Finish or cancel that first.`);

    let shown: () => void = () => {};
    const printed = new Promise<void>((resolve) => (shown = resolve));
    let closed: () => void = () => {};
    const flow: Flow = { agent, state: "starting", prompt: null, expiresAt: null, reason: null, child: null, pgid: 0, timers: [], ended: new Promise<void>((resolve) => (closed = resolve)) };
    flows.set(driver, flow);
    changed(driver, "starting");

    const { child, pgid } = launch(signIn.command, signIn.args, { cwd: os.tmpdir(), extraEnv: { ...signIn.env } });
    flow.child = child;
    flow.pgid = pgid;
    let stdout = "";
    let stderr = "";
    let startError = false;
    const read = (): void => {
      if (flow.state !== "starting") return;
      const prompt = signIn.parse(stdout + stderr);
      if (prompt === null) return;
      flow.prompt = prompt;
      flow.state = "waiting";
      flow.expiresAt = new Date(Date.now() + signIn.limitMs).toISOString();
      changed(driver, "waiting");
      shown();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
      read();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
      read();
    });
    child.stdin.on("error", () => {});
    child.on("error", () => (startError = true));
    child.on("close", (exitCode) => {
      void (async () => {
        // Whatever the process left in its group goes with it.
        await stopGroup(flow);
        if (active(flow.state)) {
          if (startError) finish(flow, "failed", `${signIn.product} could not be started. Check that \`${signIn.command}\` is installed and on the PATH.`);
          else if (exitCode === 0) {
            flow.state = "checking";
            changed(driver, "checking");
            let probe: DriverProbe | null = null;
            try {
              probe = await agent.probe();
            } catch {
              probe = null;
            }
            if (probe?.signedIn === true) finish(flow, "succeeded");
            else finish(flow, "failed", probe === null ? `${signIn.product} finished signing in, but could not be checked afterwards.` : `${signIn.product} finished, but still says it is signed out.`);
          } else {
            const secrets = [flow.prompt?.url ?? "", flow.prompt?.code ?? ""];
            finish(flow, "failed", signInFailure(stdout, stderr, secrets) ?? `${signIn.product} stopped without signing in.`);
          }
        }
        stdout = "";
        stderr = "";
        flow.child = null;
        shown();
        closed();
      })();
    });

    flow.timers.push(
      setTimeout(() => {
        if (flow.state !== "starting") return;
        finish(flow, "failed", `${signIn.product} did not give a sign-in link within ${Math.round(startLimitMs / 1000)} seconds. ${signIn.keptByBotbench === true ? "Try again." : `Try again, or run \`${signIn.terminalCommand}\` in a terminal on the Mac.`}`);
        void stopGroup(flow);
        shown();
      }, startLimitMs),
      setTimeout(() => {
        if (!active(flow.state)) return;
        finish(flow, "failed", `The sign-in was not finished within ${minutes(signIn.limitMs)}, so Botbench stopped it. Connect again for a new link.`);
        void stopGroup(flow);
      }, signIn.limitMs),
    );
    for (const timer of flow.timers) timer.unref();

    await printed;
    return viewOf(agent, flow);
  };

  const sendCode = (driver: string, value: unknown): FlowView => {
    const agent = agentOf(driver);
    const flow = flows.get(driver);
    if (!agent.signIn.takesCode) throw new ConnectError(409, `${agent.signIn.product} does not take a code back. Enter its code on the vendor's page.`);
    if (flow === undefined || flow.state !== "waiting" || flow.child === null) throw new ConnectError(409, `${agent.signIn.product} is not waiting for a code. Connect again.`);
    const code = (agent.signIn.pasted ?? pastedCode)(value);
    if (code === null) throw new ConnectError(400, "That is not a code from the sign-in page. Copy the whole code the page shows and paste it on one line.");
    // The code goes to the CLI and nowhere else: it is not kept here.
    flow.child.stdin.write(`${code}\n`);
    flow.state = "checking";
    changed(driver, "checking");
    return viewOf(agent, flow);
  };

  const cancel = async (driver: string): Promise<FlowView> => {
    const agent = agentOf(driver);
    const flow = flows.get(driver);
    if (flow === undefined || !active(flow.state)) throw new ConnectError(409, `No sign-in of ${agent.signIn.product} is under way.`);
    finish(flow, "cancelled");
    await stopGroup(flow);
    if (flow.child !== null) await flow.ended;
    return viewOf(agent, flow);
  };

  const signOut = async (driver: string): Promise<DriverProbe> => {
    const agent = agentOf(driver);
    const { signIn } = agent;
    const flow = flows.get(driver);
    if ((flow !== undefined && active(flow.state)) || signingOut.has(driver)) throw new ConnectError(409, `${signIn.product} is being connected or disconnected. Finish or cancel that first.`);
    signingOut.add(driver);
    try {
      if (signIn.removeSignIn !== undefined) {
        // A sign-in Botbench keeps in its own folder: its file is removed there, unread. No sign-in is running (checked above).
        try {
          signIn.removeSignIn();
        } catch (err) {
          throw new ConnectError(500, `Botbench could not remove ${signIn.product}'s sign-in from its folder: ${err instanceof Error ? err.message : String(err)}`);
        }
        flows.delete(driver);
        changed(driver, "signed-out");
        return await agent.probe();
      }
      const run = await runCli(signIn.command, signIn.signOutArgs, { cwd: os.tmpdir(), extraEnv: { ...signIn.env }, timeoutMs: SIGN_OUT_LIMIT_MS });
      if (!run.started) throw new ConnectError(502, `${signIn.product} could not be started. Check that \`${signIn.command}\` is installed and on the PATH.`);
      if (run.exitCode !== 0) throw new ConnectError(502, signInFailure(run.stdout, run.stderr, []) ?? `${signIn.product} could not sign out.`);
      flows.delete(driver);
      changed(driver, "signed-out");
      return await agent.probe();
    } finally {
      signingOut.delete(driver);
    }
  };

  const close = async (): Promise<void> => {
    await Promise.all(
      [...flows.values()].filter((flow) => active(flow.state)).map(async (flow) => {
        finish(flow, "cancelled");
        await stopGroup(flow);
        if (flow.child !== null) await flow.ended;
      }),
    );
  };

  return { view: (driver) => viewOf(agentOf(driver), flows.get(driver)), start, sendCode, cancel, signOut, close };
}
