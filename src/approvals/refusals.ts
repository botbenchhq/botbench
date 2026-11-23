import path from "node:path";
import { NOT_PLAIN } from "./floor.ts";
import { CONFINED_SHELL_FIELDS, insideWorktree, namesAFile, type AskWhy } from "./gate.ts";
import { quotedPieces } from "./shell.ts";

/*
 * What a fully autonomous run refused, and whether that refusal stops the run accepting the task without the owner.
 * A refused request never ran, in any kind: the kind decides only whether the owner must look before the task is
 * accepted. It is decided once, when the request is refused, from the request and the gate's reason, and stored with
 * the refusal's entry in the action log (`action_log.refusal`).
 *
 *   floor         the safety rules name it (any rule but "not a plain command", which is no danger of its own)
 *   network       a tool that reaches the network itself (web fetch or search): no host is allowed to an agent's own tool
 *   outside_copy  a file tool not shown to stay inside the task's copy, or aimed at git's own files or Claude Code's settings in it
 *   unconfined    a shell command not shown to run confined that is not a harmless read-only command, one that asked to
 *                 run outside the sandbox, and any request Botbench could not check or place
 *   read_only     a shell command that only reads files inside the task's copy (`readOnlyCommand`), refused only because
 *                 it could not be shown to run confined
 *   other         any other tool: not the shell, not a file, not the network
 * Only `read_only` and `other` let the accept go on; every other kind, and a refusal with no kind (one recorded before
 * kinds were), hands the task back to the owner.
 */

export type RefusalKind = "floor" | "network" | "outside_copy" | "unconfined" | "read_only" | "other";
export const REFUSAL_KINDS: readonly RefusalKind[] = ["floor", "network", "outside_copy", "unconfined", "read_only", "other"];
/** A kind as stored, or null for none or one this version does not know. */
export const asRefusalKind = (value: unknown): RefusalKind | null => ((REFUSAL_KINDS as readonly unknown[]).includes(value) ? (value as RefusalKind) : null);

/**
 * Whether a refusal blocks a fully autonomous run's accept: true when the refused request was on the safety floor or
 * would have left the confinement (network, a path outside the copy, an unconfined request), false for any other.
 * A refusal whose kind is not known (null) blocks.
 */
export function refusalBlocksAccept(kind: RefusalKind | null): boolean {
  return kind !== "read_only" && kind !== "other";
}

/** A refused request, as the broker knew it when it refused it. */
export interface RefusedRequest {
  tool: string;
  /** The tool call's input as the CLI gave it. */
  input: unknown;
  /** The task's copy, as a full path; null when Botbench could not tell which attempt asked. */
  worktree: string | null;
  /** The folder the agent stood in, as a full path (the copy's top when it was not reported). */
  cwd: string;
  /** The safety rule that named it, when one did. */
  floor?: string;
  /** Why it would have asked the owner in a run that asks (gate.ts). */
  why: AskWhy;
}

/** The tools that reach the network themselves, outside any confinement of Botbench's. */
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
/** The fields a tool's input names a file or folder with. */
const PATH_FIELDS = ["file_path", "notebook_path", "path", "paths"];

/** What kind of request was refused. */
export function refusalKind(r: RefusedRequest): RefusalKind {
  if (r.floor !== undefined && r.floor !== NOT_PLAIN) return "floor";
  if (NETWORK_TOOLS.has(r.tool)) return "network";
  const input = typeof r.input === "object" && r.input !== null && !Array.isArray(r.input) ? (r.input as Record<string, unknown>) : {};
  // A file tool is refused only when it was not shown to stay inside the copy's own files; a tool the gate does not
  // name (MultiEdit, LS) but whose input names a path is taken as one.
  const namesAPath = r.tool !== "Bash" && PATH_FIELDS.some((field) => field in input);
  if (namesAFile(r.tool) || r.tool === "Glob" || r.tool === "Grep" || namesAPath || r.why === "outside_copy" || r.why === "guarded_in_copy") return "outside_copy";
  if (r.tool === "Bash") {
    // Asked to run outside the sandbox, or not checked or placed at all: unconfined, whatever the command says.
    if (r.why === "unknown" || r.worktree === null || !Object.keys(input).every((name) => CONFINED_SHELL_FIELDS.has(name))) return "unconfined";
    return typeof input.command === "string" && readOnlyCommand(input.command, r.worktree, r.cwd) ? "read_only" : "unconfined";
  }
  // A request of no known tool that Botbench could not check or place is not known to be harmless.
  return r.why === "unknown" ? "unconfined" : "other";
}

/** Programs that only read the files they are given, or print, and write nothing: none of them runs another program. */
const READ_ONLY_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "stat", "du", "diff", "pwd", "echo", "true"]);
/** git's subcommands that only read the repository. */
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "ls-files", "rev-parse", "blame", "grep"]);
/** Options that make a reading program run something or write a file (`rg --pre`, `git diff --output`, `--ext-diff`). */
const RUNS_OR_WRITES = /^-(exec|execdir|ok|okdir)$|^--(pre|extcmd|exec|config-env|upload-pack|receive-pack|output|ext-diff|textconv)(=|$)/;
/** Sending output or errors nowhere: the one redirection a read-only command may carry. */
const TO_NOWHERE = /(^|\s)(?:[12]?>|&>)\s*\/dev\/null(?=\s|$|[;&|])|(^|\s)2>&1(?=\s|$|[;&|])/g;

/**
 * Whether a shell command only reads files inside the task's copy: every piece of it starts one of a few programs that
 * only read or print (git with a subcommand that only reads), nothing in it runs another program or writes a file, and
 * every word that could be a path lies inside the copy (links followed), read from the folder the agent stood in. A
 * redirection other than to /dev/null, a substitution, a variable, a glob, a `~`, an assignment and a `cd` all make it not one.
 * Leans towards "no": a false "no" only hands a task back to the owner.
 */
export function readOnlyCommand(command: string, worktree: string, cwd: string): boolean {
  const top = path.resolve(worktree);
  const inCopy = (place: string): boolean => path.resolve(cwd, place) === top || insideWorktree(top, cwd, place) !== null;
  if (!inCopy(cwd)) return false;
  const rest = command.replace(TO_NOWHERE, " ");
  if (/[<>]/.test(rest)) return false;
  const read = quotedPieces(rest);
  if (read === null || read.substitutes || read.pieces.length === 0) return false;
  return read.pieces.every((piece) => {
    // What a shell may still turn into other text: a variable, a substitution, a home folder.
    // A glob too: it can match a link that leads out of the copy, which a word read as a literal path does not show.
    if (piece.some((word) => /[$`*?[]/.test(word.live) || word.live.startsWith("~"))) return false;
    const [first, ...args] = piece.map((word) => word.text);
    if (first === undefined) return false;
    let operands = args;
    if (first === "git") {
      if (!READ_ONLY_GIT.has(args[0] ?? "")) return false;
      operands = args.slice(1);
    } else if (!READ_ONLY_PROGRAMS.has(first)) return false;
    return operands.every((word) => {
      if (RUNS_OR_WRITES.test(word)) return false;
      // An option's value is a path wherever a program may read it as one; a bare option names nothing.
      const value = word.startsWith("-") ? (word.includes("=") ? word.slice(word.indexOf("=") + 1) : "") : word;
      return value === "" || inCopy(value);
    });
  });
}
