import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { confinementProblem, HOME_SECRETS, hostProblem, SANDBOX_EXEC, seatbeltProfile, startHostProxy, unreadablePaths } from "../src/confinement.ts";
import { tempDir } from "./support/repo.ts";
import { NO_SANDBOX } from "./support/confined.ts";

// What Botbench keeps every command an agent runs, and every setup and check command it runs itself, away from (U27).
// Everything here is real: real folders and links, the real sandbox-exec of this Mac, a real local proxy and real sockets.

test("the places no confined command may read name every vendor sign-in, the Keychain, SSH and cloud credentials, and Botbench's own data folder", () => {
  const home = os.homedir();
  const dataDir = tempDir("botbench-confine-data-");
  const paths = unreadablePaths({ dataDir });
  for (const place of [".claude", ".claude.json", ".codex", ".grok", ".gemini", ".antigravity", "Library/Application Support/Antigravity", "Library/Keychains", ".ssh", ".gnupg", ".aws", ".config/gcloud", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".config/gh", ".git-credentials", ".config/git/credentials"]) {
    assert.ok(HOME_SECRETS.includes(place), `${place} is on the list`);
    assert.ok(paths.includes(path.join(home, place)), `${place} is denied by its full path`);
  }
  assert.ok(paths.includes(dataDir), "the data folder itself");
  // Every entry is a full path: no ~ for anyone to read differently, no pattern.
  for (const entry of paths) assert.ok(path.isAbsolute(entry) && !/[*?[\]~]/.test(entry), entry);
  assert.equal(new Set(paths).size, paths.length, "no entry twice");
  // A folder the owner moved a CLI's sign-in to is added.
  assert.ok(unreadablePaths({ dataDir, also: ["/opt/elsewhere/claude-config"] }).includes("/opt/elsewhere/claude-config"));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a denied place reached through a link is denied both where the link is and where it leads", (t) => {
  const dir = tempDir("botbench-confine-link-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, "real-data");
  fs.mkdirSync(real);
  const link = path.join(dir, "data-link");
  fs.symlinkSync(real, link);
  const paths = unreadablePaths({ dataDir: link, home: dir });
  assert.ok(paths.includes(link));
  assert.ok(paths.includes(real));
});

test("on this Mac Botbench can confine commands; elsewhere, or without sandbox-exec, it says why it cannot, in plain words", () => {
  // This computer as it is: a Mac with /usr/bin/sandbox-exec can confine; the Linux CI runner cannot, and says so.
  if (process.platform === "darwin") assert.equal(confinementProblem(), null, "macOS with /usr/bin/sandbox-exec");
  else assert.match(confinementProblem() ?? "", new RegExp(`only on macOS, and this computer runs ${process.platform}\\.`));
  const linux = confinementProblem({ platform: "linux" });
  assert.match(linux ?? "", /only on macOS/);
  const missing = confinementProblem({ platform: "darwin", sandboxExec: "/usr/bin/no-such-sandbox-exec" });
  assert.match(missing ?? "", /\/usr\/bin\/no-such-sandbox-exec/);
  assert.match(missing ?? "", /not found/);
});

test("a host the owner allows is one plain host name; anything else is refused with the rule", () => {
  for (const host of ["registry.npmjs.org", "github.com", "objects.githubusercontent.com", "pypi.org", "a-b.example.co.uk", "x1.io"]) assert.equal(hostProblem(host), null, host);
  for (const value of ["*.npmjs.org", "*", "https://github.com", "github.com/", "github.com:443", "localhost", "api.localhost", "127.0.0.1", "10.0.0.1", "[::1]", "::1", "GitHub.com", "", " github.com", "github..com", "-github.com", "github-.com", "github.com.", "github", "git hub.com", `${"a".repeat(64)}.com`, 42, null, ["github.com"]]) {
    assert.match(hostProblem(value) ?? "", /plain host name/, JSON.stringify(value));
  }
});

test("the host proxy lets a connection through to an allowed name only, never one that leads to this machine, and nothing that is not a tunnel", async (t) => {
  // An allowed name that resolves to this machine is refused all the same: the names below only test the proxy, the config refuses them.
  const proxy = await startHostProxy(["localhost", "botbench-no-such-host.invalid"]);
  t.after(() => proxy.close());
  const local = net.createServer((socket) => socket.end("local service\n"));
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  t.after(() => local.close());
  const localPort = (local.address() as net.AddressInfo).port;

  /** Send one request to the proxy and read its status line. */
  const ask = (request: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => socket.write(request));
      let answer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        answer += chunk;
        if (answer.includes("\r\n")) {
          resolve(answer.split("\r\n")[0]!);
          socket.destroy();
        }
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(answer.split("\r\n")[0] ?? ""));
    });
  assert.match(await ask("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"), /^HTTP\/1\.1 403/, "a name not on the list");
  assert.match(await ask(`CONNECT localhost:${localPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`), /^HTTP\/1\.1 403/, "an allowed name that leads to this machine");
  assert.match(await ask(`CONNECT 127.0.0.1:${localPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`), /^HTTP\/1\.1 403/, "an address");
  assert.match(await ask("CONNECT botbench-no-such-host.invalid:443 HTTP/1.1\r\nHost: x\r\n\r\n"), /^HTTP\/1\.1 (403|502)/, "an allowed name that does not resolve");
  assert.match(await ask("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"), /^HTTP\/1\.1 403/, "a plain request");
});

test("a provider's proxy lets through its domain and the names under it, and nothing that only looks like them", async (t) => {
  // `.invalid` never resolves: an allowed name gets past the list and fails to resolve (502); a refused one is 403.
  const proxy = await startHostProxy([], ["botbench-provider.invalid"]);
  t.after(() => proxy.close());
  const status = (host: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
      let answer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        answer += chunk;
        if (answer.includes("\r\n")) (resolve(answer.split("\r\n")[0]!), socket.destroy());
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(answer.split("\r\n")[0] ?? ""));
    });
  assert.match(await status("botbench-provider.invalid"), /^HTTP\/1\.1 502/, "the domain itself");
  assert.match(await status("api.botbench-provider.invalid"), /^HTTP\/1\.1 502/, "a name under it");
  for (const host of ["xbotbench-provider.invalid", "botbench-provider.invalid.example.com", "example.com", "localhost"]) assert.match(await status(host), /^HTTP\/1\.1 403/, host);
});

test("a vendor sign-in folder the environment moved elsewhere is unreadable too, and so is Botbench's data folder under its old name", () => {
  const paths = unreadablePaths({ dataDir: "/data", env: { CLAUDE_CONFIG_DIR: "/opt/claude-config", CODEX_HOME: "/opt/codex-home", OTHER: "/opt/other" } });
  assert.ok(paths.includes("/opt/claude-config") && paths.includes("/opt/codex-home") && !paths.includes("/opt/other"));
  assert.ok(paths.includes(path.join(os.homedir(), ".smelt")));
  // A relative value is not a place anyone can name for the sandbox, and is left out rather than guessed at.
  assert.equal(unreadablePaths({ dataDir: "/data", env: { CLAUDE_CONFIG_DIR: "claude" } }).some((p) => p.endsWith("/claude")), false);
});

const BROWSER_PROFILES = [
  "Library/Safari",
  "Library/Cookies",
  "Library/Containers/com.apple.Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/Firefox",
];

test("the browsers' profile folders are on the one list, so no confined command reads a saved Botbench session cookie or anything else a browser keeps", () => {
  const home = tempDir("botbench-confine-home-");
  const paths = unreadablePaths({ dataDir: path.join(home, "data"), home });
  for (const place of BROWSER_PROFILES) {
    assert.ok(HOME_SECRETS.includes(place), `${place} is on the list`);
    assert.ok(paths.includes(path.join(home, place)), `${place} is denied by its full path`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("a cookie file in a browser profile is refused to a command under the real sandbox-exec, as the list makes its profile", { skip: NO_SANDBOX }, (t) => {
  const dir = fs.realpathSync(tempDir("botbench-confine-browser-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const copy = path.join(dir, "copy");
  fs.mkdirSync(copy, { recursive: true });
  const cookies = path.join(home, "Library/Application Support/Firefox/Profiles/x.default/cookies.sqlite");
  fs.mkdirSync(path.dirname(cookies), { recursive: true });
  fs.writeFileSync(cookies, "DECOY-cookie-botbench_session\n");
  const profile = seatbeltProfile({ worktree: copy, unreadable: unreadablePaths({ dataDir: path.join(dir, "data"), home }), writable: [] });
  const read = spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/cat", cookies], { cwd: copy, encoding: "utf8" });
  assert.notEqual(read.status, 0);
  assert.equal(read.stdout.includes("DECOY"), false);
  assert.match(read.stderr, /Operation not permitted/);
  // The same file outside the list's places is read, so the refusal is the list's.
  const plain = path.join(dir, "plain.txt");
  fs.writeFileSync(plain, "DECOY-plain\n");
  assert.equal(spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/cat", plain], { cwd: copy, encoding: "utf8" }).stdout, "DECOY-plain\n");
});
