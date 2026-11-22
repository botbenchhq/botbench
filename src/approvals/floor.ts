import path from "node:path";
import { roughSegments, splitPlain } from "./shell.ts";

/*
 * The safety floor: the commands that always ask the owner, whatever grants exist. It is a short table of
 * named rules over the words of a command. No request from a client changes it; the owner's config file
 * may add entries and can take none away.
 *
 * The floor leans towards asking. A rule looks at every word of the command as if a program could start
 * there, so `env sudo ls` and `xargs rm -rf` are caught, and so is `echo sudo`: asking once too often is
 * the cheap mistake. An argument that holds a command of its own (`env -S 'sudo ls'`) is read as one too.
 * The floor reads the command line only. What a program then does (a script's content, an alias, an npm
 * script) is not seen here, and the floor names known dangerous forms, not everything that can do harm.
 * It decides from the text and the context it is given; it touches the file system only through `real`.
 */

export interface FloorEntry {
  name: string;
  /** The entry's program and the words that, found in this order anywhere after it, make a command ask. */
  words: readonly string[];
}

export interface FloorContext {
  /** The task's worktree, as a full path. */
  worktree: string;
  /** The directory the command would run in, as a full path. */
  cwd: string;
  /** The owner's home directory. */
  home: string;
  /** Smelt's data directory: its records and every other task's worktree. Left out, nothing of Smelt's is guarded. */
  dataDir?: string;
  /** Follows the links in a full path. Left out, paths are taken as written. */
  real?: (absolute: string) => string;
  /** Entries the owner's config adds. */
  extra?: readonly FloorEntry[];
}

/** One command between operators, as words. */
type Words = readonly string[];
interface Reading {
  /** The command's pieces: its words when it is a plain command, one piece per stretch between operators when it is not, and one more for each argument that holds a command of its own. */
  segments: readonly Words[];
  plain: boolean;
  raw: string;
  ctx: FloorContext;
}

export interface FloorRule {
  name: string;
  matches(reading: Reading): boolean;
}

/** The program a word would start: its last path part, in lower case, because this file system ignores case. */
const program = (word: string): string => word.slice(word.lastIndexOf("/") + 1).toLowerCase();

/** Whether some word of some piece starts one of `programs` and `then` holds for the words after it (`before` are the words in front). */
const runs = (reading: Reading, programs: (name: string) => boolean, then: (rest: Words, before: Words) => boolean = () => true): boolean =>
  reading.segments.some((segment) => segment.some((word, i) => programs(program(word)) && then(segment.slice(i + 1), segment.slice(0, i))));

const oneOf = (...names: string[]): ((name: string) => boolean) => {
  const set = new Set(names);
  return (name) => set.has(name);
};

const within = (root: string, p: string): boolean => {
  const relative = path.relative(root, p);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Where a word points as a full path, or null when that cannot be known from the text (a variable, a glob, any `~` form but the owner's own home). */
function target(word: string, reading: Reading): string | null {
  if (/[*?[\]{}$`]/.test(word)) return null;
  if (word === "~" || word.startsWith("~/")) return path.join(reading.ctx.home, word.slice(1));
  if (word.startsWith("~")) return null;
  // After a `cd` in a chained command nobody knows where a relative path starts.
  if (!path.isAbsolute(word) && !reading.plain && reading.segments.some((segment) => oneOf("cd", "pushd", "popd")(program(segment[0]!)))) return null;
  return path.resolve(reading.ctx.cwd, word);
}

/** Whether a word names a place strictly inside the worktree, as written and with links followed. A `..` is never followed. */
function insideWorktree(word: string, reading: Reading): boolean {
  if (word.split("/").includes("..")) return false;
  const full = target(word, reading);
  if (full === null) return false;
  const real = reading.ctx.real ?? ((p: string) => p);
  return within(path.resolve(reading.ctx.worktree), full) && within(real(path.resolve(reading.ctx.worktree)), real(full));
}

/** Whether a short option among `words` holds one of `letters`, or a long option is `long` or an unmistakable start of it. */
const hasOption = (words: Words, letters: string, long: string): boolean =>
  words.some((word) => (word.startsWith("--") ? word.length > 2 && long.startsWith(word) : word.startsWith("-") && [...word.slice(1)].some((c) => letters.includes(c))));

/** What a program is aimed at: every word from the first that is not an option, or from after `--`. An operand may itself start with a dash. */
const operands = (rest: Words): Words => {
  const first = rest.findIndex((word) => word === "--" || !word.startsWith("-"));
  return first === -1 ? [] : rest.slice(first).filter((word) => word !== "--");
};

/** A word after the operands began that still reads as an option (`rm sub -r`), not as a path. */
const optionShaped = (word: string): boolean => /^-[A-Za-z]+$|^--[a-z-]+$/.test(word);

/** A recursive run of a program over something that is not shown to lie inside the worktree. No operand at all shows nothing. */
const recursiveOutside = (rest: Words, letters: string, reading: Reading): boolean => {
  if (!hasOption(rest, letters, "--recursive")) return false;
  const aimedAt = operands(rest);
  return aimedAt.length === 0 || aimedAt.some((word) => !optionShaped(word) && !insideWorktree(word, reading));
};

/** `find … -delete` whose starting points are not all shown to lie inside the worktree. */
const findDeletesOutside = (rest: Words, reading: Reading): boolean => {
  if (!rest.includes("-delete")) return false;
  const expression = rest.findIndex((word) => word.startsWith("-"));
  const starts = rest.slice(0, expression);
  return starts.length === 0 || starts.some((start) => !insideWorktree(start, reading));
};

/** Subcommands and helper names by which git sends commits elsewhere. Any of them after `git` asks, wherever it stands: `git subtree push`, `git lfs push`, `git stash push` too. */
const GIT_SENDS = new Set(["push", "send-pack", "send-email", "http-push", "dcommit"]);
/** git's options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--attr-source"]);
const gitSubcommand = (rest: Words): string | null => {
  for (let i = 0; i < rest.length; i++) {
    if (GIT_VALUE_OPTIONS.has(rest[i]!)) i++;
    else if (!rest[i]!.startsWith("-")) return rest[i]!.toLowerCase();
  }
  return null;
};

const SHELLS = oneOf("sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh");
const INTERPRETERS = "(?:ba|z|da|k|fi|c|tc)?sh|python[0-9.]*|perl|ruby|node|php|osascript";
const DOWNLOADS_INTO_SHELL = [
  // curl … | sh, also through further pipes and with sudo or env in front of the shell.
  new RegExp(`\\b(?:curl|wget)\\b[^;&\\n]*\\|\\s*(?:(?:sudo|env)\\s+)?(?:\\S*/)?(?:${INTERPRETERS})\\b`, "i"),
  // sh <(curl …)
  new RegExp(`\\b(?:${INTERPRETERS})\\b[^;&|\\n]*<\\(\\s*(?:curl|wget)\\b`, "i"),
  // sh -c "$(curl …)", eval `curl …`
  new RegExp(`\\b(?:${INTERPRETERS}|eval|source)\\b[^;&|\\n]*(?:\\$\\(|\`)\\s*(?:curl|wget)\\b`, "i"),
];

/** Whether the words after a shell's name hand it text to run: `-c`, commands on its input (`-s`), a start-up file, or no script at all. */
const shellRunsText = (rest: Words): boolean =>
  rest.every((word) => word.startsWith("-") || word.startsWith("+")) ||
  rest.some((word) => word === "--rcfile" || word === "--init-file" || (word.startsWith("-") && !word.startsWith("--") && /[cs]/.test(word)));

/** Places that decide what later runs as the owner, or that hold the owner's keys and logins. Compared in lower case; an entry ending in `/` is a folder, any other the start of a name. */
const GUARDED_IN_HOME = [".ssh/", ".gnupg/", ".config/fish/", ".config/git/", ".config/zsh/", ".oh-my-zsh/", ".claude/", ".aws/", ".kube/", ".docker/", "library/keychains/", "library/launchagents/", ".zsh", ".bash", ".profile", ".gitconfig", ".npmrc", ".netrc"];
const GUARDED_ROOTS = ["/etc/", "/private/etc/", "/var/at/", "/private/var/at/", "/library/keychains/", "/library/launchagents/", "/library/launchdaemons/"];

/** The paths a word may carry: itself, the value after an `=` (`--output=…`, `of=…`), and what follows a one-letter option (`-o…`). */
const pathsIn = (word: string): string[] => [word, ...(word.includes("=") ? [word.slice(word.indexOf("=") + 1)] : []), ...(/^-[A-Za-z]./.test(word) ? [word.slice(2)] : [])];

function guardedPlace(word: string, reading: Reading): boolean {
  const { ctx } = reading;
  const real = ctx.real ?? ((p: string) => p);
  const folder = (p: string): string => `${p.toLowerCase().replace(/\/+$/, "")}/`;
  const both = (p: string): string[] => [path.resolve(p), real(path.resolve(p))];
  const under = (roots: string[], p: string): boolean => roots.some((root) => p === root || within(root, p));
  const home = folder(ctx.home);
  return pathsIn(word).some((candidate) => {
    // `~user`, `~+`, `~-`: the shell puts a directory there that the text does not show.
    if (candidate.startsWith("~") && candidate !== "~" && !candidate.startsWith("~/")) return true;
    const full = target(candidate, reading);
    if (full === null) return false;
    return both(full).some((written) => {
      const place = folder(written);
      // The home directory itself and every folder that holds it.
      if (home.startsWith(place)) return true;
      if (GUARDED_ROOTS.some((root) => place.startsWith(root))) return true;
      // Smelt's own records and other tasks' worktrees; this task's worktree is its own to work in.
      if (ctx.dataDir !== undefined && under(both(ctx.dataDir), written) && !under(both(ctx.worktree), written)) return true;
      if (!place.startsWith(home)) return false;
      const below = place.slice(home.length);
      // A guarded place, anything inside one, or a folder that holds one.
      return GUARDED_IN_HOME.some((entry) => below.startsWith(entry) || (entry.endsWith("/") && entry.startsWith(below)));
    });
  });
}

/** Device files that are no disks. */
const HARMLESS_DEVICES = /^\/dev\/(?:null|zero|stdin|stdout|stderr|tty|random|urandom|fd\/\d+)$/;
function diskDevice(word: string, reading: Reading): boolean {
  return pathsIn(word).some((candidate) => {
    const full = target(candidate, reading);
    if (full === null) return false;
    const real = reading.ctx.real ?? ((p: string) => p);
    return [full, real(full)].some((place) => place.toLowerCase().startsWith("/dev/") && !HARMLESS_DEVICES.test(place.toLowerCase()));
  });
}
const DISK_VERBS = /^(?:erase|reformat|partitiondisk|zerodisk|randomdisk|secureerase|delete|resetfusion|resize|merge|split)/;

/** The floor's own rules, in the order they are tried. The first that matches names why the command asks. */
export const FLOOR_RULES: readonly FloorRule[] = [
  {
    // `rm -r` of anything not shown to lie inside the task's worktree (`/`, `~`, any path with `..`, the worktree itself),
    // and the same for `find … -delete` and `rsync --delete…`.
    name: "recursive-delete-outside-worktree",
    matches: (r) =>
      runs(r, oneOf("rm"), (rest) => recursiveOutside(rest, "rR", r)) ||
      runs(r, oneOf("find"), (rest) => findDeletesOutside(rest, r)) ||
      runs(r, oneOf("rsync"), (rest) => rest.some((word) => word.startsWith("--del") || word === "--remove-source-files") && rest.some((word) => !word.startsWith("-") && !insideWorktree(word, r))),
  },
  {
    // Any way git sends commits elsewhere, forced or not: nothing leaves the machine without the owner.
    name: "git-push",
    matches: (r) => runs(r, oneOf("git"), (rest) => rest.some((word) => GIT_SENDS.has(word.toLowerCase()))),
  },
  {
    // git told what to run from outside its files: configuration on the command line (`-c`, `--config-env`, `--exec-path`),
    // in the environment (`GIT_…=`), or written with `git config` (an alias or `core.*` can name any program).
    name: "git-config-override",
    matches: (r) =>
      runs(r, oneOf("git"), (rest, before) => rest.some((word) => word === "-c" || word.startsWith("--config-env") || word.startsWith("--exec-path")) || before.some((word) => /^GIT_[A-Z0-9_]*=/i.test(word)) || gitSubcommand(rest) === "config"),
  },
  {
    // Running as another user.
    name: "sudo",
    matches: (r) => runs(r, oneOf("sudo", "doas", "su")),
  },
  {
    // A download handed straight to a shell or interpreter: `curl … | sh`, `bash <(curl …)`, `sh -c "$(curl …)"`.
    name: "download-into-shell",
    matches: (r) => DOWNLOADS_INTO_SHELL.some((pattern) => pattern.test(r.raw)),
  },
  {
    // A shell given text to run in place of a script file (`sh -c`, `bash -s`, `eval`), or a start-up file of the caller's choosing.
    name: "shell-runs-text",
    matches: (r) => runs(r, SHELLS, shellRunsText) || runs(r, oneOf("eval")),
  },
  {
    // `chmod -R`, `chown -R`, `chgrp -R` or `chflags -R` over anything not shown to lie inside the task's worktree.
    name: "recursive-permissions-outside-worktree",
    matches: (r) => runs(r, oneOf("chmod", "chown", "chgrp", "chflags"), (rest) => recursiveOutside(rest, "R", r)),
  },
  {
    // Tools that write or format disks, and anything aimed at a disk's device file.
    name: "disk-tool",
    matches: (r) =>
      runs(r, (name) => name.startsWith("mkfs") || name.startsWith("newfs") || name === "fdisk" || name === "gpt" || name === "asr") ||
      runs(r, oneOf("diskutil"), (rest) => rest.some((word) => DISK_VERBS.test(word.toLowerCase()))) ||
      r.segments.some((segment) => segment.some((word) => diskDevice(word, r))),
  },
  {
    // Anything aimed at the shell profiles, SSH and GnuPG folders, keychains, login items, git's and npm's own settings,
    // cloud logins, `/etc`, the home directory as a whole, or Smelt's own records; and the keychain and SSH key tools.
    name: "guarded-place",
    matches: (r) => runs(r, oneOf("security", "ssh-add", "ssh-keygen")) || r.segments.some((segment) => segment.some((word) => guardedPlace(word, r))),
  },
  {
    // Anything that is not one plain command: chained, piped, redirected, substituted, with variables, globs or line breaks.
    // It cannot be compared word by word, so it never runs on a grant.
    name: "not-a-plain-command",
    matches: (r) => !r.plain,
  },
];

/** Whether an added entry applies to a piece: its first word as a program, and its other words after that, in order, in any case. */
const holds = (segment: Words, entry: FloorEntry): boolean =>
  entry.words.length > 0 &&
  segment.some((word, i) => {
    if (program(word) !== program(entry.words[0]!)) return false;
    let from = i + 1;
    return entry.words.slice(1).every((wanted) => {
      const at = segment.findIndex((later, j) => j >= from && later.toLowerCase() === wanted.toLowerCase());
      from = at + 1;
      return at !== -1;
    });
  });

/**
 * The name of the floor rule a command falls under, or null when none does. A command that falls under one
 * always asks the owner. The same text and context give the same answer.
 */
export function floor(command: string, ctx: FloorContext): string | null {
  const words = splitPlain(command);
  const outer = words === null ? roughSegments(command, ctx.home) : [words];
  // An argument with a space in it may be a command for the program to run (`env -S`, `git … foreach`, `find -exec sh -c`).
  const inner = outer.flatMap((segment) => segment.filter((word) => word.includes(" ")).flatMap((word) => roughSegments(word, ctx.home)));
  const reading: Reading = { segments: [...outer, ...inner], plain: words !== null, raw: command, ctx };
  // The owner's own entries first: they say in the owner's words why this asks.
  for (const entry of ctx.extra ?? []) if (reading.segments.some((segment) => holds(segment, entry))) return entry.name;
  return FLOOR_RULES.find((rule) => rule.matches(reading))?.name ?? null;
}
