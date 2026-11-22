import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createAuth, loadOrCreateLoginToken, LOGIN_TOKEN_FILE } from "./api/auth.ts";
import { json, route } from "./api/router.ts";
import { loadConfig, smeltHome, type Config } from "./config.ts";
import { openStore } from "./store/db.ts";

export interface SmeltServer {
  /** The port actually bound, which differs from the configured one when that is 0. */
  port: number;
  addresses: string[];
  db: DatabaseSync;
  /** The owner's login token, present only on the start that created it, so the entry point can show it once. */
  newLoginToken?: string;
  /** Stop listening, drop open connections and close the database. Safe to call twice. */
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

/** Open the store under `home` and serve on every configured address. */
export async function startServer(options: { config: Config; home: string; signInDelayMs?: number }): Promise<SmeltServer> {
  const { config, home } = options;
  const db = openStore(home);
  const login = loadOrCreateLoginToken(home);

  let port = config.port;
  const auth = createAuth({ token: login.token, listen: config.listen, port: () => port, publicHosts: config.publicHosts ?? [], signInDelayMs: options.signInDelayMs });

  const handler: http.RequestListener = (req, res) => {
    // The gate answers sign-in and every refusal itself; only a request with a session reaches the routes.
    auth
      .gate(req, res)
      .then((allowed) => (allowed ? route(req, res, { db }) : undefined))
      .catch((err: unknown) => {
        console.error(`${req.method} ${new URL(req.url ?? "/", "http://smelt.invalid").pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (res.headersSent) res.destroy();
        else json(res, 500, { error: "internal error" });
      });
  };

  const servers: http.Server[] = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all(servers.map(stop));
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
  return { port, addresses: [...config.listen], db, ...(login.created ? { newLoginToken: login.token } : {}), close };
}

const runDirectly = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === import.meta.filename;
if (runDirectly) {
  const config = loadConfig();
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
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void server.close());
  }
}
