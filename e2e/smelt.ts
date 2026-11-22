import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");

export interface Smelt {
  /** The address the client is opened at. */
  base: string;
  port: number;
  home: string;
  /** The owner's login token, read from the file Smelt wrote. */
  token: string;
  /** Freeze the process, as a stalled machine or network would: connections stay open and nothing answers. */
  freeze(): void;
  /** Let a frozen process run again. */
  thaw(): void;
  /** Kill the process where it stands, as a crash or a forced quit would: it closes nothing and stops none of its CLI processes. */
  kill(): Promise<void>;
  /** Start a new process on the same data directory and port, after stopping the running one in the ordinary way if it still runs. */
  restart(): Promise<void>;
  /** Stop the process and report any CLI process group it left running. */
  stop(): Promise<{ leftover: number[] }>;
}

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Start one `node src/server.ts` and wait until it listens. */
async function launchServer(home: string, port: number, settings: string, env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, "src", "server.ts")], {
    cwd: ROOT,
    env: { ...process.env, SMELT_HOME: home, SMELT_PORT: String(port), SMELT_CONFIG: settings, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const bound = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Smelt did not start:\n${output}`)), 15_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) (clearTimeout(timer), resolve(Number(match[1])));
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => (clearTimeout(timer), reject(new Error(`Smelt exited with code ${code}:\n${output}`))));
  });
  return { child, port: bound };
}

/**
 * Start a real Smelt process: `node src/server.ts`, its data in `home`, on a
 * free port (or `port`, to come back on the same one). Turns ask for the
 * cheapest model. `env` adds to the process environment.
 */
export async function startSmelt(options: { home?: string; port?: number; env?: Record<string, string> } = {}): Promise<Smelt> {
  const home = options.home ?? path.join(tempDir("smelt-e2e-"), "home");
  const settings = path.join(path.dirname(home), "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ drivers: { "claude-code": { model: "haiku" } } }));
  const first = await launchServer(home, options.port ?? 0, settings, options.env ?? {});
  const port = first.port;
  let child = first.child;

  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  const end = async (signal: NodeJS.Signals): Promise<void> => {
    if (!running()) return;
    child.kill("SIGCONT");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill(signal);
    await exited;
  };

  const stop = async (): Promise<{ leftover: number[] }> => {
    // Every process group Smelt started, read from its own records before it goes.
    const db = new DatabaseSync(path.join(home, "smelt.sqlite"), { readOnly: true });
    const groups = db.prepare("SELECT pgid FROM attempts WHERE pgid IS NOT NULL").all().map((row) => Number(row.pgid));
    db.close();
    await end("SIGTERM");
    const leftover = groups.filter((pgid) => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    });
    return { leftover };
  };

  const restart = async (): Promise<void> => {
    await end("SIGTERM");
    child = (await launchServer(home, port, settings, options.env ?? {})).child;
  };

  return {
    base: `http://127.0.0.1:${port}`,
    port,
    home,
    token: fs.readFileSync(path.join(home, "login-token"), "utf8").trim(),
    freeze: () => void child.kill("SIGSTOP"),
    thaw: () => void child.kill("SIGCONT"),
    kill: () => end("SIGKILL"),
    restart,
    stop,
  };
}
