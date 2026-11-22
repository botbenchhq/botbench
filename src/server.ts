import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig, smeltHome, type Config } from "./config.ts";
import { openStore, schemaVersion } from "./store/db.ts";

export interface SmeltServer {
  /** The port actually bound, which differs from the configured one when that is 0. */
  port: number;
  addresses: string[];
  db: DatabaseSync;
  /** Stop listening, drop open connections and close the database. Safe to call twice. */
  close(): Promise<void>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
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
export async function startServer(options: { config: Config; home: string }): Promise<SmeltServer> {
  const { config, home } = options;
  const db = openStore(home);

  const handler: http.RequestListener = (req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://smelt.invalid");
    if (req.method === "GET" && pathname === "/health") {
      // Reads the database, so a healthy answer means the store is usable.
      json(res, 200, { status: "ok", schemaVersion: schemaVersion(db) });
    } else {
      json(res, 404, { error: "not found" });
    }
  };

  const servers: http.Server[] = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all(servers.map(stop));
    db.close();
  };

  let port = config.port;
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
  return { port, addresses: [...config.listen], db, close };
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
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void server.close());
  }
}
