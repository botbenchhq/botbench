import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createAuth, loadOrCreateLoginToken, LOGIN_TOKEN_FILE } from "./api/auth.ts";
import { json, requestUrl, route } from "./api/router.ts";
import { createEventStream } from "./api/stream.ts";
import { createTurns } from "./api/turns.ts";
import { createChat } from "./api/chat.ts";
import { createAgentChecks } from "./api/agents.ts";
import { createBroker, type Broker } from "./approvals/broker.ts";
import { DEFAULT_CONFIG_FILE, dataHomes, envSetting, floorEntries, loadConfig, localConfigFile, maxCheckFixRounds, maxRefineRounds, offerStandingAfter, repositoryCommands, repositoryDelivery, repositoryExecution, repositoryHosts, repositoryProtectedPaths, ROOT, silenceLimitMs, usageLimitWaitMs, type Config, type Log } from "./config.ts";
import { CLAUDE_CODE, ClaudeCodeDriver, toolResultsFolder } from "./drivers/claude-code.ts";
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
import { createRuns, getRun } from "./engine/run.ts";
import { createGitHub, runGh, type GitHub, type RunGh } from "./github.ts";
import { startWatch } from "./engine/watch.ts";
import { createPeers } from "./engine/peers.ts";
import { createCheckTogether } from "./engine/combined.ts";
import { clearCombinedCopies } from "./worktrees.ts";
import { createClaims } from "./engine/claims.ts";
import { chooseWorkbench, workbenchName } from "./workbench.ts";
import { createTasks } from "./engine/task.ts";
import { createContainers } from "./engine/containers.ts";
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
  /** How long a code from Add a device signs in; 5 minutes when left out. */
  pairingLifetimeMs?: number;
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
  /** Claude Code for chat turns only. The real one unless a test replays a chat turn captured from it. */
  chatClaude?: Driver;
  /** Claude Code for everything it does here: tasks, runs and chat. The real one unless a test replays turns captured from it. */
  claudeCode?: Driver;
  /** Codex, Grok and Antigravity, for review and chat. The real ones unless a test replays sessions captured from them. */
  reviewers?: { [CODEX]: Driver; [GROK]: Driver; [ANTIGRAVITY]: Driver };
  /** The gh the issue watch lists labelled issues with. The owner's own unless a test replays output captured from it. */
  watchGh?: RunGh;
}


/** Open the store under `home` and serve on every configured address. */
export async function startServer(options: StartOptions): Promise<BotbenchServer> {
  const { config, home } = options;
  const db = openStore(home);
  // The workbench's name: the settings file's when it sets one; else the one kept, made from the host name at first start.
  if (config.workbench !== undefined) chooseWorkbench(db, config.workbench, "settings_file");
  else workbenchName(db);
  // A review folder of a Botbench that stopped mid-review is never used again (src/drivers/cli-sandbox.ts).
  removeLeftoverReviewFolders(home);
  const login = loadOrCreateLoginToken(home);
  // The task containers (engine/containers.ts). Each time a task is announced, accepted, rejected, cancelled or
  // discarded included, a container of a task that is no longer live is removed; at start, every one left over.
  const containers = createContainers({ db, home, workbench: () => workbenchName(db) });
  const events = createEventStream(db, options.heartbeatMs);
  const stream: typeof events = { ...events, announceTask: (task) => {
      events.announceTask(task);
      containers.taskChanged(task.id);
    } };
  // Whenever a docker program is on this Mac (the sweep asks nothing otherwise): a repository switched back to the host,
  // or taken out of the settings, may have left containers of ended tasks.
  void containers.sweep();
  // The configured model for turns and tasks is the implementer role's; a run's planner has its own.
  const model = roleModel(config, IMPLEMENTER, CLAUDE_CODE);
  const plannerModel = roleModel(config, PLANNER, CLAUDE_CODE);
  const driver = options.claudeCode ?? new ClaudeCodeDriver({ models: config.drivers[CLAUDE_CODE]?.models ?? [], ...(model ? { defaultModel: model } : {}) });
  // Codex, Grok and Antigravity review and chat (src/drivers/, src/api/chat.ts); they never plan or build.
  const configured = (name: typeof CODEX | typeof GROK | typeof ANTIGRAVITY) => ({ models: config.drivers[name]?.models ?? [], ...(config.drivers[name]?.model ? { defaultModel: config.drivers[name].model } : {}) });
  const reviewers = options.reviewers ?? { [CODEX]: new CodexDriver(configured(CODEX)), [GROK]: new GrokDriver(configured(GROK)), [ANTIGRAVITY]: new AntigravityDriver(configured(ANTIGRAVITY)) };
  let broker: Broker;
  let push: Push;
  try {
    push = createPush({ db, home, allowHttpEndpoints: options.allowHttpPushEndpoints === true });
    // A number that is no count is refused here too: a config handed over in code has not been through the loader.
    broker = createBroker({ db, home, onChange: (approval) => {
        stream.announceApproval(approval);
        push.approvalChanged(approval);
      }, floor: floorEntries(config), offerStandingAfter: offerStandingAfter(config),
      // Only Claude Code's sessions save long output Botbench knows where to find (src/drivers/claude-code.ts).
      sessionOutput: ({ driver: name, session, worktree }) => (name === CLAUDE_CODE ? toolResultsFolder({ cwd: worktree, session }) : null) });
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
  // Pushes, pull requests and issue claims use the owner's own git and gh; only for a run that chose pull requests, or
  // the owner's own action. An issue claim also needs the repository's settings to turn claims on (engine/claims.ts).
  const github = options.github ?? createGitHub();
  const claims = createClaims({ db, config, github, onRunChange: (id) => {
      // A claim's step is shown on the run's screen: it reads the run again.
      const run = getRun(db, id);
      if (run !== null) stream.announceRun(run);
    }, stopRun: (id) => {
      // A run whose claim gave way to another workbench's earlier one is stopped as a cancel stops it.
      try {
        runs.cancel(id, "stopped: another workbench holds the claim on its issue");
      } catch (err) {
        console.error(`Stopping run ${id} after its issue claim gave way failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } });
  const chatClaude = options.chatClaude ?? driver;
  const turns = createTurns({ db, home, driver: chatClaude, broker, ...(model ? { model } : {}), onEvent: stream.notify, idleCloseMs: options.idleCloseMs });
  // A chat can ask Codex, Grok and Antigravity too, each confined as for a review (src/api/chat.ts).
  const chat = createChat({ db, home, turns, claude: chatClaude, agents: reviewers, onEvent: stream.notify });
  // What other workbenches have in flight on a repository's remote: read only, kept for a short time.
  const peers = createPeers({ db, config, github });
  // Checking a task together with another workbench's open pull request, in a temporary copy (engine/combined.ts).
  // A copy left by a Botbench that stopped while checking is removed first, by what is on disk.
  clearCombinedCopies(home);
  const checkTogether = createCheckTogether({
    db, home, peers,
    repoCommands: (repo) => repositoryCommands(config, repo),
    repoHosts: (repo) => repositoryHosts(config, repo),
    execution: (repo) => repositoryExecution(config, repo),
    remote: (repo) => repositoryDelivery(config, repo).remote,
    onTaskChange: stream.announceTask,
    onPassed: (taskId) => void tasks.reconsider(taskId),
  });
  const tasks = createTasks({ db, home, driver, broker, ...(model ? { model } : {}), repoCommands: (repo) => repositoryCommands(config, repo), repoHosts: (repo) => repositoryHosts(config, repo), execution: (repo) => repositoryExecution(config, repo), containers, protectedPaths: (repo) => repositoryProtectedPaths(config, repo), reviewers, silenceLimitMs: silenceLimitMs(config), usageLimitWaitMs: usageLimitWaitMs(config), checkFixRounds: maxCheckFixRounds(config), checkTogether, onEvent: stream.notify, onTaskChange: (task) => {
      stream.announceTask(task);
      push.taskChanged(task);
    }, onRunChange: (run) => {
      stream.announceRun(run);
      push.runChanged(run);
      claims.runChanged(run);
    } });
  const runs = createRuns({ db, home, driver, broker, ...(plannerModel ? { model: plannerModel } : {}), ...(model ? { implementerModel: model } : {}), reviewers, maxRefineRounds: maxRefineRounds(config), silenceLimitMs: silenceLimitMs(config), line: tasks, repoCommands: (repo) => repositoryCommands(config, repo), defaultMode: () => defaultMode(db, config.autonomy?.mode), onEvent: stream.notify, onRunChange: (run) => {
      stream.announceRun(run);
      claims.runChanged(run);
    }, onTaskChange: stream.announceTask });
  // Each agent Botbench drives, listed in this order, checked by its own program and kept for a short time.
  const agentChecks = createAgentChecks([driver, ...Object.values(reviewers)]);
  // Each agent whose CLI has a sign-in Botbench can run: Claude Code, and Codex among the reviewers.
  const connect = createConnect({
    agents: ([driver, ...Object.values(reviewers)] as Driver[]).flatMap((d) => {
      const signIn = options.signIns?.find((s) => s.driver === d.name) ?? d.signIn;
      return signIn === undefined ? [] : [{ signIn, probe: () => d.probe() }];
    }),
    onChange: (agent, state) => {
      // A sign-in or sign-out changes what the agents' checks would find: the next read checks again.
      agentChecks.forget();
      stream.announceAgent(agent, state);
    },
  });
  const { maxBytes: maxRecordingBytes, ...dictationOptions } = options.dictation ?? {};
  const dictation = createDictation({ home, ...dictationOptions });
  const deliveries = createDeliveries({ db, config, github, onTaskChange: (task) => {
      stream.announceTask(task);
      // A delivery that failed may leave its run with no pull request on its way: its claim is released then.
      if (task.runId !== null) claims.runChanged({ id: task.runId });
    }, claims });
  // Claims a stopped Botbench left on the remote for runs that ended without a pull request are released now.
  claims.recover();
  // The issue watch (engine/watch.ts): each watched repository's labelled open issues, listed with the owner's gh at its
  // interval and proposed on Work. It reads only; a run starts only when the owner presses Start and submits the composer.
  const watch = startWatch({ db, config, run: options.watchGh ?? runGh, onProposed: () => push.issueProposed(), onChange: stream.announceWatch });
  const ctx = { db, home, config, driver, reviewers, agentChecks, turns, chat, tasks, runs, broker, stream, push, connect, dictation, deliveries, github, peers, checkTogether, claims, watch, ...(maxRecordingBytes === undefined ? {} : { maxRecordingBytes }), clientDir: options.clientDir ?? path.join(ROOT, "web", "dist") };

  let port = config.port;
  const auth = createAuth({ token: login.token, db, listen: config.listen, port: () => port, publicHosts: config.publicHosts ?? [], signInDelayMs: options.signInDelayMs, pairingLifetimeMs: options.pairingLifetimeMs });

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
    // A poll under way writes its issues to the store when it ends: its timers stop and it is waited for first.
    await watch.close();
    // Sessions write to the database as they stop, so they are closed before it.
    // A check together ending now may still ask the tasks to look at its task again, so it stops first.
    await checkTogether.close();
    await Promise.allSettled([chat.close().then(() => turns.close()), tasks.close(), runs.close(), connect.close(), deliveries.close()]);
    // A claim's push or delete in flight writes its step to the store when it ends; each git call has a time limit.
    await claims.idle();
    // After the tasks: a task that is stopping still writes its last approvals' ends through the broker.
    await broker.close();
    // A notification in flight may still delete an expired device's row; each has a time limit.
    await push.idle();
    // A container sweep or removal reads the store; each docker call has a time limit.
    await containers.idle();
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
