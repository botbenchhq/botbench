import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_TOKEN_FILE } from "../../src/api/auth.ts";
import type { AttemptScript } from "./replay-build.ts";
import { git, initRepo } from "./repo.ts";

// Two Botbench installations on this Mac (ADR 0004 decision 13), for the tests of two workbenches: two real processes,
// each with its own data folder, owner port and peer listener on 127.0.0.1 at ports the system chose, and one
// temporary git repository with a bare remote both copies use. Nothing is faked: everything between them goes over
// real HTTP between the two processes, and the restarts are real stops and starts of a process with its store on disk.
// A process may be given a builder script (test/support/replay-build.ts): turns recorded from real Claude Code
// sessions, replayed through the driver contract, as the owner approved for engine tests.

const ENTRY = fileURLToPath(new URL("./peer-botbench.ts", import.meta.url));
export const JSON_TYPE = { "content-type": "application/json" };

export async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  await once(probe, "close");
  return port;
}

export interface Workbench {
  name: string;
  home: string;
  repo: string;
  peerAddress: string;
  /** Everything every start of this installation wrote, stdout and stderr. */
  output: () => string;
  /** Every prompt the replayed builder of the current start was sent, in order (only with a script). */
  prompts: () => string[];
  start(o?: number | { inviteLifeMs?: number; script?: readonly AttemptScript[] }): Promise<void>;
  stop(): Promise<void>;
  api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }>;
}

export async function workbench(t: { after(fn: () => unknown): void }, dir: string, name: string, repo: string, extra: Record<string, unknown> = {}): Promise<Workbench> {
  const home = path.join(dir, `${name}-home`);
  const [ownerPort, peerPort] = [await freePort(), await freePort()];
  const settings = path.join(dir, `${name}.local.json`);
  const promptsFile = path.join(dir, `${name}.prompts.json`);
  fs.writeFileSync(settings, JSON.stringify({ port: ownerPort, listen: ["127.0.0.1"], workbench: name, peers: { listen: { address: "127.0.0.1", port: peerPort } }, ...extra }));
  let child: ChildProcess | null = null;
  let output = "";
  let cookie = "";
  t.after(() => void child?.kill("SIGKILL"));
  const w: Workbench = {
    name,
    home,
    repo,
    peerAddress: `127.0.0.1:${peerPort}`,
    output: () => output,
    prompts: () => (fs.existsSync(promptsFile) ? (JSON.parse(fs.readFileSync(promptsFile, "utf8")) as string[]) : []),
    async start(o) {
      const given = typeof o === "number" ? { inviteLifeMs: o } : (o ?? {});
      fs.rmSync(promptsFile, { force: true });
      const order = { home, settings, ...(given.inviteLifeMs === undefined ? {} : { inviteLifeMs: given.inviteLifeMs }), ...(given.script === undefined ? {} : { script: given.script, promptsFile }) };
      const proc = spawn(process.execPath, [ENTRY, JSON.stringify(order)], { stdio: ["ignore", "pipe", "pipe"] });
      child = proc;
      const exited = once(proc, "exit");
      proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
      let mine = "";
      await new Promise<void>((resolve, reject) => {
        proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          mine += chunk;
          if (mine.includes("ready ")) resolve();
        });
        void exited.then(() => reject(new Error(`${name} exited before it was ready: ${output}`)));
      });
      const signedIn = await fetch(`http://127.0.0.1:${ownerPort}/api/sign-in`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ token: fs.readFileSync(path.join(home, LOGIN_TOKEN_FILE), "utf8").trim() }) });
      assert.equal(signedIn.status, 200);
      cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    },
    async stop() {
      const proc = child;
      if (proc === null) return;
      child = null;
      const exited = once(proc, "exit");
      proc.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 0, `${name} stopped cleanly: ${output}`);
    },
    async api(method, route, body) {
      const res = await fetch(`http://127.0.0.1:${ownerPort}${route}`, { method, headers: { ...JSON_TYPE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() };
    },
  };
  return w;
}

export async function until<T>(what: string, check: () => Promise<T | undefined | null | false>, ms = 45_000): Promise<T> {
  const began = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - began > ms) throw new Error(`Gave up waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export const pairingsOf = async (w: Workbench): Promise<any[]> => (await w.api("GET", "/api/peers/pairings")).body.pairings;
export const live = async (w: Workbench): Promise<any> => (await pairingsOf(w)).find((p) => p.state !== "ended");
export const pairingOf = async (w: Workbench, id: string): Promise<any> => (await pairingsOf(w)).find((p) => p.id === id);
export const logOf = async (w: Workbench): Promise<{ rule: string; command: string; detail: string; askedBy: { by: string; peerName: string | null; pairingId: string | null } }[]> => (await w.api("GET", "/api/action-log?limit=200")).body.entries;

/** One bare remote, alice's copy pushed to it and bob's cloned from it. */
export function sharedRepository(dir: string): { remote: string; aliceRepo: string; bobRepo: string } {
  const remote = path.join(dir, "shared.git");
  git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  const aliceRepo = path.join(dir, "alice-copy");
  initRepo(aliceRepo);
  git(aliceRepo, "remote", "add", "origin", remote);
  git(aliceRepo, "push", "--quiet", "origin", "main");
  const bobRepo = path.join(dir, "bob-copy");
  git(dir, "clone", "--quiet", remote, bobRepo);
  return { remote, aliceRepo, bobRepo };
}

/** Invite, paste, both owners confirm, through the owners' real routes; resolves with the pairing's id once both hold it in force and each took the other's settings. */
export async function pairThem(inviter: Workbench, joiner: Workbench): Promise<string> {
  const made = await inviter.api("POST", "/api/peers/invites", { repo: inviter.repo });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const pasted = await joiner.api("POST", "/api/peers/joins", { invite: made.body.invite, repo: joiner.repo });
  assert.equal(pasted.status, 200, JSON.stringify(pasted.body));
  const joined = await joiner.api("POST", `/api/peers/joins/${pasted.body.join.id}/confirm`, {});
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const id = joined.body.pairing.id as string;
  assert.equal((await inviter.api("POST", `/api/peers/pairings/${id}/confirm`, {})).status, 200);
  await until("the pairing in force on both sides", async () => (await pairingOf(joiner, id))?.state === "in_force" && (await pairingOf(inviter, id))?.words === "Paired");
  await until("each side's settings notice to be taken", async () => (await logOf(inviter)).some((e) => e.command === "settings notice received") && (await logOf(joiner)).some((e) => e.command === "settings notice received"));
  return id;
}
