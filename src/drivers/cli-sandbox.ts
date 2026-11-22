import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SANDBOX_EXEC } from "../confinement.ts";

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
export function wholeCliProfile(o: { unreadable: readonly string[]; readable: readonly string[]; writable: readonly string[] }): string {
  const lines = ["(version 1)", "(allow default)"];
  if (o.unreadable.length > 0) lines.push(`(deny file-read* ${subpaths(o.unreadable)})`);
  if (o.readable.length > 0) lines.push(`(allow file-read* ${subpaths(o.readable)})`);
  lines.push(
    "(deny file-write*)",
    `(allow file-write* ${subpaths([...o.writable, ...tempFolders()])} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    "(deny lsopen)",
    "(deny appleevent-send)",
    "",
  );
  return lines.join("\n");
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
