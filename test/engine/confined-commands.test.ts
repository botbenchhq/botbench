import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SOCKET_FILE } from "../../src/approvals/broker.ts";
import type { Config } from "../../src/config.ts";
import { SANDBOX_EXEC, seatbeltProfile, unreadablePaths } from "../../src/confinement.ts";
import { confinedStart, runCommand } from "../../src/engine/stations.ts";
import { startServer } from "../../src/server.ts";
import { DB_FILE, openStore } from "../../src/store/db.ts";
import { createWorktree } from "../../src/worktrees.ts";
import { initRepo, tempDir } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// The setup and check commands Botbench runs itself in a task's copy run confined (U27), on the real sandbox-exec of
// this Mac: they read and write their copy, cannot read Botbench's own data folder or the owner's sign-ins, cannot
// write anywhere else but a temporary folder of their own, and reach no network unless the repository allows a host.

const DECOY = "DECOY-6f1c-not-for-commands";

interface Layout {
  dir: string;
  dataDir: string;
  worktree: string;
  decoy: string;
  outside: string;
}

/** A real repository, a Botbench data folder holding a decoy where its login token would be, and a task's copy inside it. */
async function layout(t: TestContext): Promise<Layout> {
  const dir = tempDir("botbench-confined-");
  const repo = path.join(dir, "repo");
  initRepo(repo, { "README.md": "# Sample\n", "inside.txt": "INSIDE-OK\n" });
  const dataDir = path.join(dir, "home");
  fs.mkdirSync(dataDir);
  const decoy = path.join(dataDir, "decoy-login-token");
  fs.writeFileSync(decoy, `${DECOY}\n`);
  const { path: worktree } = await createWorktree({ repo, home: dataDir, run: "run-1", task: "task-1" });
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  return { dir, dataDir, worktree, decoy, outside };
}

const run = (l: Layout, command: string, allowedHosts: string[] = []) => runCommand({ command, cwd: l.worktree, limitMs: 30_000, confinement: { dataDir: l.dataDir, allowedHosts } });

test("a setup or check command reads and writes its own copy, and git works there, but it cannot read Botbench's data folder, also from a child process", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await layout(t);
  const inside = await run(l, "cat inside.txt && echo made > made.txt && cat made.txt && git status --porcelain=v1 --untracked-files=all");
  assert.equal(inside.outcome, "passed", inside.output);
  assert.match(inside.output, /INSIDE-OK\nmade\n\?\? made\.txt\n/);
  assert.equal(fs.readFileSync(path.join(l.worktree, "made.txt"), "utf8"), "made\n");

  for (const command of [`cat '${l.decoy}'`, `sh -c "cat '${l.decoy}'"`, `node -e "process.stdout.write(require('fs').readFileSync('${l.decoy}', 'utf8'))"`, `ls '${l.dataDir}'`]) {
    const denied = await run(l, command);
    assert.equal(denied.outcome, "failed", command);
    assert.equal(denied.output.includes(DECOY), false, `${command} printed the decoy`);
    assert.match(denied.output, /Operation not permitted|EPERM/, command);
  }
  // The real database, which holds the signed-in devices' session hashes, and its write-ahead log are as unreadable.
  const db = openStore(l.dataDir);
  t.after(() => db.close());
  for (const file of [DB_FILE, `${DB_FILE}-wal`]) {
    assert.ok(fs.existsSync(path.join(l.dataDir, file)), file);
    const denied = await run(l, `cat '${path.join(l.dataDir, file)}'`);
    assert.equal(denied.outcome, "failed", file);
    assert.match(denied.output, /Operation not permitted|EPERM/, file);
  }
});

test("a setup or check command cannot write outside its copy, but may write its own temporary folder", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await layout(t);
  const target = path.join(l.outside, "escaped.txt");
  const escaped = await run(l, `echo out > '${target}'`);
  assert.equal(escaped.outcome, "failed");
  assert.match(escaped.output, /Operation not permitted/);
  assert.equal(fs.existsSync(target), false);
  const intoData = await run(l, `echo out > '${path.join(l.dataDir, "planted.txt")}'`);
  assert.equal(intoData.outcome, "failed");
  assert.equal(fs.existsSync(path.join(l.dataDir, "planted.txt")), false);

  const temp = await run(l, 'test -n "$TMPDIR" && echo scratch > "$TMPDIR/scratch.txt" && cat "$TMPDIR/scratch.txt" && echo "$TMPDIR"');
  assert.equal(temp.outcome, "passed", temp.output);
  const [written, folder] = temp.output.trim().split("\n");
  assert.equal(written, "scratch");
  assert.equal(path.relative(l.worktree, folder!).startsWith(".."), true, "the temporary folder is not in the copy, so nothing in it is committed");
  assert.equal(fs.existsSync(folder!), false, "the temporary folder goes when the command ends");
});

test("a setup or check command gets no provider key or gate secret from Botbench's environment", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await layout(t);
  const names = ["ANTHROPIC_API_KEY", "BOTBENCH_TEST_ACCESS_TOKEN", "BOTBENCH_BROKER_SECRET"];
  for (const name of names) {
    const before = process.env[name];
    process.env[name] = "SECRET-VALUE-not-for-commands";
    t.after(() => (before === undefined ? delete process.env[name] : (process.env[name] = before)));
  }
  const env = await run(l, "env");
  assert.equal(env.outcome, "passed");
  assert.equal(env.output.includes("SECRET-VALUE-not-for-commands"), false);
  assert.match(env.output, /^PATH=/m, "the ordinary variables are there");
});

test("a setup or check command, and npm run test:confined, start as sh under sandbox-exec with the copy's profile, TMPDIR as their own folder, and Botbench's proxy or none", (t) => {
  for (const name of ["HTTPS_PROXY", "NO_PROXY", "GIT_DIR"]) {
    const before = process.env[name];
    process.env[name] = "from-the-owner's-shell";
    t.after(() => (before === undefined ? delete process.env[name] : (process.env[name] = before)));
  }
  const o = { command: "npm test", worktree: "/work/copy", dataDir: "/data", tmp: "/tmp/own" };
  const alone = confinedStart({ ...o, proxyPort: null });
  assert.deepEqual([alone.argv[0], alone.argv[1], ...alone.argv.slice(3)], [SANDBOX_EXEC, "-p", "/bin/sh", "-c", "npm test"]);
  assert.equal(alone.argv[2], seatbeltProfile({ worktree: "/work/copy", unreadable: unreadablePaths({ dataDir: "/data" }), writable: ["/tmp/own"] }));
  assert.equal(alone.env.TMPDIR, "/tmp/own");
  assert.equal(alone.env.GIT_TERMINAL_PROMPT, "0");
  assert.deepEqual([alone.env.HTTPS_PROXY, alone.env.NO_PROXY, alone.env.GIT_DIR], [undefined, undefined, undefined], "the owner's proxy and git variables are not passed on");
  const proxied = confinedStart({ ...o, proxyPort: 4321 });
  assert.equal(proxied.env.HTTPS_PROXY, "http://127.0.0.1:4321");
  assert.equal(proxied.env.http_proxy, "http://127.0.0.1:4321");
  assert.equal(proxied.env.NO_PROXY, undefined);
});

/** A probe written into the copy, as a project's own test file would be: each line is `name=ok` or `name=<error code>`. */
const PROBE = fs.readFileSync(path.join(import.meta.dirname, "..", "support", "net-probe.cjs"), "utf8");

const probe = async (l: Layout, args: string[] = [], allowedHosts: string[] = []) => {
  fs.writeFileSync(path.join(l.worktree, "probe.cjs"), PROBE);
  const result = await run(l, `node probe.cjs ${args.map((a) => `'${a}'`).join(" ")}`, allowedHosts);
  assert.equal(result.outcome, "passed", result.output);
  return Object.fromEntries([...result.output.matchAll(/^(\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
};

test("a setup or check command can start a server on the loopback address and reach it, and use a Unix socket in its copy or its temporary folder, as a project's own tests do", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await layout(t);
  const seen = await probe(l);
  assert.equal(seen.http4, "ok", "a server on 127.0.0.1 and a client in the same command");
  assert.equal(seen.http6, "ok", "a server on ::1 and a client in the same command");
  assert.equal(seen.unixTmp, "ok", "a Unix socket in the command's temporary folder");
  assert.equal(seen.unixCopy, "ok", "a Unix socket in the task's copy");
});

test("a setup or check command still has no route to an address that is not this Mac's, with or without allowed hosts, and still cannot read a denied place", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await layout(t);
  for (const hosts of [[], ["example.com"]]) {
    const seen = await probe(l, [], hosts);
    assert.deepEqual([seen.internet, seen.internet6, seen.network], ["EPERM", "EPERM", "EPERM"], JSON.stringify({ hosts, seen }));
  }
  const denied = await run(l, `cat '${l.decoy}'`);
  assert.equal(denied.outcome, "failed");
  assert.equal(denied.output.includes(DECOY), false);
});

test("a setup or check command cannot reach Botbench's permission socket, nor a Unix socket outside its copy and temporary folder, and Botbench's own port answers it only with a refusal", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await layout(t);
  // The real server, with the command's denied data folder as its home: its permission socket is there.
  const config: Config = { port: 0, listen: ["127.0.0.1"], drivers: { "claude-code": {} }, roles: {} };
  const server = await startServer({ config, home: l.dataDir, signInDelayMs: 1 });
  t.after(() => server.close());
  const brokerSocket = path.join(l.dataDir, SOCKET_FILE);
  assert.equal(fs.existsSync(brokerSocket), true);
  const outsideSocket = path.join(l.outside, "o.sock");
  const other = net.createServer((socket) => socket.on("error", () => {}).end("outside\n"));
  await new Promise<void>((resolve) => other.listen(outsideSocket, resolve));
  t.after(() => other.close());

  const broker = await probe(l, [brokerSocket, String(server.port)]);
  assert.equal(broker.unixOutside, "EPERM", "the permission socket in the data folder");
  assert.equal(broker.botbench, "401", "every route of Botbench's own port needs the owner's session");
  const outside = await probe(l, [outsideSocket]);
  assert.equal(outside.unixOutside, "EPERM", "a Unix socket elsewhere on the Mac");
});

test("a setup or check command reaches a service on this Mac's loopback address, and Botbench's proxy when hosts are allowed", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await layout(t);
  const service = net.createServer((socket) => socket.on("error", () => {}).end("local service\n"));
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => service.close());
  const port = (service.address() as net.AddressInfo).port;
  const connect = `node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => { console.log('connected'); process.exit(0) }).on('error', (e) => { console.log(e.code); process.exit(3) })"`;
  const reached = await run(l, connect);
  assert.equal(reached.outcome, "passed", reached.output);
  const noProxy = await run(l, 'echo "proxy=${HTTPS_PROXY:-none}"');
  assert.match(noProxy.output, /^proxy=none$/m, "no proxy is offered when nothing is allowed");
  const allowed = await run(l, 'echo "proxy=$HTTPS_PROXY"', ["example.com"]);
  assert.match(allowed.output, /proxy=http:\/\/127\.0\.0\.1:\d+/, "commands are pointed at Botbench's proxy");
});

test("a setup or check command cannot start a program outside its sandbox by opening an app it wrote", { skip: NO_SANDBOX, timeout: 60_000 }, async (t) => {
  const l = await layout(t);
  // A real app bundle, written into the copy as agent-written code could write one, whose program writes outside the copy.
  const target = path.join(l.outside, "escaped.txt");
  const app = path.join(l.worktree, "Escape.app", "Contents");
  fs.mkdirSync(path.join(app, "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "MacOS", "Escape"), `#!/bin/sh\necho escaped > '${target}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Escape</string><key>CFBundleIdentifier</key><string>invalid.botbench.escape-${process.pid}-${Date.now()}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const opened = await run(l, "open -g -j ./Escape.app");
  assert.equal(opened.outcome, "failed", opened.output);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(fs.existsSync(target), false, "the app's program ran outside the sandbox");
});
