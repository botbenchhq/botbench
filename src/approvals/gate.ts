import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunMode } from "../engine/modes.ts";
import { floor, NOT_PLAIN, type FloorEntry } from "./floor.ts";
import { matchGrant, type Grant } from "./grants.ts";
import { splitPlain } from "./shell.ts";

/*
 * The gate: what Botbench itself decides about a tool call before anyone is asked. It is a function of the
 * request, the grants and the safety floor: it writes nothing and asks nobody, and reads the file system only to
 * follow the links in a path.
 *   allow   the call may run, and `rule` says why: an edit or a read inside the worktree, a Read of the CLI's own
 *           saved output of the attempt's session, a command the owner pre-approved for this run, or one the owner
 *           gave standing permission
 *   ask     the owner decides; `floor` names the floor rule when it is the floor that says so, and `why` is the
 *           reason the card gives (`askWords`)
 *   deny    the call cannot be put to anyone as it is
 *   refuse  a fully autonomous run asks nobody: what would ask the owner is refused instead, saying why
 * The floor is asked before any grant, so no grant gets past it.
 *
 * Approvals are for actions and changes, not for using a tool. In every mode a shell command that runs inside the
 * confinement (`confined`: the attempt's driver runs every shell command in its sandbox, and the call is exactly the
 * one the CLI asked about) runs without asking, unless the floor names it; a call that carries anything beside its
 * command that is not known to keep it confined still asks. The one exception is the owner's setting "Ask before every
 * command" (`askEveryCommand`), which brings back a card for every command of a manual run. The run's mode
 * (engine/modes.ts) changes one thing here: in a fully autonomous run every "ask" becomes "refuse". The floor's "not a
 * plain command" is no danger of its own: it is why a chained command cannot run on a grant, which is compared word by
 * word. Every other rule of the floor still reads each piece of such a command, so a chained command runs confined
 * unless one of them names it.
 *
 * A run that read outside text loses every grant: what someone outside the project wrote could otherwise steer an agent
 * to a command the owner allowed in advance for other reasons. Confinement is not a grant, so a mode keeps that.
 */

/** What one tool call is, as far as the gate needs to know. */
export interface GateRequest {
  tool: string;
  input: unknown;
  /** The task's worktree, as a full path. */
  worktree: string;
  /** The directory the agent stands in, as a full path. */
  cwd: string;
  /** Whose request this is, for matching grants. Left out, no grant applies. */
  scope?: { role: string; /** The source repository's real path. */ repo: string; runId: number | null };
  /** The run's mode. Left out, manual. */
  mode?: RunMode;
  /** The call would run inside Botbench's confinement. Left out, it is not known to. */
  confined?: boolean;
  /** The owner's setting "Ask before every command": in a manual run every shell command asks, confined or not. Left out, off. */
  askEveryCommand?: boolean;
  /**
   * The run read text from outside the project (a GitHub issue, engine/intake.ts). Then no grant applies: neither the
   * run's pre-approved commands nor any standing permission. What the mode lets run because it is confined still runs.
   */
  outsideText?: boolean;
  /**
   * The folder where the agent's CLI saves the long output of this attempt's own tool calls, as a full path (for Claude
   * Code `<config>/projects/<copy>/<session>/tool-results`, src/drivers/claude-code.ts). A Read of a file inside it is
   * allowed: the CLI wrote it there from this session's own calls and told the agent to read it. Left out, none is.
   */
  sessionOutput?: string;
}

/** Why a request asks the owner. The card says it in words (`askWords`). */
export type AskWhy =
  /** The safety rules always ask about it; `floor` names the rule. */
  | "floor"
  /** The owner chose "Ask before every command", and the run is manual. */
  | "every_command"
  /** A chat's web fetch aimed at this Mac, the local network, or anything but a public web page. */
  | "local_address"
  /** A command that could not be shown to run inside the confinement, so the mode does not let it run. */
  | "not_confined"
  /** Botbench could not tie the request to the call its check saw: the folder was not reported, or the input differs. */
  | "not_checked"
  /** A file tool aimed outside the task's copy. */
  | "outside_copy"
  /** A change to git's own folder or Claude Code's settings inside the copy. */
  | "guarded_in_copy"
  /** A tool that is neither the shell nor a file tool, which always asks. */
  | "other_tool"
  /** The request does not say what it would run, or comes from an agent Botbench cannot place. */
  | "unknown";

/** The part of the floor that is not the request: the owner's home, and the entries the owner's config adds. */
export interface FloorSettings {
  home: string;
  /** Botbench's data directory, which the floor guards. */
  dataDir?: string;
  extra?: readonly FloorEntry[];
}

export type GateVerdict =
  /** An edit inside the worktree, left to the CLI's own edit rule and logged; or a read inside it, which is not logged. */
  | { verdict: "allow"; rule: "auto_worktree_edit" | "worktree_read" }
  /** A Read of the long output the CLI saved for this attempt's own calls (`sessionOutput`). Not logged, like a read inside the worktree. */
  | { verdict: "allow"; rule: "session_output_read" }
  /** A command on the run's pre-approved list. */
  | { verdict: "allow"; rule: "preapproved"; grantId: number }
  /** A command the owner gave standing permission: the whole command, for this role, repository and directory. */
  | { verdict: "allow"; rule: "standing"; grantId: number }
  /** A confined command the floor does not name, in any mode (unless the owner asked to be asked before every command). */
  | { verdict: "allow"; rule: "mode_confined" }
  /** The owner decides. `floor` is the floor rule that makes this always ask, when one does; `why` is what the card says. */
  | { verdict: "ask"; floor?: string; why: AskWhy }
  /** Refused without asking anyone. */
  | { verdict: "deny"; reason: string }
  /** What would ask the owner, refused because the run is fully autonomous; `floor` names the floor rule when it is the floor that would ask. */
  | { verdict: "refuse"; reason: string; floor?: string };

/** Why a fully autonomous run refused what would otherwise ask the owner, in words for the agent and the record. */
export function fullAutonomyRefusal(tool: string, floorRule?: string): string {
  if (floorRule !== undefined) return `This run is fully autonomous, so Botbench refuses what its safety rules would otherwise ask you about (${floorRule}). It was not run.`;
  if (tool === "Bash") return "This run is fully autonomous, so a command runs without you only inside the protected copy, and this one could not be shown to run kept away from your sign-ins and the network. It was not run.";
  return `This run is fully autonomous, so nothing is put to you for approval, and ${tool.slice(0, 100)} was refused. It was not run.`;
}

/** What each rule of the safety rules is about, as the card's reason line says it. An entry the owner's config adds is shown by its own name. */
const FLOOR_WORDS: Record<string, string> = {
  "recursive-delete-outside-worktree": "it deletes a folder that is not shown to be inside the task's copy",
  "git-push": "it sends commits to another computer",
  "git-config-override": "it changes what git runs",
  sudo: "it runs as another user",
  "download-into-shell": "it runs something straight from the internet",
  "shell-runs-text": "it hands a shell text to run",
  "recursive-permissions-outside-worktree": "it changes permissions on a folder that is not shown to be inside the task's copy",
  "disk-tool": "it writes to or formats a disk",
  "guarded-place": "it reaches your sign-ins, settings, home folder or Botbench's own files",
  "program-named-by-the-shell": "Botbench cannot read from the command which program it runs",
  "leaves-the-sandbox": "it starts an app or a job outside the task's protection",
};

/** Why a request asks the owner, in one plain line for its card. */
export function askWords(why: AskWhy, o: { tool: string; floor?: string; chat?: boolean }): string {
  switch (why) {
    case "floor":
      return `On the always-ask list: ${o.floor === undefined ? "Botbench always asks about this." : `${FLOOR_WORDS[o.floor] ?? o.floor.slice(0, 100)}.`}`;
    case "every_command":
      return "Ask before every command is on in Settings.";
    case "local_address":
      return "It reaches this Mac, your local network, or something that is not a public web page.";
    case "not_confined":
      return "It could not be shown to run kept away from your sign-ins and the network.";
    case "not_checked":
      return "Botbench could not match it to the request it checked.";
    case "outside_copy":
      return o.chat === true ? "Outside the chat's folder." : "Outside the task's copy.";
    case "guarded_in_copy":
      return "It changes git's own files or Claude Code's settings in the task's copy.";
    case "other_tool":
      return `Botbench asks you each time ${o.tool.slice(0, 100)} is used.`;
    case "unknown":
      return "Botbench could not tell what this would run, or which of its agents asked.";
  }
}

/** The tools that change a file, and the field of their input that names it. */
const EDIT_TOOLS: Record<string, string> = { Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };
/** All a read-only role may use: reading and searching files, and the shell, each command of which goes through the gate. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "Bash"]);
/** The tools that only read, and the field that names where. A search may leave it out and then means the directory it stands in. */
const READ_TOOLS: Record<string, string> = { Read: "file_path", Glob: "path", Grep: "path" };
/** In a worktree these are git's own entry and the CLI's settings: a change to either is not an ordinary edit. */
const GUARDED = new Set([".git", ".claude"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `target` with every link in it followed, as far as it exists; what does not exist yet is kept as written. */
export function real(target: string, hops = 0): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest);
    } catch {
      // A link whose target does not exist yet still decides where a write through it would land.
      let link: string | null = null;
      try {
        if (fs.lstatSync(existing).isSymbolicLink()) link = fs.readlinkSync(existing);
      } catch {
        link = null;
      }
      if (link !== null) return hops > 40 ? path.parse(target).root : path.join(real(path.resolve(path.dirname(existing), link), hops + 1), ...rest);
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Whether the CLI lands a tool's path where a plain join with its folder does. Claude Code (2.1.322) trims the path and
 * expands a leading `~` to the home folder first, so `~/.zshrc` or one with spaces around it is not what the join says;
 * such a path is never taken as inside anything.
 */
const readsAsJoined = (file: string): boolean => file === file.trim() && !file.startsWith("~");

/** Where the CLI lands a tool's path, as it reads it: trimmed, a leading `~` or `~/` as the home folder. */
function landing(from: string, file: string): string {
  const trimmed = file.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(from, trimmed);
}

/**
 * Where `file` really is relative to the worktree, links followed, when it is inside it both as
 * written and after following links; null when it is not, or is the worktree itself.
 */
export function insideWorktree(worktree: string, cwd: string, file: unknown): string | null {
  if (typeof file !== "string" || file === "" || file.includes("\0") || !readsAsJoined(file)) return null;
  const within = (root: string, target: string): string | null => {
    const relative = path.relative(root, target);
    return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? null : relative;
  };
  const written = path.resolve(cwd, file);
  const asWritten = within(path.resolve(worktree), written);
  if (asWritten === null) return null;
  return within(real(path.resolve(worktree)), real(written));
}

/** Whether a place in the worktree is, or lies under, a folder that is not ordinary content. Case is ignored, as this file system does. */
const guarded = (relative: string): boolean => relative.split(path.sep).some((segment) => GUARDED.has(segment.toLowerCase()));
/** A search pattern that reaches out of the directory it starts in. */
const reachesOut = (pattern: unknown): boolean => typeof pattern === "string" && (path.isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes(".."));

/** The fields of a shell call that say nothing about what runs beyond the command itself. */
const PLAIN_SHELL_FIELDS = new Set(["command", "description"]);
/** The fields of a shell call that leave it inside the confinement: a time limit and a background run do not take it out. Any other (`dangerouslyDisableSandbox` among them) may. */
const CONFINED_SHELL_FIELDS = new Set([...PLAIN_SHELL_FIELDS, "timeout", "run_in_background"]);

/** Decide about a shell command: the floor first, then the grants (the run's pre-approved list and the standing permissions). */
function shellVerdict(request: GateRequest, input: Record<string, unknown>, grants: readonly Grant[], settings: FloorSettings): GateVerdict {
  const { command } = input;
  if (typeof command !== "string" || command === "") return { verdict: "ask", why: "unknown" };
  if (command.includes("\0")) return { verdict: "deny", reason: "The command holds a NUL character, which no shell can be handed." };
  const rule = floor(command, { worktree: request.worktree, cwd: request.cwd, home: settings.home, real, ...(settings.dataDir === undefined ? {} : { dataDir: settings.dataDir }), ...(settings.extra ? { extra: settings.extra } : {}) });
  // What runs without asking: a confined command with nothing beside it that could take it out, unless the owner asked
  // to be asked before every command of a manual run (a run left without a mode is manual).
  const everyCommand = request.askEveryCommand === true && (request.mode ?? "manual") === "manual";
  const byMode = !everyCommand && request.confined === true && Object.keys(input).every((name) => CONFINED_SHELL_FIELDS.has(name));
  const why: AskWhy = everyCommand ? "every_command" : "not_confined";
  const otherwise: GateVerdict = byMode ? { verdict: "allow", rule: "mode_confined" } : { verdict: "ask", why };
  if (rule === NOT_PLAIN) return byMode ? otherwise : { verdict: "ask", floor: rule, why };
  if (rule !== null) return { verdict: "ask", floor: rule, why: "floor" };
  // A call that carries more than its command (a time limit, a background run) is not the command alone.
  if (!Object.keys(input).every((name) => PLAIN_SHELL_FIELDS.has(name))) return otherwise;
  const words = splitPlain(command);
  if (words === null || request.scope === undefined || request.outsideText === true) return otherwise;
  const relative = path.relative(request.worktree, request.cwd);
  const grant = matchGrant({ ...request.scope, cwd: relative === "" ? "." : relative, words }, grants);
  return grant === null ? otherwise : { verdict: "allow", rule: grant.kind === "standing" ? "standing" : "preapproved", grantId: grant.id };
}

/**
 * Decide about one tool call, given the grants that exist and the floor. Any tool the gate does not know goes
 * to the owner. Without grants nothing but edits and reads inside the worktree is allowed.
 */
export function gate(request: GateRequest, grants: readonly Grant[] = [], settings: FloorSettings = { home: os.homedir() }): GateVerdict {
  const verdict = decide(request, grants, settings);
  // A fully autonomous run puts nothing to the owner: what would ask is refused, and says why.
  if (request.mode !== "full" || verdict.verdict !== "ask") return verdict;
  return { verdict: "refuse", reason: fullAutonomyRefusal(request.tool, verdict.floor), ...(verdict.floor === undefined ? {} : { floor: verdict.floor }) };
}

function decide(request: GateRequest, grants: readonly Grant[], settings: FloorSettings): GateVerdict {
  const input = isObject(request.input) ? request.input : {};
  if (request.tool === "Bash") return shellVerdict(request, input, grants, settings);
  const editField = EDIT_TOOLS[request.tool];
  if (editField !== undefined) {
    const relative = insideWorktree(request.worktree, request.cwd, input[editField]);
    if (relative === null) return { verdict: "ask", why: "outside_copy" };
    if (guarded(relative)) return { verdict: "ask", why: "guarded_in_copy" };
    return { verdict: "allow", rule: "auto_worktree_edit" };
  }
  const readField = READ_TOOLS[request.tool];
  if (readField !== undefined) {
    const where = input[readField];
    if (request.tool !== "Read" && (reachesOut(input.pattern) || reachesOut(input.glob))) return { verdict: "ask", why: "outside_copy" };
    // A search with no path looks in the folder the agent stands in: allowed only when that folder is the worktree or inside it.
    if (where === undefined && request.tool !== "Read") {
      const here = path.resolve(request.cwd);
      const inCopy = (here === path.resolve(request.worktree) && real(here) === real(path.resolve(request.worktree))) || insideWorktree(request.worktree, request.worktree, here) !== null;
      return inCopy ? { verdict: "allow", rule: "worktree_read" } : { verdict: "ask", why: "outside_copy" };
    }
    const target = typeof where === "string" && readsAsJoined(where) ? path.resolve(request.cwd, where) : null;
    const inside = target !== null && (target === path.resolve(request.worktree) || insideWorktree(request.worktree, request.cwd, where) !== null);
    if (inside) return { verdict: "allow", rule: "worktree_read" };
    // The CLI's own saved output of this attempt's calls, links followed: nothing of another session's, nothing else of the CLI's folder.
    if (request.tool === "Read" && request.sessionOutput !== undefined && ownFolder(request.sessionOutput) && insideWorktree(request.sessionOutput, request.cwd, where) !== null) return { verdict: "allow", rule: "session_output_read" };
    return { verdict: "ask", why: "outside_copy" };
  }
  return { verdict: "ask", why: "other_tool" };
}

/**
 * Whether the saved-output folder is itself where it says: neither it nor its session folder is a link, which could lead
 * to another session's output. A folder above them that is a link (a moved configuration folder) is followed as written.
 */
function ownFolder(sessionOutput: string): boolean {
  const folder = path.resolve(sessionOutput);
  const session = path.dirname(folder);
  return real(folder) === path.join(real(path.dirname(session)), path.basename(session), path.basename(folder));
}

/**
 * Where a file tool's request is aimed, for its card: the path relative to the worktree when it lies inside it (links
 * followed), the full path when it does not. Null for a tool that names no path, and for a relative path when the
 * directory it starts from is not known: then the card cannot say where it lands.
 */
export function requestTarget(tool: string, input: unknown, worktree: string, cwd: string | null): string | null {
  const field = EDIT_TOOLS[tool] ?? READ_TOOLS[tool];
  const where = isObject(input) && field !== undefined ? input[field] : undefined;
  if (typeof where !== "string" || where === "" || where.includes("\0")) return null;
  if (cwd === null && !path.isAbsolute(where.trim()) && !where.trim().startsWith("~")) return null;
  const from = cwd ?? worktree;
  // Where the CLI would land it, also for a path it reads differently from a plain join (`~/.zshrc`).
  const full = landing(from, where);
  if (full === path.resolve(worktree) && real(full) === real(path.resolve(worktree))) return ".";
  return insideWorktree(worktree, from, where) ?? full;
}

/** Whether a tool names a file, so that its card shows the file rather than the folder the agent stood in. */
export const namesAFile = (tool: string): boolean => EDIT_TOOLS[tool] !== undefined || tool === "Read";

/**
 * What a card shows for a request, which is all of what an allow lets run: a
 * plain shell command as the command itself, the file a read is aimed at, and
 * for everything else (an edit with its content, a shell call with further
 * options, any other tool) the whole input as the CLI gave it.
 */
export function summarize(tool: string, input: unknown): string {
  const fields = isObject(input) ? input : {};
  if (tool === "Bash" && typeof fields.command === "string" && fields.command !== "" && Object.keys(fields).every((name) => PLAIN_SHELL_FIELDS.has(name))) return fields.command;
  const field = READ_TOOLS[tool];
  if (tool === "Read" && field !== undefined && typeof fields[field] === "string" && fields[field] !== "" && Object.keys(fields).length === 1) return fields[field];
  return JSON.stringify(input ?? null);
}
