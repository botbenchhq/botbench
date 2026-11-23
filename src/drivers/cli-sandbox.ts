import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ancestors, SANDBOX_EXEC, startHostProxy } from "../confinement.ts";

/*
 * For a reviewer CLI that is started with no tools at all (Grok, Antigravity): the whole CLI process, and anything it
 * starts, runs under macOS's sandbox-exec with a profile made here. The CLI must read its own sign-in to work, so its
 * own folder is opened again for it; every other place of the shared list in src/confinement.ts, and Botbench's data
 * folder, stays unreadable, and nothing is written but the CLI's own folder, the review folder and the temporary
 * folder. The network stays open: the CLI reaches its provider, and with no tools that is the only use it has. This is
 * acceptable only together with no tools: a command the CLI ran would read the CLI's own sign-in.
 * Seen on macOS 27.2 with Grok 1.0.92 and Antigravity 1.5.14: both run under it, signed in, and a later allow rule wins
 * over an earlier deny, as for the profile of setup and check commands.
 */

/** A path as a string of the sandbox profile language. A path that could break out of the string is refused. */
function quoted(place: string): string {
  if (/[\0-\x1f"\\]/.test(place)) throw new Error(`Botbench cannot confine a reviewer with the path ${JSON.stringify(place)}: it holds a quote, a backslash or a control character.`);
  return `"${place}"`;
}

const subpaths = (places: readonly string[]): string => places.map((place) => `(subpath ${quoted(place)})`).join(" ");

/** The real temporary folder, where CLIs keep short-lived files. */
const tempFolders = (): string[] => {
  const tmp = os.tmpdir();
  let real = tmp;
  try {
    real = fs.realpathSync(tmp);
  } catch {
    // Kept as written.
  }
  return [...new Set([tmp, real])];
};

/**
 * The profile for a whole reviewer CLI: reading `unreadable` is denied, then `readable` is opened again; writing is
 * denied but in `writable`, the temporary folder and the terminal devices; and nothing the CLI starts can open an app
 * or send Apple events, which would run outside the sandbox.
 */
export function wholeCliProfile(o: { unreadable: readonly string[]; readable: readonly string[]; writable: readonly string[]; noKeychain?: boolean }): string {
  const lines = ["(version 1)", "(allow default)"];
  if (o.unreadable.length > 0) lines.push(`(deny file-read* ${subpaths(o.unreadable)})`);
  if (o.readable.length > 0) lines.push(`(allow file-read* ${subpaths(o.readable)})`);
  lines.push(
    "(deny file-write*)",
    `(allow file-write* ${subpaths([...o.writable, ...tempFolders()])} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    "(deny lsopen)",
    "(deny appleevent-send)",
    ...(o.noKeychain === true ? [KEYCHAIN_DENIED] : []),
    "",
  );
  return lines.join("\n");
}

/*
 * The Keychain's services, refused to a CLI whose sign-in must stay out of the owner's Keychain (Antigravity with
 * Botbench's own profile). Its files in ~/Library/Keychains are on the shared list already; these are the services a
 * program asks to read or write an item. Seen on macOS 27.2 with Antigravity 1.5.14: with them refused, `agy` reads no
 * sign-in from the Keychain, and still verifies TLS to Google (trustd is not refused).
 */
export const KEYCHAIN_DENIED = '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.keychain-circle-notification"))';

/*
 * For a CLI that has its own tools and cannot ask Botbench before it uses one (Grok in a chat or a review): the
 * sandbox is the control, so it is drawn tight around the whole process and everything it starts.
 * - Reading: the whole home folder, every place of the shared list in src/confinement.ts and Botbench's data folder are
 *   denied. Opened again: the places it may only read (an attached repository and its git folder, or the task's copy),
 *   then, after the shared list (not the data folder, which holds a task's copy) is denied once more so that a
 *   repository holding a secret place does not open it, the CLI's own folders and its working folder. System folders and the CLI's own program stay readable, as the CLI
 *   needs them to run.
 * - Temporary files: a private temporary folder for this one process. The shared one is unreadable and unwritable, and
 *   its Unix sockets unreachable: other programs keep files and sockets there (Chrome's SingletonSocket opens any address
 *   it is sent, which would reach past the sandbox). Seen on macOS 27.2: with the shared one open, a command reached a
 *   socket another program listened on there.
 * - Writing: nothing but the CLI's own folders, its working folder, its private temporary folder and the terminal
 *   devices; a read-only place stays unwritable even where it lies inside one of those.
 * - Network: none, but Botbench's proxy on this Mac's loopback address, which opens a tunnel only to the vendor's own
 *   provider (`startProviderProxy`), and Unix sockets in the CLI's own folders, its working folder and its private
 *   temporary folder. A command the CLI runs gets the same: its provider, and nothing else, nowhere on this Mac or its network.
 * Known limit, stated in the threat model: the CLI must read its own sign-in to work, so a command it runs can read it
 * too, and could send it to the provider that issued it.
 */

/** Where a CLI with its own tools works, and what it may reach. */
export interface ToolsPlaces {
  /** The owner's home folder. */
  home: string;
  /** The shared list of secret places and Botbench's data folder (unreadablePaths in src/confinement.ts). */
  unreadable: readonly string[];
  /**
   * The places of `unreadable` denied again after the read-only places are opened: the shared list without Botbench's
   * data folder, which holds a task's copy (a review reads it). All of `unreadable` when left out.
   */
  secrets?: readonly string[];
  /** The CLI's own folders, where it keeps its sign-in, settings and sessions: read and written. */
  own: readonly string[];
  /** The folder it works in: read and written. */
  folder: string;
  /**
   * A new, private temporary folder for this one process (TMPDIR points at it): read, written, and the only place outside
   * its own folders where it may make or reach a Unix socket. The shared temporary folder holds other programs' files and
   * sockets (on this Mac: Chrome's SingletonSocket, which opens any address it is sent, and other sandboxes' proxy sockets),
   * so it is neither read, written nor reached.
   */
  temp: string;
  /** Places it may read and never change. */
  readOnly: readonly string[];
  /** The port of Botbench's proxy to the provider. */
  proxyPort: number;
  /**
   * The CLI's own program, when only it may use its own folders (Antigravity): every other process of the turn, the
   * commands it runs among them, can neither read nor write them, nor reach a socket there, nor start the program again.
   * Left out, every process of the turn may use them (Grok, the known limit below).
   */
  ownProgram?: string;
  /** Rules added at the end, which win over every rule above (sandbox-exec: the last matching rule decides). */
  extra?: readonly string[];
}

/**
 * The rules that keep the CLI's own folders to the CLI's own program (`ownProgram`). Measured on macOS 27.2: a
 * `(process-path …)` filter decides file reads by the program that asks, so `cat` was refused a file `head` could
 * read under one profile.
 */
export function ownProgramOnly(o: { own: readonly string[]; program: string; starter: string }): string[] {
  const program = quoted(o.program);
  const others = `(require-not (process-path ${program}))`;
  return [
    ...bothNames(o.own).flatMap((place) => [
      `(deny file-read* file-write* (require-all (subpath ${quoted(place)}) ${others}))`,
      `(deny network-outbound (require-all (remote unix-socket (subpath ${quoted(place)})) ${others}))`,
    ]),
    // A command cannot start the program again to make it read its own folders for it: only sandbox-exec, which
    // starts the turn, and the program itself may.
    `(deny process-exec (require-all (literal ${program}) ${others} (require-not (process-path ${quoted(o.starter)}))))`,
  ];
}

const realOrAsIs = (place: string): string => {
  try {
    return fs.realpathSync(place);
  } catch {
    return path.resolve(place);
  }
};

/** `places` as written and as their links lead, so a rule holds for both names. */
const bothNames = (places: readonly string[]): string[] => [...new Set(places.flatMap((place) => [path.resolve(place), realOrAsIs(place)]))];

/** The profile for a whole CLI that has its own tools, as described above. */
export function toolsProfile(o: ToolsPlaces): string {
  if (!Number.isSafeInteger(o.proxyPort) || o.proxyPort < 1 || o.proxyPort > 65535) throw new Error(`Botbench cannot confine an agent with the proxy port ${o.proxyPort}.`);
  const own = bothNames(o.own);
  const folder = bothNames([o.folder]);
  const readOnly = bothNames(o.readOnly);
  const temp = bothNames([o.temp]);
  const opened = [...own, ...folder, ...readOnly, ...temp];
  const metadata = [...new Set(opened.flatMap(ancestors))].filter((place) => !opened.includes(place));
  const sockets = [...own, ...folder, ...temp];
  const lines = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${subpaths(bothNames([o.home]))} ${subpaths(tempFolders())} ${subpaths(o.unreadable)})`,
  ];
  if (readOnly.length > 0) lines.push(`(allow file-read* ${subpaths(readOnly)})`);
  lines.push(
    `(deny file-read* ${subpaths(o.secrets ?? o.unreadable)})`,
    `(allow file-read* ${subpaths([...own, ...folder, ...temp])})`,
    // The folders above an opened place may be looked at, not listed or read: paths are resolved through them.
    ...(metadata.length > 0 ? [`(allow file-read-metadata ${metadata.map((place) => `(literal ${quoted(place)})`).join(" ")})`] : []),
    "(deny file-write*)",
    `(allow file-write* ${subpaths([...own, ...folder, ...temp])} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
  );
  if (readOnly.length > 0) lines.push(`(deny file-write* ${subpaths(readOnly)})`);
  lines.push(
    "(deny network*)",
    `(allow network-outbound (remote ip "localhost:${o.proxyPort}"))`,
    // One rule per place: seen on macOS 27.2, a second `subpath` in the same filter is not matched (src/confinement.ts).
    ...sockets.flatMap((place) => [`(allow network-bind (local unix-socket (subpath ${quoted(place)})))`, `(allow network-outbound (remote unix-socket (subpath ${quoted(place)})))`]),
    "(deny lsopen)",
    "(deny appleevent-send)",
    ...(o.ownProgram === undefined ? [] : ownProgramOnly({ own: o.own, program: o.ownProgram, starter: SANDBOX_EXEC })),
    ...(o.extra ?? []),
    "",
  );
  return lines.join("\n");
}

/** The variables that send a CLI's connections through Botbench's proxy on `port`, and leave no host out of it. */
export function proxyEnv(port: number): Record<string, string> {
  const at = `http://127.0.0.1:${port}`;
  return { HTTPS_PROXY: at, https_proxy: at, HTTP_PROXY: at, http_proxy: at, ALL_PROXY: at, all_proxy: at, NO_PROXY: "", no_proxy: "" };
}

/**
 * Botbench's proxy for one CLI process: a tunnel to `domains` and the names under them, its vendor's own provider, and
 * to nothing else (startHostProxy in src/confinement.ts, which also refuses any name that leads to this Mac).
 */
export const startProviderProxy = (domains: readonly string[]): Promise<{ port: number; close(): Promise<void> }> => startHostProxy([], domains);

/** Whether `place`, links resolved, is one of `folders` or inside one. */
function inside(place: string, folders: readonly string[]): boolean {
  return folders.some((folder) => place === folder || place.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`));
}

/**
 * The prompt with each `@` that could make the CLI attach a file it may not read written as a full-width `＠`. Grok
 * reads `@path` in a prompt as a file to attach and sends its content to its model (see neutralizeMentions). An `@`
 * is kept only when the word after it (up to the next blank, a `:12` or `:L12-20` line range set aside) names, from
 * `cwd`, something that exists and whose real path, every link resolved, is inside one of `allowed`, themselves
 * resolved. Anything else (a path outside, a link that leads out, a `~`, a name that does not exist, an address such
 * as a@b.c) is written as `＠`. Returns the prompt and how many were rewritten.
 */
export function limitMentions(prompt: string, o: { cwd: string; allowed: readonly string[] }): { prompt: string; rewritten: number } {
  const allowed = o.allowed.map(realOrAsIs);
  let rewritten = 0;
  const text = prompt.replace(/@(\S*)/g, (_whole, word: string) => {
    const named = word.replace(/:L?\d+(-L?\d+)?$/, "");
    let keep = false;
    if (named !== "" && !named.startsWith("~") && !named.includes("@")) {
      try {
        keep = inside(fs.realpathSync(path.resolve(o.cwd, named)), allowed);
      } catch {
        keep = false;
      }
    }
    if (keep) return `@${word}`;
    // Every `@` of the word: one further inside it (`@x@/etc/hosts`) is a mention of its own.
    rewritten += 1 + (word.match(/@/g)?.length ?? 0);
    return `＠${neutralizeMentions(word)}`;
  });
  return { prompt: text, rewritten };
}

/** `command` with `args`, started under `profile`. */
export function sandboxed(profile: string, command: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: SANDBOX_EXEC, args: ["-p", profile, command, ...args] };
}

/**
 * The prompt with every `@` written as a full-width `＠`. Grok 1.0.92 reads `@path` in a prompt, even with
 * --verbatim and even in headless mode, as a file to attach and sends the file's content to its model; a diff is data
 * that may hold such a word. Seen: `@/tmp/x` was attached, `＠/tmp/x` was not.
 */
export const neutralizeMentions = (prompt: string): string => prompt.replaceAll("@", "＠");

/** A new, empty folder the owner alone can use, inside Botbench's data folder, for one review: the CLI works there, not in the task's copy. */
export function makeReviewFolder(dataDir: string): { path: string; remove(): void } {
  const parent = path.join(fs.realpathSync(dataDir), "reviewers");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const folder = path.join(parent, crypto.randomUUID());
  fs.mkdirSync(folder, { mode: 0o700 });
  return { path: folder, remove: () => fs.rmSync(folder, { recursive: true, force: true }) };
}

/**
 * Remove every review folder left in `dataDir` by a Botbench that stopped mid-review. Called once at start, before any
 * review can begin. Returns how many were removed.
 */
export function removeLeftoverReviewFolders(dataDir: string): number {
  const parent = path.join(dataDir, "reviewers");
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return 0;
  }
  for (const name of names) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
  return names.length;
}
