import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/*
 * What every command an agent runs, and every setup and check command Botbench runs itself, is kept from (U27,
 * ADR 0002 step 1). One list of places for both:
 * - An agent's commands run in Claude Code's own sandbox, configured by the driver from this list (src/drivers/claude-code.ts).
 * - Setup and check commands run under macOS's sandbox-exec with a profile made here (src/engine/stations.ts).
 * Both rest on macOS Seatbelt, which Apple marks deprecated; every vendor CLI relies on it too.
 *
 * Seen on this Mac (macOS 27.2, 2026-11-22): in a sandbox-exec profile a later rule wins over an earlier one, so a
 * task's copy that lies inside the denied data folder is opened again by an allow rule after the deny; the rules hold
 * for every child process; `(remote ip "localhost:<port>")` lets a command reach one local port and nothing else; with
 * the network denied, a name does not even resolve. Allowing `(remote ip "localhost:*")` does not change that: names
 * resolve through a Unix socket outside the copy.
 */

/** The places in the owner's home folder no confined command may read: vendor sign-ins, the Keychain, keys and cloud credentials. */
export const HOME_SECRETS: readonly string[] = [
  // Vendor sign-ins and the CLIs' own settings.
  ".claude",
  ".claude.json",
  ".codex",
  ".grok",
  ".gemini",
  ".antigravity",
  "Library/Application Support/Antigravity",
  // Measured on 2026-11-22: without this, a sandboxed command could read Claude Code's sign-in from the Keychain.
  "Library/Keychains",
  // Keys.
  ".ssh",
  ".gnupg",
  // Cloud, registry and git-host credentials.
  ".aws",
  ".config/gcloud",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".config/gh",
  ".git-credentials",
  ".config/git/credentials",
  // Package registries, build tools and services that keep a token in the home folder.
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".m2/settings.xml",
  ".gradle/gradle.properties",
  ".terraform.d",
  ".vault-token",
  ".pgpass",
  ".yarnrc.yml",
  ".config/op",
  ".password-store",
  ".config/configstore",
  // Browser profiles: cookies (a saved Botbench session among them), saved passwords and history. A confined command
  // can reach this Mac's own ports, Botbench's included, so a session cookie read here could act as the owner.
  "Library/Safari",
  "Library/Cookies",
  "Library/Containers/com.apple.Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/Firefox",
  // Shell history, which often holds a token typed on a command line.
  ".zsh_history",
  ".bash_history",
  // Botbench's own data folder under the product's old name, which an installation from before the rename may have left.
  ".smelt",
];

/** Folders a vendor CLI keeps its sign-in in when the owner moved it, named by the variable the CLI reads. */
export const MOVED_SIGN_INS: readonly string[] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"];

/** Where one confined command runs and what it may reach. */
export interface Confinement {
  /** Botbench's own data folder: its login token, database and the broker's socket. Unreadable, except the folder the command works in. */
  dataDir: string;
  /** The host names the repository's settings allow commands to reach. None means no network at all. */
  allowedHosts: readonly string[];
  /** The repository's shared git folder: readable, so git works in a task's copy, and never written by a command. */
  gitDir?: string;
}

/** `target` and, when a link leads elsewhere, where it leads, both as full paths. A place that does not exist yet is kept as written. */
export function bothPaths(target: string): string[] {
  const written = path.resolve(target);
  let real = written;
  try {
    real = fs.realpathSync(written);
  } catch {
    // Not there yet: it is denied by its name, so it stays denied when it appears.
  }
  return real === written ? [written] : [written, real];
}

/**
 * Every place no confined command may read, as full paths: the home folder's secret places, a vendor sign-in folder the
 * environment moved elsewhere, `also`, and the data folder.
 */
export function unreadablePaths(o: { dataDir: string; home?: string; also?: readonly string[]; env?: NodeJS.ProcessEnv }): string[] {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const moved = MOVED_SIGN_INS.map((name) => env[name]).filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
  const places = [...HOME_SECRETS.map((place) => path.join(home, place)), ...moved, ...(o.also ?? []), o.dataDir].flatMap(bothPaths);
  return [...new Set(places)];
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Why commands cannot be confined on this computer, in words for the owner, or null when they can. Botbench confines
 * commands with macOS's sandbox only, so anywhere else nothing an agent would run is started.
 */
export function confinementProblem(o: { platform?: NodeJS.Platform; sandboxExec?: string } = {}): string | null {
  const platform = o.platform ?? process.platform;
  const sandboxExec = o.sandboxExec ?? SANDBOX_EXEC;
  if (platform !== "darwin") return `Botbench keeps the commands an agent runs away from your sign-ins and the network only on macOS, and this computer runs ${platform}. No agent is started.`;
  if (!fs.existsSync(sandboxExec)) return `Botbench cannot keep the commands an agent runs away from your sign-ins and the network: macOS's ${sandboxExec} was not found. No agent is started.`;
  return null;
}

export const HOST_RULE = "A host is a plain host name such as registry.npmjs.org, in lower case: no wildcard, no address, no port, no https:// and no path, and not localhost.";
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why `value` cannot be allowed as a host commands may reach, or null when it can. */
export function hostProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return HOST_RULE;
  const labels = value.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return HOST_RULE;
  // A last part of digits only is an address, not a name; localhost is this machine.
  if (/^[0-9]+$/.test(labels.at(-1)!) || labels.at(-1) === "localhost") return HOST_RULE;
  return null;
}

/**
 * A loopback, unspecified or link-local address (a cloud's metadata service is one): never a host the owner meant. The
 * Mac's own network addresses and private ranges are not refused: an allowed intranet name may lead to one.
 */
function local(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (net.isIPv4(v4)) return /^(127\.|0\.|169\.254\.)/.test(v4);
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fe80:");
}

/**
 * Botbench's own proxy for the setup and check commands of a repository that allows hosts. It opens a tunnel
 * (HTTP CONNECT) to an allowed host name only, on any port, and to nothing that resolves to this machine; it answers
 * anything else with 403. It listens on the loopback address, which a confined command may reach.
 * It filters by the name the command asks for and does not look inside the encrypted connection. `domains` also allows
 * every name under each of them (`x.ai` allows `api.x.ai`): for a vendor CLI's own provider, whose hosts the vendor
 * may change (src/drivers/cli-sandbox.ts).
 */
export function startHostProxy(hosts: readonly string[], domains: readonly string[] = []): Promise<{ port: number; close(): Promise<void> }> {
  const exact = new Set(hosts);
  const allowed = { has: (host: string): boolean => exact.has(host) || domains.some((domain) => host === domain || host.endsWith(`.${domain}`)) };
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Botbench's proxy only opens tunnels (CONNECT) to the hosts it allows.\n");
  });
  const refuse = (socket: net.Socket, why: string): void => {
    socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${why}\n`);
  };
  server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const match = /^([^:\s]+):(\d{1,5})$/.exec(req.url ?? "");
    const host = match?.[1]?.toLowerCase() ?? "";
    const port = Number(match?.[2]);
    if (!match || !allowed.has(host) || port < 1 || port > 65535) return refuse(socket, `${req.url ?? ""} is not a host Botbench allows here.`);
    void dns.lookup(host, { all: true }).then(
      (addresses) => {
        // Connect to the address that was checked, so the name cannot point somewhere else in between.
        const address = addresses[0]?.address;
        if (address === undefined || addresses.some((a) => local(a.address))) return refuse(socket, `${host} leads to this machine.`);
        const upstream = net.connect(port, address, () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        sockets.add(upstream);
        upstream.on("close", () => (sockets.delete(upstream), socket.destroy()));
        upstream.on("error", () => (socket.writable && !socket.writableEnded ? socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n") : socket.destroy()));
        socket.on("close", () => upstream.destroy());
      },
      () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"),
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A path as a string of the sandbox profile language. A path that could break out of the string is refused. */
function quoted(place: string): string {
  if (/[\0-\x1f"\\]/.test(place)) throw new Error(`Botbench cannot confine a command with the path ${JSON.stringify(place)}: it holds a quote, a backslash or a control character.`);
  return `"${place}"`;
}

/** Every folder above `place`, up to the root. */
export function ancestors(place: string): string[] {
  const found: string[] = [];
  for (let at = path.dirname(place); ; at = path.dirname(at)) {
    found.push(at);
    if (at === path.dirname(at)) return found;
  }
}

/**
 * The sandbox-exec profile for one setup or check command. Everything is allowed but: reading the unreadable places
 * (then the copy is opened again, as it may lie inside one of them), writing anywhere but the copy, the command's own
 * temporary folder and the terminal devices, and the network, apart from this Mac's own addresses (where Botbench's
 * proxy listens when hosts are allowed) and Unix sockets in the copy and the temporary folder.
 */
export function seatbeltProfile(o: { worktree: string; unreadable: readonly string[]; writable: readonly string[]; chrome?: { userTemp: string } }): string {
  const subpaths = (places: readonly string[]): string => places.map((place) => `(subpath ${quoted(place)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${subpaths(o.unreadable)})`,
    `(allow file-read* ${subpaths([o.worktree])})`,
    // The folders above the copy may be looked at, not listed or read: git and others resolve the copy's path through them.
    `(allow file-read-metadata ${ancestors(o.worktree).map((place) => `(literal ${quoted(place)})`).join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* ${subpaths([o.worktree, ...o.writable])} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    "(deny network*)",
    // A project's own tests start servers. Seen on macOS 27.2: listening needs network-inbound, and Seatbelt's only
    // host names are `*` and `localhost`, where `localhost` means any address of this Mac, so a server listening on all
    // addresses is not refused (see the threat model). Connecting to `localhost` reaches this Mac's own addresses on any
    // port, Botbench's proxy among them, and nothing beyond it.
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    // Unix sockets in the copy and the temporary folder only, one rule per place: seen on macOS 27.2, a second
    // `subpath` in the same filter is not matched.
    ...[o.worktree, ...o.writable].flatMap((place) => [`(allow network-bind (local unix-socket (subpath ${quoted(place)})))`, `(allow network-outbound (remote unix-socket (subpath ${quoted(place)})))`]),
    // Seen on macOS 27.2: without these, `open` of an app the command wrote starts it through launchd, unconfined, with
    // the owner's full rights; with them `open` fails (error -54) and nothing escapes.
    "(deny lsopen)",
    "(deny appleevent-send)",
    ...(o.chrome === undefined ? [] : chromeRules(o.chrome.userTemp)),
    "",
  ].join("\n");
}

/**
 * What a machine check that needs Chrome is allowed beyond a check (engine/machine-checks.ts, #201). Measured on this Mac
 * (macOS 27.2, Chrome 156, 2026-11-23): under a check's profile, headless Chrome exits at once, "Failed to create socket
 * directory": it makes the folder for its one-instance lock and socket in the user's own temporary folder, which
 * macOS names (`getconf DARWIN_USER_TEMP_DIR`), whatever TMPDIR says. These rules allow writing, and Unix sockets,
 * only in folders there whose names start as Chrome's and Chromium's do. Nothing else changes: no other place may be
 * written or read, and the network stays as it is for a check. Chrome's own sandbox cannot start inside this one
 * (macOS starts no sandbox inside another), so Chrome must be started with --no-sandbox, as Playwright starts it by
 * default: this profile, not Chrome's, is then what holds it.
 */
export function chromeRules(userTemp: string): string[] {
  const top = path.resolve(userTemp);
  quoted(top);
  const escaped = top.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  const place = `^${escaped}/(com\\.google\\.Chrome|org\\.chromium\\.Chromium)\\.[^/]+`;
  return [
    `(allow file-write* (regex #"${place}(/.*)?$"))`,
    `(allow network-bind (local unix-socket (regex #"${place}/")))`,
    `(allow network-outbound (remote unix-socket (regex #"${place}/")))`,
  ];
}
