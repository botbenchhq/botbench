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
import { LOCAL_CONFIG_FILE, DEFAULT_CONFIG_FILE, loadConfig, ROOT, smeltHome, type Config } from "./config.ts";
import { CLAUDE_CODE, ClaudeCodeDriver } from "./drivers/claude-code.ts";
import { createTasks } from "./engine/task.ts";
import { openStore } from "./store/db.ts";

export interface SmeltServer {
  /** The port actually bound, which differs from the configured one when that is 0. */
  port: number;
  addresses: string[];
  db: DatabaseSync;
  /** The permission broker every task's requests wait in. */
  broker: Broker;
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
}

/** The model for turns: the one configured for the implementer's driver, when that driver is Claude Code. */
function turnModel(config: Config): string | undefined {
  const role = config.roles.implementer;
  return role === undefined || role.driver === CLAUDE_CODE ? config.drivers[CLAUDE_CODE]?.model : undefined;
}

/** Open the store under `home` and serve on every configured address. */
export async function startServer(options: StartOptions): Promise<SmeltServer> {
  const { config, home } = options;
  const db = openStore(home);
  const login = loadOrCreateLoginToken(home);
  const stream = createEventStream(db, options.heartbeatMs);
  const model = turnModel(config);
  const driver = new ClaudeCodeDriver();
  const broker = createBroker({ db, home, onChange: stream.announceApproval });
  try {
    // Without its socket the gate could only refuse, so Smelt does not start half-working.
    await broker.listen();
  } catch (err) {
    stream.close();
    db.close();
    throw err;
  }
  const turns = createTurns({ db, home, driver, ...(model ? { model } : {}), onEvent: stream.notify, idleCloseMs: options.idleCloseMs });
  const tasks = createTasks({ db, home, driver, broker, ...(model ? { model } : {}), onEvent: stream.notify, onTaskChange: stream.announceTask });
  const ctx = { db, turns, tasks, broker, stream, clientDir: options.clientDir ?? path.join(ROOT, "web", "dist") };

  let port = config.port;
  const auth = createAuth({ token: login.token, listen: config.listen, port: () => port, publicHosts: config.publicHosts ?? [], signInDelayMs: options.signInDelayMs });

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
    await Promise.allSettled([turns.close(), tasks.close()]);
    // After the tasks: a task that is stopping still writes its last approvals' ends through the broker.
    await broker.close();
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
  return { port, addresses: [...config.listen], db, broker, ...(login.created ? { newLoginToken: login.token } : {}), streamClients: stream.clients, close };
}

const runDirectly = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === import.meta.filename;
if (runDirectly) {
  // SMELT_CONFIG names the owner's settings file for one start, in place of smelt.local.json.
  const config = loadConfig({ defaults: DEFAULT_CONFIG_FILE, local: process.env.SMELT_CONFIG ? path.resolve(process.env.SMELT_CONFIG) : LOCAL_CONFIG_FILE });
  // SMELT_PORT overrides the configured port for one start, e.g. to run a second instance.
  const port = process.env.SMELT_PORT === undefined ? config.port : Number(process.env.SMELT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`SMELT_PORT must be a port number, got "${process.env.SMELT_PORT}"`);
  const server = await startServer({ config: { ...config, port }, home: smeltHome() });
  for (const address of server.addresses) {
    console.log(`Smelt is listening on http://${address.includes(":") ? `[${address}]` : address}:${server.port}`);
  }
  if (server.newLoginToken !== undefined) {
    // Shown once, on the start that created it. Afterwards it is only in the owner-only file under the data directory.
    console.log(`Login token (shown this once, kept in ${path.join(smeltHome(), LOGIN_TOKEN_FILE)}): ${server.newLoginToken}`);
  }
  // Closing stops every CLI process first, which can take a few seconds. A second signal during that
  // time is ignored: letting it kill Smelt would leave those processes running with nobody to stop them.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void server.close());
  }
}
