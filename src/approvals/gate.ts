import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { floor, type FloorEntry } from "./floor.ts";
import { matchGrant, type Grant } from "./grants.ts";
import { splitPlain } from "./shell.ts";

/*
 * The gate: what Smelt itself decides about a tool call before anyone is asked. It is a function of the
 * request, the grants and the safety floor: it writes nothing and asks nobody, and reads the file system only to
 * follow the links in a path.
 *   allow   the call may run, and `rule` says why: an edit or a read inside the worktree, or a command the
 *           owner pre-approved for this run
 *   ask     the owner decides; `floor` names the floor rule when it is the floor that says so
 *   deny    the call cannot be put to anyone as it is
 * The floor is asked before any grant, so no grant gets past it.
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
}

/** The part of the floor that is not the request: the owner's home, and the entries the owner's config adds. */
export interface FloorSettings {
  home: string;
  /** Smelt's data directory, which the floor guards. */
  dataDir?: string;
  extra?: readonly FloorEntry[];
}

export type GateVerdict =
  /** An edit inside the worktree, left to the CLI's own edit rule and logged; or a read inside it, which is not logged. */
  | { verdict: "allow"; rule: "auto_worktree_edit" | "worktree_read" }
  /** A command on the run's pre-approved list. */
  | { verdict: "allow"; rule: "preapproved"; grantId: number }
  /** The owner decides. `floor` is the floor rule that makes this always ask, when one does. */
  | { verdict: "ask"; floor?: string }
  /** Refused without asking anyone. */
  | { verdict: "deny"; reason: string };

/** The tools that change a file, and the field of their input that names it. */
const EDIT_TOOLS: Record<string, string> = { Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };
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
 * Where `file` really is relative to the worktree, links followed, when it is inside it both as
 * written and after following links; null when it is not, or is the worktree itself.
 */
export function insideWorktree(worktree: string, cwd: string, file: unknown): string | null {
  if (typeof file !== "string" || file === "" || file.includes("\0")) return null;
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

/** Decide about a shell command: the floor first, then the run's pre-approved list. */
function shellVerdict(request: GateRequest, input: Record<string, unknown>, grants: readonly Grant[], settings: FloorSettings): GateVerdict {
  const { command } = input;
  if (typeof command !== "string" || command === "") return { verdict: "ask" };
  if (command.includes("\0")) return { verdict: "deny", reason: "The command holds a NUL character, which no shell can be handed." };
  const rule = floor(command, { worktree: request.worktree, cwd: request.cwd, home: settings.home, real, ...(settings.dataDir === undefined ? {} : { dataDir: settings.dataDir }), ...(settings.extra ? { extra: settings.extra } : {}) });
  if (rule !== null) return { verdict: "ask", floor: rule };
  // A call that carries more than its command (a time limit, a background run) is not the command alone.
  if (!Object.keys(input).every((name) => PLAIN_SHELL_FIELDS.has(name))) return { verdict: "ask" };
  const words = splitPlain(command);
  if (words === null || request.scope === undefined) return { verdict: "ask" };
  const relative = path.relative(request.worktree, request.cwd);
  const grant = matchGrant({ ...request.scope, cwd: relative === "" ? "." : relative, words }, grants);
  return grant === null ? { verdict: "ask" } : { verdict: "allow", rule: "preapproved", grantId: grant.id };
}

/**
 * Decide about one tool call, given the grants that exist and the floor. Any tool the gate does not know goes
 * to the owner. Without grants nothing but edits and reads inside the worktree is allowed.
 */
export function gate(request: GateRequest, grants: readonly Grant[] = [], settings: FloorSettings = { home: os.homedir() }): GateVerdict {
  const input = isObject(request.input) ? request.input : {};
  if (request.tool === "Bash") return shellVerdict(request, input, grants, settings);
  const editField = EDIT_TOOLS[request.tool];
  if (editField !== undefined) {
    const relative = insideWorktree(request.worktree, request.cwd, input[editField]);
    if (relative === null || guarded(relative)) return { verdict: "ask" };
    return { verdict: "allow", rule: "auto_worktree_edit" };
  }
  const readField = READ_TOOLS[request.tool];
  if (readField !== undefined) {
    const where = input[readField];
    if (request.tool !== "Read" && (reachesOut(input.pattern) || reachesOut(input.glob))) return { verdict: "ask" };
    if (where === undefined && request.tool !== "Read") return { verdict: "allow", rule: "worktree_read" };
    const target = typeof where === "string" ? path.resolve(request.cwd, where) : null;
    const inside = target !== null && (target === path.resolve(request.worktree) || insideWorktree(request.worktree, request.cwd, where) !== null);
    return inside ? { verdict: "allow", rule: "worktree_read" } : { verdict: "ask" };
  }
  return { verdict: "ask" };
}

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
