import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createAuth, loadOrCreateLoginToken, LOGIN_TOKEN_FILE } from "./api/auth.ts";
import { json, requestUrl, route } from "./api/router.ts";
import { createEventStream } from "./api/stream.ts";
import { createTurns } from "./api/turns.ts";
import { createBroker, type Broker } from "./approvals/broker.ts";
import { DEFAULT_CONFIG_FILE, dataHomes, envSetting, floorEntries, loadConfig, localConfigFile, maxRefineRounds, offerStandingAfter, repositoryCommands, repositoryHosts, ROOT, type Config, type Log } from "./config.ts";
import { CLAUDE_CODE, ClaudeCodeDriver } from "./drivers/claude-code.ts";
import { ANTIGRAVITY, AntigravityDriver } from "./drivers/antigravity.ts";
import { CODEX, CodexDriver } from "./drivers/codex.ts";
import { createConnect } from "./drivers/connect.ts";
import type { SignInDefinition } from "./drivers/sign-in.ts";
import { removeLeftoverReviewFolders } from "./drivers/cli-sandbox.ts";
import type { Driver } from "./drivers/contract.ts";
import { GROK, GrokDriver } from "./drivers/grok.ts";
import { IMPLEMENTER, PLANNER, roleModel } from "./engine/roles.ts";
import { defaultMode } from "./engine/modes.ts";
import { createDictation, type DictationOptions } from "./dictation/dictation.ts";
import { createDeliveries } from "./engine/delivery.ts";
import { createRuns } from "./engine/run.ts";
import { createGitHub, type GitHub } from "./github.ts";
import { createTasks } from "./engine/task.ts";
import { createPush, type Push } from "./push.ts";
import { openStore } from "./store/db.ts";
import { moveOldHome } from "./store/move-home.ts";

export interface BotbenchServer {
  /** The port actually bound, which differs from the configured one when that is 0. */
  port: number;
  addresses: string[];
  db: DatabaseSync;
  /** The permission broker every task's requests wait in. */
  broker: Broker;
  /** Notifications to the owner's devices. */
  push: Push;
  /** The owner's login token, present only on the start that created it, so the entry point can show it once. */
  newLoginToken?: string;
  /** How many clients have the event stream open. */
  streamClients(): number;
  /** Stop listening, drop open connections, stop every CLI process and close the database. Safe to call twice. */
  close(): Promise<void>;
}

function listen(server: http.Server, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function stop(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export interface StartOptions {
  config: Config;
  home: string;
  signInDelayMs?: number;
  /** The built client; `web/dist` in this checkout when left out. */
  clientDir?: string;
  /** How often an idle event stream is sent a comment to keep it open. */
  heartbeatMs?: number;
  /** How long a CLI process with no turn running is kept before it is closed. */
  idleCloseMs?: number;
  /** Let notifications go to plain-HTTP endpoints. Only for tests, whose push endpoint is a local server; a real one is HTTPS. */
  allowHttpPushEndpoints?: boolean;
  /** Sign-ins to run in place of an agent's own, by driver. Tests replay a captured sign-in through it. */
  signIns?: readonly SignInDefinition[];
  /** Where dictation finds its programs and keeps its temporary files, and the largest recording, when not the defaults. */
  dictation?: Omit<DictationOptions, "home"> & { maxBytes?: number };
  /** What Botbench asks of GitHub (pull requests, and reading an issue). The owner's own gh unless a test replays output captured from it. */
  github?: GitHub;
}


/** Open the store under `home` and serve on every configured address. */
export async function startServer(options: StartOptions): Promise<BotbenchServer> {
  const { config, home } = options;
  const db = openStore(home);
  // A review folder of a Botbench that stopped mid-review is never used again (src/drivers/cli-sandbox.ts).
  removeLeftoverReviewFolders(home);
  const login = loadOrCreateLoginToken(home);
  const stream = createEventStream(db, options.heartbeatMs);
  // The configured model for turns and tasks is the implementer role's; a run's planner has its own.
  const model = roleModel(config, IMPLEMENTER, CLAUDE_CODE);
  const plannerModel = roleModel(config, PLANNER, CLAUDE_CODE);
  const driver = new ClaudeCodeDriver({ models: config.drivers[CLAUDE_CODE]?.models ?? [], ...(model ? { defaultModel: model } : {}) });
  // Codex, Grok and Antigravity review only (src/drivers/): each is offered as a run's reviewer and as nothing else.
  const configured = (name: typeof CODEX | typeof GROK | typeof ANTIGRAVITY) => ({ models: config.drivers[name]?.models ?? [], ...(config.drivers[name]?.model ? { defaultModel: config.drivers[name].model } : {}) });
  const reviewers = { [CODEX]: new CodexDriver(configured(CODEX)), [GROK]: new GrokDriver(configured(GROK)), [ANTIGRAVITY]: new AntigravityDriver(configured(ANTIGRAVITY)) };
  let broker: Broker;
  let push: Push;
  try {
    push = createPush({ db, home, allowHttpEndpoints: options.allowHttpPushEndpoints === true });
    // A number that is no count is refused here too: a config handed over in code has not been through the loader.
    broker = createBroker({ db, home, onChange: (approval) => {
        stream.announceApproval(approval);
        push.approvalChanged(approval);
      }, floor: floorEntries(config), offerStandingAfter: offerStandingAfter(config) });
  } catch (err) {
    stream.close();
    db.close();
    throw err;
  }
  try {
    // Without its socket the gate could only refuse, so Botbench does not start half-working.
    await broker.listen();
  } catch (err) {
    stream.close();
    db.close();
    throw err;
  }
  const turns = createTurns({ db, home, driver, ...(model ? { model } : {}), onEvent: stream.notify, idleCloseMs: options.idleCloseMs });
  const tasks = createTasks({ db, home, driver, broker, ...(model ? { model } : {}), repoCommands: (repo) => repositoryCommands(config, repo), repoHosts: (repo) => repositoryHosts(config, repo), reviewers, onEvent: stream.notify, onTaskChange: (task) => {
      stream.announceTask(task);
      push.taskChanged(task);
    }, onRunChange: stream.announceRun });
  const runs = createRuns({ db, home, driver, broker, ...(plannerModel ? { model: plannerModel } : {}), ...(model ? { implementerModel: model } : {}), reviewers, maxRefineRounds: maxRefineRounds(config), line: tasks, repoCommands: (repo) => repositoryCommands(config, repo), defaultMode: () => defaultMode(db, config.autonomy?.mode), onEvent: stream.notify, onRunChange: stream.announceRun, onTaskChange: stream.announceTask });
  // Each agent whose CLI has a sign-in Botbench can run: Claude Code, and Codex among the reviewers.
  const connect = createConnect({
    agents: ([driver, ...Object.values(reviewers)] as Driver[]).flatMap((d) => {
      const signIn = options.signIns?.find((s) => s.driver === d.name) ?? d.signIn;
      return signIn === undefined ? [] : [{ signIn, probe: () => d.probe() }];
    }),
    onChange: stream.announceAgent,
  });
  const { maxBytes: maxRecordingBytes, ...dictationOptions } = options.dictation ?? {};
  const dictation = createDictation({ home, ...dictationOptions });
  // Pushes and pull requests use the owner's own git and gh; only for a run that chose them, or the owner's own action.
  const github = options.github ?? createGitHub();
  const deliveries = createDeliveries({ db, config, github, onTaskChange: stream.announceTask });
  const ctx = { db, config, driver, reviewers, turns, tasks, runs, broker, stream, push, connect, dictation, deliveries, github, ...(maxRecordingBytes === undefined ? {} : { maxRecordingBytes }), clientDir: options.clientDir ?? path.join(ROOT, "web", "dist") };

  let port = config.port;
  const auth = createAuth({ token: login.token, db, listen: config.listen, port: () => port, publicHosts: config.publicHosts ?? [], signInDelayMs: options.signInDelayMs });

  const handler: http.RequestListener = (req, res) => {
    // The gate answers sign-in and every refusal itself; only a request with a session reaches the routes.
    auth
      .gate(req, res)
      .then((allowed) => (allowed ? route(req, res, ctx) : undefined))
      .catch((err: unknown) => {
        console.error(`${req.method} ${requestUrl(req).pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (res.headersSent) res.destroy();
        else json(res, 500, { error: "internal error" });
      });
  };

  const servers: http.Server[] = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stream.close();
    await Promise.all(servers.map(stop));
    // Sessions write to the database as they stop, so they are closed before it.
    await Promise.allSettled([turns.close(), tasks.close(), runs.close(), connect.close(), deliveries.close()]);
    // After the tasks: a task that is stopping still writes its last approvals' ends through the broker.
    await broker.close();
    // A notification in flight may still delete an expired device's row; each has a time limit.
    await push.idle();
    db.close();
  };

  try {
    for (const address of config.listen) {
      const server = http.createServer(handler);
      servers.push(server);
      // With port 0 the first address picks a free port and the rest share it.
      port = await listen(server, port, address);
    }
  } catch (err) {
    await close();
    throw err;
  }
  return { port, addresses: [...config.listen], db, broker, push, ...(login.created ? { newLoginToken: login.token } : {}), streamClients: stream.clients, close };
}

/**
 * What a start reads from the environment: the data folder (and the old default one an installation may have left), the
 * owner's settings file, and a port that overrides the configured one. The old SMELT_* names are read for one release.
 */
export function startupSettings(env: NodeJS.ProcessEnv, log: Log): { homes: { home: string; legacy: string | null }; localConfig: string; port: number | undefined } {
  const homes = dataHomes(env, log);
  // BOTBENCH_CONFIG names the owner's settings file for one start, in place of botbench.local.json.
  const localConfig = localConfigFile(env, log);
  // BOTBENCH_PORT overrides the configured port for one start, e.g. to run a second instance.
  const raw = envSetting(env, "PORT", log);
  const port = raw === undefined ? undefined : Number(raw);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error(`BOTBENCH_PORT must be a port number, got "${raw}"`);
  return { homes, localConfig, port };
}

const runDirectly = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === import.meta.filename;
if (runDirectly) {
  const log: Log = (line) => console.log(line);
  const settings = startupSettings(process.env, log);
  const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: settings.localConfig });
  const { home } = settings.homes;
  // An installation from before the rename is moved into place before anything opens it; a failure stops the start.
  await moveOldHome({ ...settings.homes, log });
  const server = await startServer({ config: { ...config, port: settings.port ?? config.port }, home });
  for (const address of server.addresses) {
    console.log(`Botbench is listening on http://${address.includes(":") ? `[${address}]` : address}:${server.port}`);
  }
  if (server.newLoginToken !== undefined) {
    // Shown once, on the start that created it. Afterwards it is only in the owner-only file under the data directory.
    console.log(`Login token (shown this once, kept in ${path.join(home, LOGIN_TOKEN_FILE)}): ${server.newLoginToken}`);
  }
  // Closing stops every CLI process first, which can take a few seconds. A second signal during that
  // time is ignored: letting it kill Botbench would leave those processes running with nobody to stop them.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void server.close());
  }
}
