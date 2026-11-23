import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SANDBOX_EXEC } from "../../src/confinement.ts";
import { makeReviewFolder, neutralizeMentions, proxyEnv, removeLeftoverReviewFolders, toolsProfile, wholeCliProfile } from "../../src/drivers/cli-sandbox.ts";
import { tempDir, removedAtEnd } from "../support/repo.ts";
import { NO_SANDBOX } from "../support/confined.ts";

// Real sandbox-exec, real files; no CLI of a vendor is started here.

test("the whole-CLI profile denies reading every listed place but the CLI's own folders and the review folder, and writing anywhere but those and the temporary folder", { skip: NO_SANDBOX }, (t) => {
  const dir = fs.realpathSync(tempDir("botbench-cli-sandbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "data");
  const own = path.join(dir, "own");
  const review = path.join(data, "reviewers", "r1");
  // Not in the temporary folder, which stays writable: beside this checkout, removed afterwards.
  const outside = path.resolve(import.meta.dirname, "..", "..", `.cli-sandbox-probe-${process.pid}`);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  for (const d of [data, own, review, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, "decoy.txt"), "DECOY\n");
  fs.writeFileSync(path.join(own, "own.txt"), "OWN\n");
  const profile = wholeCliProfile({ unreadable: [data, own], readable: [own, review], writable: [own, review] });
  const sh = (script: string) => spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script], { encoding: "utf8" });
  assert.notEqual(sh(`cat ${data}/decoy.txt`).status, 0, "a denied place cannot be read");
  assert.equal(sh(`cat ${own}/own.txt`).stdout, "OWN\n", "the CLI's own folder is opened again for it");
  assert.equal(sh(`echo x > ${review}/a && cat ${review}/a`).stdout, "x\n", "the review folder is readable and writable");
  assert.notEqual(sh(`echo x > ${outside}/b`).status, 0);
  assert.equal(fs.existsSync(path.join(outside, "b")), false, "nothing is written outside the allowed places");
  // Named by this process, not the shell's `$$`, so the test knows the file and removes it.
  const probe = path.join(os.tmpdir(), `botbench-cli-sandbox-probe-${process.pid}`);
  t.after(() => fs.rmSync(probe, { force: true }));
  assert.equal(sh(`echo x > ${probe} && echo ok`).stdout.trim(), "ok", "the temporary folder stays writable");
  assert.match(profile, /\(deny lsopen\)/);
  assert.doesNotMatch(profile, /deny network/, "the CLI must reach its own provider");
});

test("CRITICAL: under the profile of a CLI with its own tools, a command reads and writes its working folder, reads a read-only repository and cannot change it, cannot read a decoy elsewhere in the home folder, and reaches only the proxy's port", { skip: NO_SANDBOX }, async (t) => {
  const dir = fs.realpathSync(tempDir("botbench-tools-sandbox-"));
  const data = path.join(dir, "data");
  const folder = path.join(data, "scratch");
  const own = path.join(dir, "own");
  // In the temporary folder: the repository must stay unwritable all the same.
  const repo = path.join(dir, "repo");
  for (const d of [folder, own, repo]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, "a.txt"), "REPO\n");
  fs.writeFileSync(path.join(data, "secret.txt"), "DATA\n");
  // In the home folder, outside every allowed place (not beside this checkout, which need not be in the home folder).
  const outside = path.join(os.homedir(), `.tools-sandbox-decoy-${process.pid}`);
  fs.writeFileSync(outside, "DECOY\n");
  t.after(() => fs.rmSync(outside, { force: true }));
  const open = net.createServer((socket) => socket.end()).listen(0, "127.0.0.1");
  const closed = net.createServer((socket) => socket.end()).listen(0, "127.0.0.1");
  await Promise.all([once(open, "listening"), once(closed, "listening")]);
  t.after(() => (open.close(), closed.close()));
  const port = (s: net.Server): number => (s.address() as net.AddressInfo).port;
  const profile = toolsProfile({ home: os.homedir(), unreadable: [data], own: [own], folder, readOnly: [repo], temp: path.join(dir, "temp"), proxyPort: port(open) });
  const sh = (script: string) => spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script], { encoding: "utf8", cwd: folder });
  assert.equal(sh(`echo made > ${folder}/b && cat ${folder}/b`).stdout, "made\n", "the working folder is read and written");
  assert.equal(sh(`cat ${repo}/a.txt`).stdout, "REPO\n", "the repository is read");
  assert.notEqual(sh(`echo x >> ${repo}/a.txt`).status, 0, "a write to the repository is refused");
  assert.notEqual(sh(`touch ${repo}/new`).status, 0);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "REPO\n");
  assert.equal(fs.existsSync(path.join(repo, "new")), false);
  assert.notEqual(sh(`cat ${outside}`).status, 0, "a decoy elsewhere in the home folder cannot be read");
  assert.notEqual(sh(`cat ${data}/secret.txt`).status, 0, "Botbench's data folder, but the working folder, cannot be read");
  assert.equal(sh(`/usr/bin/nc -z -G 2 127.0.0.1 ${port(open)} && echo reached`).stdout.trim(), "reached", "the proxy's port is reached");
  assert.notEqual(sh(`/usr/bin/nc -z -G 2 127.0.0.1 ${port(closed)}`).status, 0, "any other port on this Mac is not");
  assert.notEqual(sh("/usr/bin/nc -z -G 2 1.1.1.1 443").status, 0, "nor the internet");
});

test("CRITICAL: under the profile of a CLI with its own tools, a command cannot reach another program's Unix socket in the temporary folder, nor read or write the temporary folder outside its own private one, which it can use", { skip: NO_SANDBOX }, async (t) => {
  const dir = fs.realpathSync(tempDir("botbench-tools-temp-"));
  const data = path.join(dir, "data");
  const folder = path.join(data, "scratch");
  const own = path.join(dir, "own");
  const temp = path.join(dir, "private-temp");
  for (const d of [folder, own, temp]) fs.mkdirSync(d, { recursive: true });
  // Another program's socket and file in the temporary folder, as Chrome's SingletonSocket or another sandbox's proxy
  // socket are on this Mac: a command that reached the socket could ask that program to act outside the sandbox.
  const other = fs.realpathSync(removedAtEnd(fs.mkdtempSync(path.join(os.tmpdir(), "botbench-other-app-"))));
  fs.writeFileSync(path.join(other, "state.txt"), "OTHER\n");
  let received = "";
  const server = net.createServer((socket) => socket.on("data", (d) => (received += d)).end("REPLY\n")).listen(path.join(other, "app.sock"));
  await once(server, "listening");
  t.after(() => server.close());
  const profile = toolsProfile({ home: os.homedir(), unreadable: [data], own: [own], folder, readOnly: [], temp, proxyPort: 4000 });
  const sh = (script: string) => new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script], { cwd: folder });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (status) => resolve({ status, stdout }));
  });
  const reached = await sh(`printf hello | /usr/bin/nc -U ${other}/app.sock`);
  assert.equal(received, "", "nothing reached the other program's socket");
  assert.doesNotMatch(reached.stdout, /REPLY/);
  assert.notEqual((await sh(`cat ${other}/state.txt`)).status, 0, "another program's file in the temporary folder cannot be read");
  assert.notEqual((await sh(`echo x > ${other}/planted.txt`)).status, 0, "nor written");
  assert.equal(fs.existsSync(path.join(other, "planted.txt")), false);
  assert.equal((await sh(`echo x > ${temp}/a && cat ${temp}/a`)).stdout, "x\n", "its own private temporary folder is read and written");
  const own2 = await sh(`/usr/bin/python3 -c "import socket,os; s=socket.socket(socket.AF_UNIX); s.bind('${temp}/s.sock'); print('bound')" 2>&1 || true`);
  assert.match(own2.stdout, /bound/, "and a socket can be made there");
});

test("a path that could break out of the profile is refused", () => {
  assert.throws(() => wholeCliProfile({ unreadable: ['/tmp/a"b'], readable: [], writable: [] }), /quote/);
});

test("the proxy variables send every connection through Botbench's proxy and leave no host out of it", () => {
  const env = proxyEnv(4321);
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) assert.equal(env[name], "http://127.0.0.1:4321", name);
  assert.equal(env.NO_PROXY, "");
  assert.equal(env.no_proxy, "");
  assert.throws(() => toolsProfile({ home: "/Users/x", unreadable: [], own: [], folder: "/tmp/f", readOnly: [], temp: "/tmp/t", proxyPort: 0 }), /proxy port/);
});

test("every @ in a prompt is written as a full-width ＠, so no CLI reads it as a file to attach; nothing else changes", () => {
  assert.equal(neutralizeMentions("see @/etc/hosts and @!.env, mail a@b.c"), "see ＠/etc/hosts and ＠!.env, mail a＠b.c");
  assert.equal(neutralizeMentions("no mention"), "no mention");
});

test("a review folder is new, empty, the owner's alone, inside the data folder, and is removed by its own cleanup", () => {
  const data = tempDir("botbench-review-folder-");
  const folder = makeReviewFolder(data);
  assert.equal(path.dirname(path.dirname(folder.path)), fs.realpathSync(data));
  assert.deepEqual(fs.readdirSync(folder.path), []);
  assert.equal(fs.statSync(folder.path).mode & 0o777, 0o700);
  assert.notEqual(makeReviewFolder(data).path, folder.path);
  folder.remove();
  folder.remove();
  assert.equal(fs.existsSync(folder.path), false);
  fs.rmSync(data, { recursive: true, force: true });
});

test("at start, review folders a stopped Botbench left in its data folder are removed, and nothing else there is touched", () => {
  const data = tempDir("botbench-review-leftovers-");
  const left = makeReviewFolder(data);
  fs.mkdirSync(path.join(left.path, ".agents", "agents"), { recursive: true });
  fs.writeFileSync(path.join(left.path, ".agents", "agents", "botbench-review.md"), "x");
  fs.writeFileSync(path.join(data, "keep.txt"), "keep");
  assert.equal(removeLeftoverReviewFolders(data), 1);
  assert.deepEqual(fs.readdirSync(path.join(data, "reviewers")), []);
  assert.equal(fs.readFileSync(path.join(data, "keep.txt"), "utf8"), "keep");
  assert.equal(removeLeftoverReviewFolders(path.join(data, "never-made")), 0, "a data folder with no review folders is fine");
  fs.rmSync(data, { recursive: true, force: true });
});
