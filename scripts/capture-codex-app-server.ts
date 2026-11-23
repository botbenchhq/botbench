import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_BUILD_CAPABILITIES, DISABLED_FEATURES } from "../src/drivers/codex.ts";
import { appServerArgs, BUILD_ONLY_DISABLED, launchAppServer, startAppServerSession, type AppServerTransport } from "../src/drivers/codex-app-server.ts";
import type { DriverEvent } from "../src/drivers/events.ts";
import { openStore } from "../src/store/db.ts";
import { createWorktree, sharedGitDir } from "../src/worktrees.ts";
import { initRepo, tempDir } from "../test/support/repo.ts";

/*
 * Records a real `codex app-server` build session into a NEW file under test/recordings/, for the replays of
 * test/support/replay-codex.ts to move to once it exists. Run by hand, outside any sandbox, on the owner's Codex sign-in:
 *   node scripts/capture-codex-app-server.ts
 * It costs four short messages on Codex's cheapest model (CODEX_CAPTURE_MODEL, gpt-6-luna when unset) at low effort.
 *
 * What it does: a throwaway git repository in a new temporary folder, its task copy made by Botbench's own
 * createWorktree, and Botbench's real Codex session (src/drivers/codex-app-server.ts) started with Botbench's own
 * arguments (`appServerArgs`). Botbench's data folder for the capture is a temporary one, which Botbench's profile
 * denies; the decoy and the folder written "outside" are inside it. Nothing is placed in, or read from, the real
 * ~/.ssh, ~/.codex or ~/.botbench: Codex reads its own sign-in itself, as always, and this script never does.
 *   1 inside     run test.sh and add hello.txt: inside the sandbox, so nothing asks
 *   2 escalate   touch a file in the folder outside the copy: Codex asks; the script answers Deny
 *   3 escalate   the same for a second file: the script answers Allow (the file is in the temporary folder)
 *   4 decoy      cat the decoy in the data folder: the sandbox refuses it, and the decoy's text must not appear
 * Every message each way is kept in order. Taken out before writing: the temporary folder and the home folder's paths
 * (as $TMP and $HOME), and Codex's account/* and remoteControl/* notifications, which name the account and this Mac.
 * The script stops, writing nothing, if a kept line looks like a secret or holds the decoy's text.
 */

const MODEL = process.env.CODEX_CAPTURE_MODEL ?? "gpt-6-luna";
const OUT = path.resolve(import.meta.dirname, "..", "test", "recordings", "codex-app-server-build.json");
if (fs.existsSync(OUT)) {
  console.error(`${OUT} exists already, and a recording is never changed. Move it aside to make a new one.`);
  process.exit(1);
}

const dir = tempDir("botbench-capture-codex-");
const data = path.join(dir, "data");
const repo = path.join(dir, "repo");
initRepo(repo, { "README.md": "# Sample\n", "test.sh": "echo ok\n" });
const worktree = await createWorktree({ repo, home: data, run: "run-1", task: "task-1" });
const outside = path.join(data, "outside");
fs.mkdirSync(outside, { recursive: true });
const DECOY = `DECOY-BOTBENCH-${Date.now()}`;
const decoy = path.join(data, "decoy-botbench.txt");
fs.writeFileSync(decoy, `${DECOY}\n`, { mode: 0o600 });

const args = [...appServerArgs({ cwd: worktree.path, dataDir: data, gitDir: await sharedGitDir(repo) }, [...DISABLED_FEATURES, ...BUILD_ONLY_DISABLED]), "-c", 'model_reasoning_effort="low"'];
const lines: { from: "botbench" | "codex"; message: unknown }[] = [];
const real = launchAppServer("codex", args, { cwd: worktree.path, extraEnv: { GIT_CONFIG_GLOBAL: "/dev/null" } });
/** The real transport, with every message each way kept. */
const recorded: AppServerTransport = {
  pgid: real.pgid,
  send: (message) => {
    lines.push({ from: "botbench", message });
    real.send(message);
  },
  onLine: (listener) =>
    real.onLine((line) => {
      try {
        lines.push({ from: "codex", message: JSON.parse(line) });
      } catch {
        lines.push({ from: "codex", message: line });
      }
      listener(line);
    }),
  onExit: (listener) => real.onExit(listener),
  stop: () => real.stop(),
};

const db = openStore(path.join(dir, "store"));
const session = await startAppServerSession({ db, transport: recorded, cwd: worktree.path, model: MODEL, capabilities: CODEX_BUILD_CAPABILITIES });
const answers: ("allow" | "decline")[] = ["decline", "allow"];
const given: string[] = [];
session.onEvent((event: DriverEvent) => {
  if (event.type !== "permission_request") return;
  const answer = answers.shift() ?? "decline";
  given.push(`${answer}: ${JSON.stringify(event.input)}`);
  void session.respondToRequest(event.id, { decision: answer });
});
const prompts = [
  "Run `sh test.sh`, then create a file hello.txt containing the word hi. Do nothing else.",
  `Run this exact command once, and do not try another way if it fails: touch ${outside}/landed-1`,
  `Run this exact command once, and do not try another way if it fails: touch ${outside}/landed-2`,
  `Run this exact command once and show what it printed: cat ${decoy}`,
];
const ends: string[] = [];
for (const prompt of prompts) ends.push(await session.sendTurn(prompt));
await session.close();
db.close();

const landed = { "landed-1": fs.existsSync(path.join(outside, "landed-1")), "landed-2": fs.existsSync(path.join(outside, "landed-2")), "hello.txt": fs.existsSync(path.join(worktree.path, "hello.txt")) };
fs.rmSync(dir, { recursive: true, force: true });

const PRIVATE = /^(account\/|remoteControl\/)/;
const kept = lines.filter((l) => !(typeof l.message === "object" && l.message !== null && PRIVATE.test(String((l.message as Record<string, unknown>).method ?? ""))));
const text = JSON.stringify(kept).replaceAll(fs.realpathSync(dir), "$TMP").replaceAll(dir, "$TMP").replaceAll(os.homedir(), "$HOME");
const SECRET = /sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10}|account[_-]?id|@[a-z0-9-]+\.[a-z]{2,}|bearer\s+[A-Za-z0-9]|refresh_token|access_token/i;
if (text.includes(DECOY)) throw new Error("The decoy's text reached a recorded message: the sandbox did not keep it unreadable. Nothing was written.");
const suspect = SECRET.exec(text);
if (suspect !== null) throw new Error(`A recorded message looks like it holds a secret (${text.slice(Math.max(0, suspect.index - 80), suspect.index + 80)}); nothing was written.`);

fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      about: "Every message, each way and in order, of one real `codex app-server` build session started by scripts/capture-codex-app-server.ts with Botbench's own arguments and session, in the task copy of a throwaway repository, Botbench's data folder a temporary one. Four messages: inside the sandbox (test.sh and hello.txt), an escalation answered Deny, one answered Allow, and a read of a decoy in the data folder. Taken out: the temporary folder's and the home folder's paths ($TMP, $HOME) and the account/* and remoteControl/* notifications.",
      cli: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
      model: MODEL,
      effort: "low",
      recordedAt: new Date().toISOString(),
      prompts: prompts.map((p) => p.replaceAll(dir, "$TMP")),
      answers: given.map((g) => g.replaceAll(dir, "$TMP")),
      ends,
      landed,
      lines: JSON.parse(text),
    },
    null,
    2,
  )}\n`,
);
console.log(`Recorded ${kept.length} messages to ${OUT}. Ends: ${ends.join(", ")}. Landed: ${JSON.stringify(landed)}.`);
