import path from "node:path";
import { hereDocuments, quotedPieces, roughSegments, splitPlain, strictShape, type HereDocument, type QuotedWord, type StrictWord } from "./shell.ts";

/*
 * The safety floor: the commands that always ask the owner, whatever grants exist. It is a short table of
 * named rules over the words of a command. No request from a client changes it; the owner's config file
 * may add entries and can take none away.
 *
 * The floor leans towards asking. A rule looks at every word of the command as if a program could start
 * there, so `env sudo ls` and `xargs rm -rf` are caught, and so is `echo sudo`: asking once too often is
 * the cheap mistake. An argument that holds a command of its own (`env -S 'sudo ls'`) is read as one too.
 * The floor decides in two steps (`floor`). The earlier reading, which reads every word roughly, decides first
 * (`readingAsWritten`). Only a verdict it names under one of these rules can be lifted, and only for a command of the
 * strict shape (shell.ts `strictShape`), read again the way the shell hands its words over (`readingByShape`): a
 * search pattern, a sed or awk script and the code given to an interpreter are text, of which only full paths count as
 * places (`textPlace`); the text of a here-document is input to the program it is given to (`hereKind`); a glob under
 * a folder inside the worktree stays inside it (`globInsideWorktree`). Every other command keeps the earlier verdict.
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
  /**
   * Nothing before an `rm` of the command could have changed folder or put a link in place (a `cd`, `chdir`, a zsh
   * folder named as a command, `ln -s`, `tar -x`, `git checkout`, code): every piece up to the last `rm` starts with
   * `mkdir`, `rm` or `true`, no `rm` stands behind another program, and no here-document is read as commands. Only
   * then may a glob of `rm` count as inside the worktree.
   */
  globsStay: boolean;
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
 * Whether an operand of `rm` that is a glob can only name places strictly inside the worktree: a relative, unquoted
 * folder shown to lie strictly inside the worktree with links followed, then exactly `/*` (`rm -rf test-results/*`).
 * `rm` is then handed entries of that folder, and deletes a link among them without following it. Only in a command
 * where nothing could have changed folder or put a link in place first (`globsStay`); any other glob (`**`, `***`, `?`,
 * a bracket, a brace, a `.` that could match `..`) is not.
 */
function globInsideWorktree(word: string, reading: Reading): boolean {
  if (!reading.globsStay || !/^[A-Za-z0-9_.:@%+,-][A-Za-z0-9_./:@%+,-]*\/\*$/.test(word)) return false;
  const folder = word.slice(0, -2);
  return !folder.split("/").includes("..") && insideWorktree(folder, reading);
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
 * no path for the shell, which neither globs nor expands it. Inside interpreter code and sed or awk scripts the floor
 * reads only full paths written out literally: each word that starts with `/`, `~/` or `$HOME` (sed's `w` and `r`, an
 * awk redirection, `open('/…')`), a glob in one counted as far as it may reach (`[`, `{`, `*`, `?`), and `~name`,
 * another user's home. Relative paths (mostly text, `from "../../src/x.ts"`), the root folder alone (`s/a/b/`, `a / b`,
 * `//`), a bare `~` (awk's match operator, `expanduser("~")`) and anything the code computes or reads at run time are
 * left to the sandbox, which keeps an agent's commands from writing outside the copy and from reading the guarded
 * folders and Botbench's data.
 */
function textPlace(text: string, reading: Reading): boolean {
  const home = reading.ctx.home;
  const written = text.replace(/\$\{HOME\}|\$HOME\b/g, home);
  // `~name` where a word could start: another user's home.
  if (/(?:^|[^A-Za-z0-9_.\-/~$])~[A-Za-z0-9_.-]+(?:\/|$|[^A-Za-z0-9_.-])/.test(written)) return true;
  // Every full path written out, wherever it starts in the text, whatever the language's quoting around it (`'/x'`,
  // `q{/x}`, `qw[/x]`, `("/x")`, `=/x`): a `/` or `~/` after the start or a character no path holds, to the next
  // character no path holds. Glob characters stay in it, and count as far as they may reach.
  for (const match of written.matchAll(/(?:^|[^A-Za-z0-9_.\-~$])(~?\/[^\s'"`(),;<>|&=:]*)/g)) {
    const found = match[1]!;
    const place = found.startsWith("~/") ? path.join(home, found.slice(2)) : found;
    if (found.startsWith("~") && !found.startsWith("~/")) continue;
    const glob = place.search(/[*?[\]{}]/);
    if (glob !== -1) {
      if (path.resolve(place.slice(0, glob) || "/") !== "/" && reachesGuarded(place.slice(0, glob), reading)) return true;
    } else if (path.resolve(place) !== "/" && guardedAt(path.resolve(place), reading.ctx)) return true;
  }
  return false;
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
  /** Short options that take no value. A letter in none of these lists makes the reader give up on the piece. */
  flags: string;
  /** Short options whose value, if any, is the rest of their word (perl's `-i.bak`, `-Mmodule`). */
  attached?: string;
  /** Short options followed by digits only (perl's `-0777`, `-l`). */
  digits?: string;
  /** Long options, each spelled out in full: an abbreviation, or one not listed, makes the reader give up on the piece. */
  long: { code?: readonly string[]; file?: readonly string[]; value?: readonly string[]; flags?: readonly string[]; /** Take a value only joined to them (`--context=3`). */ joined?: readonly string[] };
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
  code: "e", file: "f", value: "ABCDdm", flags: "EFGHIJLMOPRSTUVZabchilnopqrsuvwxyz0123456789", operand: true, matched: true,
  long: {
    code: ["--regexp"], file: ["--file"],
    value: ["--after-context", "--before-context", "--max-count", "--devices", "--directories", "--label", "--binary-files", "--include", "--exclude", "--exclude-dir", "--exclude-from"],
    flags: ["--line-number", "--recursive", "--dereference-recursive", "--ignore-case", "--count", "--files-with-matches", "--files-without-match", "--invert-match", "--word-regexp", "--line-regexp", "--fixed-strings", "--extended-regexp", "--basic-regexp", "--perl-regexp", "--only-matching", "--no-filename", "--with-filename", "--quiet", "--silent", "--null", "--null-data", "--text", "--no-messages", "--byte-offset", "--line-buffered", "--initial-tab", "--no-index", "--cached", "--untracked", "--heading", "--break", "--full-name"],
    joined: ["--context", "--color", "--colour"],
  },
};
const AWK: TextSpec = { code: "e", file: "fE", value: "Fv", flags: "", operand: true, long: {} };
/** The programs whose text arguments are read as text, by name. A `Map`, so that no name reaches an object's own properties (`constructor`). */
const TEXT_SPECS: ReadonlyMap<string, TextSpec> = new Map([
  ["grep", GREP], ["egrep", GREP], ["fgrep", GREP],
  ["rg", {
    code: "e", file: "f", value: "ABCEMTdgjmrt", flags: "FHILNOPSUVabchilnopqsuvwxz0.", operand: true, matched: true, none: ["--files", "--type-list"],
    long: {
      code: ["--regexp"], file: ["--file"],
      value: ["--after-context", "--before-context", "--context", "--max-count", "--max-depth", "--glob", "--iglob", "--type", "--type-not", "--replace", "--encoding", "--threads", "--max-columns", "--sort", "--sortr", "--engine"],
      flags: ["--line-number", "--no-line-number", "--ignore-case", "--smart-case", "--case-sensitive", "--fixed-strings", "--word-regexp", "--line-regexp", "--count", "--count-matches", "--files-with-matches", "--files-without-match", "--invert-match", "--hidden", "--no-ignore", "--no-heading", "--heading", "--with-filename", "--no-filename", "--only-matching", "--multiline", "--json", "--vimgrep", "--follow", "--pcre2", "--null", "--quiet", "--text", "--trim", "--column", "--no-messages", "--stats", "--files", "--type-list"],
      joined: ["--color", "--colour"],
    },
  }],
  ["sed", { code: "e", file: "f", value: "", flags: "nEruszl", operand: true, long: { code: ["--expression"], file: ["--file"], flags: ["--quiet", "--silent", "--regexp-extended", "--separate", "--null-data", "--posix", "--debug", "--sandbox", "--unbuffered"], joined: ["--in-place"] } }],
  ["awk", AWK], ["gawk", AWK], ["nawk", AWK], ["mawk", AWK],
  ["node", { code: "ep", file: "", value: "rC", flags: "chiv", operand: false, once: true, long: { code: ["--eval", "--print"], value: ["--require", "--import", "--input-type"], flags: ["--no-warnings", "--no-deprecation", "--experimental-strip-types", "--experimental-vm-modules", "--enable-source-maps", "--trace-warnings"] } }],
  ["perl", { code: "eE", file: "", value: "", flags: "acnpsStTuUvwWX", attached: "iIMmxCdDFV", digits: "0l", operand: false, long: {} }],
  ["python", { code: "c", file: "m", value: "WX", flags: "bBdEhiIOPqsSuvxR", operand: false, once: true, long: {} }],
]);

/**
 * The words of a piece that its program reads as a search pattern, a sed or awk script, or code to run (`grep 'PATTERN'`,
 * `grep -e "PATTERN"`, `git grep '…'`, `sed -i '' 's/…/'`, `awk '…'`, `node -e '…'`, `perl -pi -e '…'`, `python3 -c
 * '…'`), each with whether it is only matched. It reads little, so there is little to get wrong:
 *   - a word is text only if all of it stood inside quotes, with no variable or substitution in it: an unquoted word
 *     (`../.ssh/*`, `{a,b}`, `~`) is one the shell may still turn into paths, so it is read as one, whatever its place;
 *   - a word after a redirection (`grep >>~/.zshrc '…'`) is a place, never an argument;
 *   - the program is the piece's first word after the shell's own words (`do`, `then`); with a variable set in front
 *     of it (`GREP_OPTIONS=… grep`), behind another program (`xargs grep`), or with an option the reader does not know
 *     (an abbreviated `--rege`, a letter not listed), nothing in the piece is text;
 *   - an operand is the pattern or script only when no option gives one anywhere in the piece, as options may follow
 *     the operands (`grep ~ -r -e x`), and never for `rg --files`.
 */
function textArguments(piece: readonly QuotedWord[]): { word: QuotedWord; matched: boolean }[] {
  let k = 0;
  while (k < piece.length && KEYWORDS.has(piece[k]!.text) && piece[k]!.quoted !== true) k++;
  if (k >= piece.length || ASSIGNS.test(piece[k]!.text)) return [];
  let name = program(piece[k]!.text);
  // Redirections are no arguments of the program: what they name is read as a place.
  let words = piece.slice(k + 1).filter((word) => word.redirect !== true);
  if (name === "git") {
    // git's subcommand: the first word after git's options, skipping the values of those that take one.
    let s = 0;
    while (s < words.length && words[s]!.text.startsWith("-")) s += GIT_VALUE_OPTIONS.has(words[s]!.text) ? 2 : 1;
    if (words[s]?.text !== "grep") return [];
    words = words.slice(s + 1);
    name = "grep";
  }
  const spec = TEXT_SPECS.get(/^python[0-9.]*$/.test(name) ? "python" : name);
  if (spec === undefined) return [];
  const found: { word: QuotedWord; matched: boolean }[] = [];
  const take = (at: number): void => void (at < words.length && words[at]!.quoted === true && found.push({ word: words[at]!, matched: spec.matched === true }));
  const long = (word: string): string => word.split("=", 1)[0]!;
  const known = [...(spec.long.code ?? []), ...(spec.long.file ?? []), ...(spec.long.value ?? []), ...(spec.long.flags ?? [])];
  /** Whether each letter of a cluster of short options is known, up to the one whose value is the rest of the word. */
  const shortKnown = (text: string): boolean => {
    for (let c = 1; c < text.length; c++) {
      const ch = text[c]!;
      if (spec.code.includes(ch) || spec.file.includes(ch) || spec.value.includes(ch) || spec.attached?.includes(ch) || (ch === "i" && name === "sed")) return true;
      if (spec.digits?.includes(ch)) while (/[0-9]/.test(text[c + 1] ?? "")) c++;
      else if (!spec.flags.includes(ch)) return false;
    }
    return true;
  };
  // Every option of the piece, wherever it stands, must be one the reader knows exactly.
  for (const { text } of words) {
    if (text === "--") break;
    if (!text.startsWith("-") || text === "-") continue;
    if (text.startsWith("--") ? !known.includes(long(text)) && !(spec.long.joined?.includes(long(text)) && text.includes("=")) : !shortKnown(text)) return [];
  }
  const texts = words.map((word) => word.text);
  const gives = (word: string): boolean =>
    word.startsWith("--") ? [...(spec.long.code ?? []), ...(spec.long.file ?? [])].includes(long(word)) : word.startsWith("-") && [...word.slice(1)].some((ch) => spec.code.includes(ch) || spec.file.includes(ch));
  let given = texts.some(gives) || texts.some((word) => spec.none?.includes(long(word)) === true);
  let i = 0;
  for (; i < words.length; i++) {
    const word = words[i]!.text;
    if (word === "--") {
      i++;
      break;
    }
    if (!word.startsWith("-") || word === "-") break;
    if (word.startsWith("--")) {
      const option = long(word);
      const joined = word.includes("=");
      if (spec.long.code?.includes(option)) {
        given = true;
        if (!joined) take(++i);
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
          // `-e CODE`, also behind other options of the same kind (`node -pe CODE`); code joined to it (`-es/a/b/`) is no quoted word.
          if ([...rest].every((r) => spec.code.includes(r))) take(++i);
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
          const next = words[i + 1]?.text;
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

/** Programs and builtins that change what later programs see: variables, the environment, options, aliases, functions. */
const SETS_THE_SHELL = new Set(["export", "declare", "typeset", "local", "readonly", "set", "setopt", "unsetopt", "shopt", "alias", "unalias", "unset", "hash", "enable", "disable", "source", ".", "eval", "emulate", "function"]);

/**
 * Whether nothing that runs before or alongside an `rm` of a command of the strict shape could change folder or put a
 * link where its glob looks: `rm` stands only as the first word of a piece (not behind `find -exec`, not in quoted text a
 * program may run), and every piece up to the last `rm` is `rm` or `mkdir` with no variable set, alone in its pipeline.
 * What comes after the last `rm` runs only once it has finished (`;`, `&&`, `||`, a line break), so it is not looked at.
 */
function globsStayIn(shape: { pieces: readonly (readonly StrictWord[])[]; joins: readonly string[] }): boolean {
  const firstWord = (piece: readonly StrictWord[]): StrictWord => piece.find((word) => !word.redirect)!;
  const rmWord = (word: StrictWord): boolean => word.kind !== "bare" ? /(?:^|[^A-Za-z0-9_.-])rm(?:$|[^A-Za-z0-9_.-])/.test(word.text) : program(word.text) === "rm";
  if (shape.pieces.some((piece) => piece.some((word) => word !== firstWord(piece) && rmWord(word)))) return false;
  const last = shape.pieces.findLastIndex((piece) => program(firstWord(piece).text) === "rm");
  if (last === -1) return false;
  return shape.pieces.slice(0, last + 1).every((piece, at) => {
    const first = firstWord(piece);
    const alone = (at === 0 || shape.joins[at - 1] !== "|") && shape.joins[at] !== "|";
    return alone && !ASSIGNS.test(first.text) && (first.text === "rm" || first.text === "mkdir");
  });
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
function notPlainReading(given: string, ctx: FloorContext, shape: { pieces: readonly (readonly StrictWord[])[]; joins: readonly string[] }): Reading {
  const here = hereDocuments(given);
  // Not sure where its here-documents are: the whole text is read as commands and paths, as it always was.
  const command = joinLines(here?.command ?? given);
  const quoted = quotedPieces(command);
  // A variable set, exported or the shell's options changed anywhere in the command (`GREP_OPTIONS=-e.`, `export`,
  // `set -a`, an alias) may change how a program takes its arguments: then nothing in it is text.
  const changesPrograms = quoted === null || quoted.pieces.some((piece) => ASSIGNS.test(piece[0]!.text) || SETS_THE_SHELL.has(program(piece[0]!.text)));
  const args = here === null || changesPrograms ? [] : quoted.pieces.flatMap(textArguments);
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
    globsStay: bodies.length === 0 && globsStayIn(shape),
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
  const before = decide(readingAsWritten(given, ctx));
  // Only a rule of the floor that the earlier reading named can be lifted, never an entry of the owner's, and only for a
  // command of the strict shape (shell.ts `strictShape`); every other command keeps the earlier reading's verdict.
  if (before === null || before === NOT_PLAIN || !FLOOR_RULES.some((rule) => rule.name === before)) return before;
  const shape = strictShape(given);
  if (shape === null) return before;
  const after = decide(readingByShape(given, ctx, shape));
  return after === null || after === NOT_PLAIN ? after : before;
}

/** The owner's own entries first, as they say in the owner's words why a command asks; then the floor's rules in order. */
function decide(reading: Reading): string | null {
  for (const entry of reading.ctx.extra ?? []) if (reading.segments.some((segment) => holds(segment, entry))) return entry.name;
  return FLOOR_RULES.find((rule) => rule.matches(reading))?.name ?? null;
}

/**
 * The floor's reading as it was before issue 133, and its verdict for every command not of the strict shape: every word
 * of a command that is not plain read roughly, quotes dropped, as a possible program and a possible place, and every
 * argument of a plain command with a space in it read as a command of its own.
 */
function readingAsWritten(given: string, ctx: FloorContext): Reading {
  // A backslash at the end of a line joins it to the next, before anything else is read (`git pu\<newline>sh`).
  const command = joinLines(given);
  const words = splitPlain(given);
  const outer = words === null ? roughSegments(command, ctx.home) : [words];
  // An argument with a space in it may be a command for the program to run (`env -S`, `git … foreach`, `find -exec sh -c`).
  const inner = outer.flatMap((segment) => segment.filter((word) => word.includes(" ")).flatMap((word) => roughSegments(word, ctx.home)));
  const segments = [...outer, ...inner];
  const quoted = words === null ? quotedPieces(command, true) : null;
  const named = words !== null ? [] : quoted === null ? allLive(segments) : [...quoted.pieces, ...allLive(quoted.substitutes ? segments : inner)];
  return { segments, paths: segments, fragments: [], texts: [], named, plain: words !== null, globsStay: false, raw: command, ctx };
}

/** The reading of issue 133, for a command of the strict shape: words read as places the way the shell hands them over. */
function readingByShape(given: string, ctx: FloorContext, shape: { pieces: readonly (readonly StrictWord[])[]; joins: readonly string[] }): Reading {
  const words = splitPlain(given);
  if (words === null) return notPlainReading(given, ctx, shape);
  // An argument with a space in it may be a command for the program to run (`env -S`, `git … foreach`, `find -exec sh -c`);
  // a search pattern is not one, and a script or code is read as places only for its full paths. The same words read
  // with their quotes, to know which stood inside them: a plain command is one piece.
  const read = quotedPieces(given);
  const quotedWords = read !== null && read.pieces.length === 1 && read.pieces[0]!.length === words.length ? read.pieces[0]!.map((word, at) => ({ ...word, from: at })) : [];
  const args = textArguments(quotedWords);
  const isArg = (at: number, matched?: boolean): boolean => args.some((arg) => arg.word.from === at && (matched === undefined || arg.matched === matched));
  const inner = (skip: (at: number) => boolean): string[][] => words.flatMap((word, at) => (word.includes(" ") && !skip(at) ? roughSegments(word, ctx.home) : []));
  return {
    segments: [words, ...inner((at) => isArg(at, true))],
    paths: [words.filter((_, at) => !isArg(at)), ...inner((at) => isArg(at))],
    fragments: [],
    texts: args.map((arg) => arg.word.text),
    named: [],
    plain: true,
    globsStay: false,
    raw: given,
    ctx,
  };
}
