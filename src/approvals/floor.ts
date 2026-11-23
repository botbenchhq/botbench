import path from "node:path";
import { hereDocuments, quotedPieces, roughSegments, splitPlain, type HereDocument, type QuotedWord } from "./shell.ts";

/*
 * The safety floor: the commands that always ask the owner, whatever grants exist. It is a short table of
 * named rules over the words of a command. No request from a client changes it; the owner's config file
 * may add entries and can take none away.
 *
 * The floor leans towards asking. A rule looks at every word of the command as if a program could start
 * there, so `env sudo ls` and `xargs rm -rf` are caught, and so is `echo sudo`: asking once too often is
 * the cheap mistake. An argument that holds a command of its own (`env -S 'sudo ls'`) is read as one too.
 * Words are read as paths the way the shell hands them over: a search pattern, a sed or awk script and the code
 * given to an interpreter are text, of which only full paths count as places (`textPlace`); the text of a
 * here-document is input to the program it is given to (`hereKind`); a glob under a folder inside the worktree stays
 * inside it (`globInsideWorktree`). Where the reading is not sure of itself it reads every word, as it always did.
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
  /** Botbench's data directory: its records and every other task's worktree. Left out, nothing of Botbench's is guarded. */
  dataDir?: string;
  /** Follows the links in a full path. Left out, paths are taken as written. */
  real?: (absolute: string) => string;
  /** Entries the owner's config adds. */
  extra?: readonly FloorEntry[];
}

/** One command between operators, as words. */
type Words = readonly string[];
interface Reading {
  /**
   * The command's pieces, for the rules about what runs: its words when it is a plain command, one piece per stretch
   * between operators when it is not, and one more for each argument that holds a command of its own. Not among them:
   * a search pattern (it is only matched), and the text of a here-document that is only written or printed.
   */
  segments: readonly Words[];
  /** The pieces whose words are read as paths, each word as a place (`guardedPlace`): `segments` less every text argument and the code an interpreter is given. */
  paths: readonly Words[];
  /**
   * The pieces the rough reading cuts out of quoted text after an operator inside the quotes (`/**` of `'test/!(live)/**'`,
   * `/x` of `watch 'cat</x'`): read as places like `paths`, except where all they name is the root folder (`fragmentPlace`).
   */
  fragments: readonly string[];
  /** Text a program reads as a script, a pattern or code, not as a path (`textArguments`), and the code a here-document gives an interpreter: only full paths in it are read (`textPlace`). */
  texts: readonly string[];
  /** The pieces whose first word, and git's subcommand, are checked for being built by the shell, read with their quotes where that reading is sure of itself (`shellNamesProgram`). */
  named: readonly (readonly QuotedWord[])[];
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

/**
 * Whether an operand of `rm` that is a glob can only name places strictly inside the worktree: one last part with a
 * glob in it (`*`, `?`, `[…]`), under a folder shown to lie strictly inside the worktree (`test-results/*`; `*` and `./*`
 * only from a folder below its top). What `rm` is handed is then an entry of that folder, which `rm -r` deletes without
 * following it if it is a link. Not when the part could match `..` or `.` (it starts with `.` or a bracket), when another
 * part follows it (a link it matched would be followed), when a brace list, a variable or a substitution could put
 * anything there, or when a zsh glob qualifier, which can run code, may follow it (`*(e:…:)`).
 */
function globInsideWorktree(word: string, reading: Reading): boolean {
  const glob = word.search(/[*?[]/);
  if (glob === -1 || /[{}$`\\]/.test(word) || /[^\s;&|<>()]\(/.test(reading.raw)) return false;
  // A `cd` anywhere, also behind another word (`builtin cd ~ &&`, `if cd ~; then`), may have moved where the folder is.
  if (reading.segments.some((segment) => segment.some((w) => oneOf("cd", "pushd", "popd")(program(w))))) return false;
  const cut = word.lastIndexOf("/", glob);
  const last = word.slice(cut + 1);
  if (cut === 0 || last === "" || last.includes("/") || last.startsWith(".") || last.startsWith("[")) return false;
  return insideWorktree(cut === -1 ? "." : word.slice(0, cut), reading);
}

/** A recursive run of a program over something that is not shown to lie inside the worktree. No operand at all shows nothing. `globs`: an operand may be a glob inside it (`rm` only). */
const recursiveOutside = (rest: Words, letters: string, reading: Reading, globs = false): boolean => {
  if (!hasOption(rest, letters, "--recursive")) return false;
  const aimedAt = operands(rest);
  return aimedAt.length === 0 || aimedAt.some((word) => !optionShaped(word) && !insideWorktree(word, reading) && !(globs && globInsideWorktree(word, reading)));
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

/** Whether the words after a shell's name hand it text to run: `-c`, commands on its input (`-s`, `/dev/stdin`), a start-up file, or no script at all. */
const shellRunsText = (rest: Words): boolean =>
  rest.every((word) => word.startsWith("-") || word.startsWith("+")) ||
  rest.some((word) => word === "/dev/stdin" || word.startsWith("/dev/fd/")) ||
  rest.some((word) => word === "--rcfile" || word === "--init-file" || (word.startsWith("-") && !word.startsWith("--") && /[cs]/.test(word)));

/** Places that decide what later runs as the owner, or that hold the owner's keys and logins. Compared in lower case; an entry ending in `/` is a folder, any other the start of a name. */
const GUARDED_IN_HOME = [".ssh/", ".gnupg/", ".config/fish/", ".config/git/", ".config/zsh/", ".oh-my-zsh/", ".claude/", ".aws/", ".kube/", ".docker/", "library/keychains/", "library/launchagents/", ".zsh", ".bash", ".profile", ".gitconfig", ".npmrc", ".netrc"];
const GUARDED_ROOTS = ["/etc/", "/private/etc/", "/var/at/", "/private/var/at/", "/library/keychains/", "/library/launchagents/", "/library/launchdaemons/"];

/** The paths a word may carry: itself, the value after an `=` (`--output=…`, `of=…`), and what follows a one-letter option (`-o…`). */
const pathsIn = (word: string): string[] => [word, ...(word.includes("=") ? [word.slice(word.indexOf("=") + 1)] : []), ...(/^-[A-Za-z]./.test(word) ? [word.slice(2)] : [])];

function guardedPlace(word: string, reading: Reading): boolean {
  return pathsIn(word).some((candidate) => {
    // `~user`, `~+`, `~-`: the shell puts a directory there that the text does not show.
    if (candidate.startsWith("~") && candidate !== "~" && !candidate.startsWith("~/")) return true;
    // A glob or a variable: what it can reach starts with the text before it.
    if (/[*?[\]{}$`]/.test(candidate)) return reachesGuarded(candidate.slice(0, candidate.search(/[*?[\]{}$`]/)), reading);
    const full = target(candidate, reading);
    return full !== null && guardedAt(full, reading.ctx);
  });
}

/** Whether a full path is a guarded place, lies inside one, or holds one (the home folder and every folder above it among them), as written or with links followed. */
function guardedAt(full: string, ctx: FloorContext): boolean {
  const real = ctx.real ?? ((p: string) => p);
  const folder = (p: string): string => `${p.toLowerCase().replace(/\/+$/, "")}/`;
  const both = (p: string): string[] => [path.resolve(p), real(path.resolve(p))];
  const under = (roots: string[], p: string): boolean => roots.some((root) => p === root || within(root, p));
  const home = folder(ctx.home);
  return both(full).some((written) => {
    const place = folder(written);
    // The home directory itself and every folder that holds it.
    if (home.startsWith(place)) return true;
    if (GUARDED_ROOTS.some((root) => place.startsWith(root))) return true;
    // Botbench's own records and other tasks' worktrees; this task's worktree is its own to work in.
    if (ctx.dataDir !== undefined && under(both(ctx.dataDir), written) && !under(both(ctx.worktree), written)) return true;
    if (!place.startsWith(home)) return false;
    const below = place.slice(home.length);
    // A guarded place, anything inside one, or a folder that holds one.
    return GUARDED_IN_HOME.some((entry) => below.startsWith(entry) || (entry.endsWith("/") && entry.startsWith(below)));
  });
}

/**
 * Whether a piece cut out of quoted text names a guarded place, as `guardedPlace` reads it, unless the text up to its
 * first glob or variable is the root folder alone (`/`, `//`, `/.`, `/**`): in quoted text that is a separator, a
 * pattern or a comment far more often than the folder that holds the home folder, and a word of the command that is the
 * root folder is still read as one.
 */
function fragmentPlace(word: string, reading: Reading): boolean {
  const stem = word.slice(0, word.search(/[*?[\]{}$`]|$/));
  return !(stem.startsWith("/") && path.resolve(stem) === "/") && guardedPlace(word, reading);
}

/**
 * Whether a piece of text a program reads as a script, a pattern or code (`texts`) names a guarded place. Such text is
 * no path for the shell, which neither globs nor expands it. A relative path in it is not read: in code and scripts
 * it is mostly text (`from "../../src/x.ts"`), and where a program does open it (`open('../x')`, sed's `w ../x`) it
 * lands relative to a folder the program may have changed; that is left to the sandbox, which keeps an agent's
 * commands from writing outside the copy and from reading the guarded folders and Botbench's data. What is read is
 * each word that starts with `/`, `~/` or `$HOME`: a full path a program may open (sed's `w` and `r`, an awk
 * redirection, `open('/…')`), and a glob in one as far as the glob may reach (`/Users/` then a star, then `.ssh`). The root
 * folder alone is not, as patterns and code spell it everywhere (`s/a/b/`, `a / b`, `//`, a comment's opening); `~` alone is awk's
 * match operator; `~name` is another user's home.
 */
function textPlace(text: string, reading: Reading): boolean {
  const home = reading.ctx.home;
  return text
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .split(/[\s'"`(),;:=<>|&{}[\]]+/)
    .some((word) => {
      if (/^~[A-Za-z0-9_.-]+(?:\/|$)/.test(word)) return true;
      const written = word.startsWith("~/") ? path.join(home, word.slice(2)) : word.startsWith("/") ? word : null;
      if (written === null) return false;
      const glob = written.search(/[*?]/);
      if (glob !== -1) return path.resolve(written.slice(0, glob) || "/") !== "/" && reachesGuarded(written.slice(0, glob), reading);
      const full = path.resolve(written);
      return full !== "/" && guardedAt(full, reading.ctx);
    });
}

/**
 * Whether a glob or a variable whose text before it is `stem` could name a guarded place: the stem lies in one, or one
 * lies where the rest of the word could lead (`~/.ss*`, `~/*`, `/e*`, `/Users/*`). Leans towards asking.
 */
function reachesGuarded(stem: string, reading: Reading): boolean {
  const { ctx } = reading;
  const cut = stem.lastIndexOf("/") + 1;
  const dir = target(stem.slice(0, cut) === "" ? "." : stem.slice(0, cut), reading);
  if (dir === null) return false;
  const real = ctx.real ?? ((p: string) => p);
  const folder = (p: string): string => `${p.toLowerCase().replace(/\/+$/, "")}/`;
  const home = folder(ctx.home);
  const worktree = [path.resolve(ctx.worktree), real(path.resolve(ctx.worktree))].map(folder);
  const data = ctx.dataDir === undefined ? [] : [path.resolve(ctx.dataDir), real(path.resolve(ctx.dataDir))].map(folder);
  return [dir, real(dir)].some((place) => {
    const reach = folder(place) + stem.slice(cut).toLowerCase();
    const guardedAt = [home, ...GUARDED_ROOTS, ...GUARDED_IN_HOME.map((entry) => home + entry), ...data];
    // A guarded place the rest of the word could lead to, the home folder and every folder holding it among them.
    if (guardedAt.some((place) => place.startsWith(reach))) return true;
    // Already inside one: a root, a place in the home folder, or Botbench's data folder outside this task's copy.
    if ([...GUARDED_ROOTS, ...GUARDED_IN_HOME.map((entry) => home + entry)].some((place) => reach.startsWith(place))) return true;
    return data.some((place) => reach.startsWith(place)) && !worktree.some((place) => reach.startsWith(place));
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

/** What the shell may turn into another word: a variable, a substitution, a glob, a brace list, ANSI-C quoting, or zsh's `=name`. */
const SHELL_BUILT = /[$`*?[\]{}]/;
/** Words that only set a variable for the program after them. */
const ASSIGNS = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Whether the shell builds the program of a piece, or git's subcommand, from a variable, a substitution, a glob or a
 * brace list (what `live` holds of a word), or a program is handed its words on its input (`xargs git`).
 */
function shellNamesProgram(pieces: readonly (readonly QuotedWord[])[]): boolean {
  return pieces.some((piece) => {
    const first = piece.find((word) => !ASSIGNS.test(word.text));
    // `[` and `[[` are the test command, written as a bracket.
    if (first !== undefined && first.text !== "[" && first.text !== "[[" && (SHELL_BUILT.test(first.live) || first.live.startsWith("="))) return true;
    return piece.some((word, i) => {
      const rest = piece.slice(i + 1);
      if (program(word.text) === "git") {
        const sub = rest.findIndex((later) => !later.text.startsWith("-"));
        return sub === -1 || SHELL_BUILT.test(rest[sub]!.live);
      }
      return program(word.text) === "xargs" && rest.some((later) => oneOf("git", "sudo", "su", "doas", "eval")(program(later.text)) || SHELLS(program(later.text)));
    });
  });
}

/** Words read without their quotes, as if all of each could be expanded: the reading that leans furthest towards asking. */
const allLive = (segments: readonly Words[]): QuotedWord[][] => segments.map((segment) => segment.map((word) => ({ text: word, live: word })));

/**
 * The keychain and SSH key tools, when a word may name one as a program. A relative path shown to lie inside the task's
 * worktree (`ls docs/security`) is the project's own file and is not one, but only as an argument of a program known only
 * to read files; any other path of that name is (`/usr/bin/security`, `~/bin/security`, `./security` after a `cd` or from
 * a folder outside the worktree), and so is one given to any other program (`./security`, `env docs/security`, `stdbuf
 * -o0 docs/security`), whatever file it is.
 */
const KEY_TOOLS = new Set(["security", "ssh-add", "ssh-keygen"]);
/** Programs that only read or list the files they are given, and run none of them: the one place a project file of a key tool's name is an argument and nothing more. */
const READS_FILES = new Set(["ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "file", "stat", "du", "diff", "less", "more", "tree", "git"]);
/** Words that make a reading program run something after all (`find -exec`, `git -c`, `rg --pre`, `git difftool -x` or `--extcmd`). */
const RUNS_SOMETHING = /^-(exec|execdir|ok|okdir|c|x)$|^--(pre|extcmd|exec|config-env|upload-pack|receive-pack)(=|$)/;
const namesKeyTool = (segment: Words, i: number, reading: Reading): boolean => {
  const word = segment[i]!;
  if (!KEY_TOOLS.has(program(word))) return false;
  // A word that is an option with a value (`--extcmd=docs/security`) hands the program a path to use, not a file to read.
  const projectFile = word.includes("/") && !word.startsWith("/") && !word.startsWith("~") && !word.startsWith("-") && !word.includes("=") && insideWorktree(word, reading);
  // An argument of a program known only to read: the piece's program (after any variables it sets) is one, and nothing in it runs another.
  const first = segment.findIndex((w) => !ASSIGNS.test(w));
  const readOnly = first !== -1 && first < i && READS_FILES.has(program(segment[first]!)) && !segment.some((w) => RUNS_SOMETHING.test(w));
  return !(projectFile && readOnly);
};

/** The last rule of the floor, which no other matched: the command is not one plain command, and so never runs on a grant. */
export const NOT_PLAIN = "not-a-plain-command";

/** The floor's own rules, in the order they are tried. The first that matches names why the command asks. */
export const FLOOR_RULES: readonly FloorRule[] = [
  {
    // `rm -r` of anything not shown to lie inside the task's worktree (`/`, `~`, any path with `..`, the worktree itself),
    // and the same for `find … -delete` and `rsync --delete…`.
    name: "recursive-delete-outside-worktree",
    matches: (r) =>
      runs(r, oneOf("rm"), (rest) => recursiveOutside(rest, "rR", r, true)) ||
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
    // cloud logins, `/etc`, the home directory as a whole, or Botbench's own records; and the keychain and SSH key tools.
    name: "guarded-place",
    matches: (r) => r.segments.some((segment) => segment.some((_, i) => namesKeyTool(segment, i, r))) || r.paths.some((segment) => segment.some((word) => guardedPlace(word, r))) || r.fragments.some((word) => fragmentPlace(word, r)) || r.texts.some((text) => textPlace(text, r)),
  },
  {
    // A program, or git's subcommand, that the shell builds from a variable, a substitution, a glob or a brace list, or
    // a program handed its words on its input (`xargs git`): the floor cannot read what will run, so it asks. The pieces
    // are read with their quotes, so that a quoted `|` or `(` (`grep "a\|b"`, `grep -n "admit(" src/*.ts`) does not make
    // a pattern or a file name look like a program; a program a substitution prints is one the shell builds. When the
    // quoted reading is not sure of itself, or a substitution inside double quotes holds a command it does not follow,
    // the pieces read without quotes count too, as they always did.
    name: "program-named-by-the-shell",
    matches: (r) => !r.plain && shellNamesProgram(r.named),
  },
  {
    // Programs that start work outside the sandbox the command runs in: an app (`open`), AppleScript, a login item or a scheduled job.
    name: "leaves-the-sandbox",
    // `open` only with something after it: in code a here-document holds (`open(p)`), the word stands alone.
    matches: (r) => runs(r, oneOf("osascript", "launchctl", "crontab")) || runs(r, oneOf("open"), (rest) => rest.length > 0),
  },
  {
    // Anything that is not one plain command: chained, piped, redirected, substituted, with variables, globs or line breaks.
    // It cannot be compared word by word, so it never runs on a grant.
    name: NOT_PLAIN,
    matches: (r) => !r.plain,
  },
];

/** Words of the shell that stand in front of a piece's program. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time"]);

/** How a program is given text it reads as a pattern, a script or code rather than as a path. */
interface TextSpec {
  /** Short options whose value is the text (`grep -e`, `sed -e`, `node -e`, `python3 -c`). */
  code: string;
  /** Short options whose value names a file the text is read from (`-f`): then no operand is the text. */
  file: string;
  /** Short options that take a value of another kind, as the next word when not joined to them (`grep -A 3`). */
  value: string;
  /** Short options whose value, if any, is the rest of their word (perl's `-i.bak`, `-Mmodule`). */
  attached?: string;
  /** Short options followed by digits only (perl's `-0777`, `-l`). */
  digits?: string;
  long: { code?: readonly string[]; file?: readonly string[]; value?: readonly string[] };
  /** The first operand is the text when no option gave it (`grep PATTERN`, `sed SCRIPT`, `awk PROGRAM`). */
  operand: boolean;
  /** The first option that gives the text ends the options (`python3 -c code args`). */
  once?: boolean;
  /** The text is only matched against, never run: it is left out of the words read for what runs, too. */
  matched?: boolean;
  /** Options that make the program take no pattern at all (`rg --files`). */
  none?: readonly string[];
}
const GREP: TextSpec = {
  code: "e", file: "f", value: "ABDdm", operand: true, matched: true,
  long: { code: ["--regexp"], file: ["--file"], value: ["--after-context", "--before-context", "--max-count", "--devices", "--directories", "--label", "--binary-files", "--include", "--exclude", "--exclude-dir", "--exclude-from"] },
};
const AWK: TextSpec = { code: "", file: "fE", value: "Fv", operand: true, long: { file: ["--file", "--exec"], value: ["--assign", "--field-separator", "--include", "--load"] } };
const TEXT_SPECS: Record<string, TextSpec> = {
  grep: GREP, egrep: GREP, fgrep: GREP,
  rg: {
    code: "e", file: "f", value: "ABCEMTdgjmrt", operand: true, matched: true, none: ["--files", "--type-list"],
    long: { code: ["--regexp"], file: ["--file"], value: ["--after-context", "--before-context", "--context", "--max-count", "--max-depth", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--replace", "--pre", "--pre-glob", "--encoding", "--threads", "--max-columns", "--sort", "--sortr", "--ignore-file", "--colors", "--engine", "--path-separator", "--context-separator", "--field-match-separator", "--field-context-separator"] },
  },
  sed: { code: "e", file: "f", value: "", operand: true, long: { code: ["--expression"], file: ["--file"], value: ["--line-length"] } },
  awk: AWK, gawk: AWK, nawk: AWK, mawk: AWK,
  node: { code: "ep", file: "", value: "rC", operand: false, once: true, long: { code: ["--eval", "--print"], value: ["--require", "--import", "--conditions", "--input-type", "--loader"] } },
  perl: { code: "eE", file: "", value: "", attached: "iIMmxCdDFV", digits: "0l", operand: false, long: {} },
  python: { code: "c", file: "m", value: "WX", operand: false, once: true, long: {} },
};

/**
 * The words of a piece that its program reads as a search pattern, a sed or awk script, or code to run (`grep PATTERN`,
 * `grep -e PATTERN`, `git grep PATTERN`, `sed -i '' SCRIPT`, `awk PROGRAM`, `node -e CODE`, `perl -pi -e CODE`,
 * `python3 -c CODE`), each with whether it is only matched. An option whose value the reader does not know takes none,
 * so a value it should have skipped is taken for the pattern and the pattern for a path: a mistake towards reading more
 * words as paths. The program is the piece's first word after any variables it sets and the shell's own words (`do`,
 * `then`); behind another program (`xargs grep`) nothing is taken for text.
 */
function textArguments(piece: readonly QuotedWord[]): { word: QuotedWord; matched: boolean }[] {
  let k = 0;
  while (k < piece.length && (ASSIGNS.test(piece[k]!.text) || KEYWORDS.has(piece[k]!.text))) k++;
  if (k >= piece.length) return [];
  let name = program(piece[k]!.text);
  if (name === "git") {
    // git's subcommand: the first word after git's options, skipping the values of those that take one.
    let s = k + 1;
    while (s < piece.length && piece[s]!.text.startsWith("-")) s += GIT_VALUE_OPTIONS.has(piece[s]!.text) ? 2 : 1;
    if (piece[s]?.text !== "grep") return [];
    k = s;
    name = "grep";
  }
  const spec = TEXT_SPECS[/^python[0-9.]*$/.test(name) ? "python" : name];
  if (spec === undefined) return [];
  const found: { word: QuotedWord; matched: boolean }[] = [];
  // A word the shell still expands (`grep "$(cmd)"`, a variable, a leading `~`) is no text: the shell runs or fills it first.
  const take = (at: number): void => void (at < piece.length && !/[$`]/.test(piece[at]!.live) && !piece[at]!.text.startsWith("~") && found.push({ word: piece[at]!, matched: spec.matched === true }));
  // The pattern or script may be given by an option after the operands (`grep ~ -r -e x`: grep, rg and GNU tools take
  // options anywhere), and some options mean there is none (`rg --files`): then no operand is taken for it.
  const later = piece.slice(k + 1).map((word) => word.text);
  const optionGives = (word: string): boolean =>
    word.startsWith("--") ? [...(spec.long.code ?? []), ...(spec.long.file ?? [])].includes(word.split("=", 1)[0]!) : word.startsWith("-") && [...word.slice(1)].some((ch) => spec.code.includes(ch) || spec.file.includes(ch));
  let given = later.some(optionGives) || later.some((word) => spec.none?.includes(word.split("=", 1)[0]!) === true);
  let i = k + 1;
  for (; i < piece.length; i++) {
    const word = piece[i]!.text;
    if (word === "--") {
      i++;
      break;
    }
    if (!word.startsWith("-") || word === "-") break;
    if (word.startsWith("--")) {
      const option = word.split("=", 1)[0]!;
      const joined = word.includes("=");
      if (spec.long.code?.includes(option)) {
        given = true;
        if (joined) take(i);
        else take(++i);
      } else if (spec.long.file?.includes(option)) {
        given = true;
        if (!joined) i++;
      } else if (spec.long.value?.includes(option) && !joined) {
        i++;
      }
    } else {
      for (let c = 1; c < word.length; c++) {
        const ch = word[c]!;
        const rest = word.slice(c + 1);
        if (spec.code.includes(ch)) {
          given = true;
          // `-e CODE`, also behind other options of the same kind (`node -pe CODE`); else the code is joined to it (`-es/a/b/`).
          if ([...rest].every((r) => spec.code.includes(r))) take(++i);
          else take(i);
          break;
        }
        if (spec.file.includes(ch)) {
          given = true;
          if (rest === "") i++;
          break;
        }
        if (spec.value.includes(ch)) {
          if (rest === "") i++;
          break;
        }
        if (spec.attached?.includes(ch)) break;
        if (spec.digits?.includes(ch)) {
          while (/[0-9]/.test(word[c + 1] ?? "")) c++;
          continue;
        }
        // sed's `-i`: GNU's takes a suffix joined to it, BSD's (macOS) the next word. Only a word shaped as a suffix
        // (`''`, `.bak`) is taken as one, so a script or a file is never skipped.
        if (ch === "i" && name === "sed") {
          const next = piece[i + 1]?.text;
          if (rest === "" && next !== undefined && /^(?:\.[^/]*)?$/.test(next)) i++;
          break;
        }
      }
    }
    if (given && spec.once === true) {
      i++;
      break;
    }
  }
  if (!given && spec.operand) take(i);
  return found;
}

/** Interpreters a here-document can give code to: what the code runs is still read, and only full paths in it count as places. */
const INTERPRETER = /^(?:python[0-9.]*|node|perl|ruby|php)$/;
/** Programs that only write, print or count the text they are given on their input. */
const WRITES_TEXT = new Set(["cat", "tee", "head", "tail", "wc", "uniq", "tr", "cut", "grep", "egrep", "fgrep"]);
/** Programs that run nothing of what they are given: a command made only of these and `WRITES_TEXT` runs no text it writes. */
const RUNS_NO_TEXT = new Set([...WRITES_TEXT, "ls", "echo", "printf", "mkdir", "true", "pwd"]);

/**
 * How the floor reads a here-document's text, by what the shell gives it to:
 *   commands  read as commands, as every word of the command always was: the text goes to a shell (`sh <<EOF`, `bash
 *             -s`, `cat <<EOF | sh`), to a program not known here (`ssh host`, `sqlite3`, `xargs`), or the shell expands
 *             it (its delimiter is not quoted and it holds `$`, a backquote or a backslash)
 *   code      given to an interpreter (`python3 - <<'EOF'`) in a command whose other programs run nothing they are given
 *             and are no shell (only `RUNS_NO_TEXT` and interpreters): read for what it runs by every rule that looks for
 *             a program, and for places only by its full paths (`textPlace`); the sandbox confines what the code does
 *   data      written or printed (`cat > file <<'EOF'`) by a command whose every program runs nothing it is given: not read
 * Text written by `cat` and the like in any other command (`cat <<'EOF' | xargs rm -rf`, `… | tar -T -`, `cat > x.sh
 * <<'EOF' … && . ./x.sh`) may become paths or commands of another program: it is read as commands.
 * The program is the first word of the operator's piece, named without a path (`/bin/cat` or `./cat` could be any file)
 * and with no variable set in front of it (`PATH=… cat`).
 */
function hereKind(body: HereDocument, runsNoText: boolean, runsOnlyCode: boolean): "commands" | "code" | "data" {
  const before = quotedPieces(body.before);
  const piece = quotedPieces(body.piece);
  if (!body.literal || before === null || piece === null || before.pieces.length !== 1) return "commands";
  if (piece.pieces.some((words) => words.some((word) => SHELLS(program(word.text))))) return "commands";
  const first = before.pieces[0]![0]!;
  if (ASSIGNS.test(first.text) || first.text.includes("/")) return "commands";
  const name = program(first.text);
  if (INTERPRETER.test(name)) return runsOnlyCode ? "code" : "commands";
  if (WRITES_TEXT.has(name)) return runsNoText ? "data" : "commands";
  return "commands";
}

/** The pieces of a command read roughly, after blanking out the given words (shell.ts `quotedPieces` positions). */
const roughWithout = (command: string, words: readonly QuotedWord[], home: string): string[][] =>
  roughSegments(words.reduce((text, word) => text.slice(0, word.from) + " ".repeat(word.to! - word.from!) + text.slice(word.to), command), home);

const joinLines = (text: string): string => text.replace(/\\\r?\n/g, "");

/** What the rules read of a command that is not one plain command. */
function notPlainReading(given: string, ctx: FloorContext): Reading {
  const here = hereDocuments(given);
  // Not sure where its here-documents are: the whole text is read as commands and paths, as it always was.
  const command = joinLines(here?.command ?? given);
  const quoted = quotedPieces(command);
  const args = here === null || quoted === null ? [] : quoted.pieces.flatMap(textArguments);
  const every = (names: (name: string) => boolean): boolean => quoted !== null && quoted.pieces.every((piece) => !ASSIGNS.test(piece[0]!.text) && !piece[0]!.text.includes("/") && names(program(piece[0]!.text)));
  const runsNoText = every((name) => RUNS_NO_TEXT.has(name));
  const runsOnlyCode = every((name) => RUNS_NO_TEXT.has(name) || INTERPRETER.test(name));
  const bodies = (here?.bodies ?? []).map((body) => ({ text: joinLines(body.text), kind: hereKind(body, runsNoText, runsOnlyCode) }));
  const commands = bodies.filter((body) => body.kind === "commands").map((body) => body.text);
  const code = bodies.filter((body) => body.kind === "code").map((body) => body.text);
  const rough = (text: string): string[][] => roughSegments(text, ctx.home);
  const shellSegments = roughWithout(command, args.filter((arg) => arg.matched).map((arg) => arg.word), ctx.home);
  /** Read with their quotes where that reading is sure of itself, else every word as if the shell could build it. */
  const named = (text: string, segments: string[][]): QuotedWord[][] => {
    const read = quotedPieces(text);
    return read === null ? allLive(segments) : [...read.pieces, ...(read.substitutes ? allLive(segments) : [])];
  };
  // Each word read as places, as the rough reading cuts it: in quoted text a cut falls at an operator too (`'a|b'`, `'test/!(live)/**'`).
  const heads: string[] = [];
  const fragments: string[] = [];
  if (here === null || quoted === null) heads.push(...roughWithout(command, [], ctx.home).flat());
  else {
    const skip = new Set(args.map((arg) => arg.word));
    for (const word of quoted.pieces.flat()) {
      if (skip.has(word)) continue;
      for (const part of word.text.split(/\s+/)) {
        const tokens = roughSegments(part, ctx.home).flat();
        const cut = /^['"\\]*(?:[;&|\n\r(){}`<>]|\$\()/.test(part);
        tokens.forEach((token, at) => (at === 0 && !cut ? heads : fragments).push(token));
      }
    }
  }
  return {
    segments: [...shellSegments, ...commands.flatMap(rough), ...code.flatMap(rough)],
    paths: [heads, ...commands.flatMap(rough)],
    fragments,
    texts: [...args.map((arg) => arg.word.text), ...code],
    named: [...named(command, shellSegments), ...commands.flatMap((text) => named(text, rough(text)))],
    plain: false,
    raw: [command, ...commands, ...code].join("\n"),
    ctx,
  };
}

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
export function floor(given: string, ctx: FloorContext): string | null {
  const words = splitPlain(given);
  let reading: Reading;
  if (words === null) {
    reading = notPlainReading(given, ctx);
  } else {
    // An argument with a space in it may be a command for the program to run (`env -S`, `git … foreach`, `find -exec sh -c`);
    // a search pattern is not one, and a script or code is read as places only for its full paths.
    const args = textArguments(words.map((text, at) => ({ text, live: "", from: at })));
    const isArg = (at: number, matched?: boolean): boolean => args.some((arg) => arg.word.from === at && (matched === undefined || arg.matched === matched));
    const inner = (skip: (at: number) => boolean): string[][] => words.flatMap((word, at) => (word.includes(" ") && !skip(at) ? roughSegments(word, ctx.home) : []));
    reading = {
      segments: [words, ...inner((at) => isArg(at, true))],
      paths: [words.filter((_, at) => !isArg(at)), ...inner((at) => isArg(at))],
      fragments: [],
      texts: args.map((arg) => arg.word.text),
      named: [],
      plain: true,
      raw: given,
      ctx,
    };
  }
  // The owner's own entries first: they say in the owner's words why this asks.
  for (const entry of ctx.extra ?? []) if (reading.segments.some((segment) => holds(segment, entry))) return entry.name;
  return FLOOR_RULES.find((rule) => rule.matches(reading))?.name ?? null;
}
