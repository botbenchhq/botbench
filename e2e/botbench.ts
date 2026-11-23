import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");

export interface Botbench {
  /** The address the client is opened at. */
  base: string;
  port: number;
  home: string;
  /** The owner's login token, read from the file Botbench wrote. */
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

// Each test or fixture removes the folders it makes in its own teardown. What one could not reach (a fixture whose
// setup threw before `use`, a teardown that threw before its removal) is removed when the Playwright worker exits.
const made = new Set<string>();
process.once("exit", () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A temporary folder by its real path. The caller removes it; at the latest it goes when this worker exits. */
export function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.add(dir);
  return dir;
}

/** Start one `node src/server.ts` and wait until it listens. */
async function launchServer(home: string, port: number, settings: string, env: Record<string, string>, entry = path.join(ROOT, "src", "server.ts")): Promise<{ child: ChildProcess; port: number }> {
  const child: ChildProcess = spawn(process.execPath, [entry], {
    cwd: ROOT,
    // No test looks for Botbench's releases on GitHub (src/update.ts); one that is about updating starts its own entry.
    env: { ...process.env, BOTBENCH_HOME: home, BOTBENCH_PORT: String(port), BOTBENCH_CONFIG: settings, BOTBENCH_UPDATES: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const bound = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Botbench did not start:\n${output}`)), 15_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) (clearTimeout(timer), resolve(Number(match[1])));
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => (clearTimeout(timer), reject(new Error(`Botbench exited with code ${code}:\n${output}`))));
  });
  return { child, port: bound };
}

/**
 * Start a real Botbench process: `node src/server.ts`, its data in `home`, on a
 * free port (or `port`, to come back on the same one). Turns ask for the
 * cheapest model unless `settings` gives the owner's settings file. `env` adds to the process environment.
 */
export async function startBotbench(options: { home?: string; port?: number; env?: Record<string, string>; settings?: unknown; /** A test-only start under e2e/ in place of src/server.ts, such as e2e/serve-replayed-gh.ts. */ entry?: string } = {}): Promise<Botbench> {
  const home = options.home ?? path.join(tempDir("botbench-e2e-"), "home");
  const settings = path.join(path.dirname(home), "settings.json");
  fs.writeFileSync(settings, JSON.stringify(options.settings ?? { drivers: { "claude-code": { model: "haiku" } } }));
  const first = await launchServer(home, options.port ?? 0, settings, options.env ?? {}, options.entry);
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
    // Every process group Botbench started, read from its own records before it goes.
    const db = new DatabaseSync(path.join(home, "botbench.sqlite"), { readOnly: true });
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
    child = (await launchServer(home, port, settings, options.env ?? {}, options.entry)).child;
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
