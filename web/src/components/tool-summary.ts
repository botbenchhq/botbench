/*
 * How a tool call is said in one plain line (docs/product/voice.md, "Tool activity"). Everything here is derived
 * from the call's own name and arguments and from the events that followed it. Nothing is guessed: a tool with no
 * verb below, or a call whose arguments do not hold what the verb needs, is shown by its own name and main argument.
 */

/** What became of a call, from the events stored about it. */
export type CallState = "waiting" | "running" | "done" | "failed" | "refused" | "unfinished";

interface Verbs {
  /** The argument the verb is about. */
  field: string;
  /** Whether the argument is a file path, shown on the line by its last part; the whole path is one tap away. */
  file: boolean;
  waiting: string;
  running: string;
  done: string;
  refused: string;
  /** Said of a call that failed. A command that failed still ran, so it keeps "Ran" and gets "failed" after it. */
  failed: string | null;
}

const verbs = (field: string, file: boolean, base: string, running: string, done: string): Verbs => ({ field, file, waiting: `Wants to ${base}`, running, done, refused: `Did not ${base}`, failed: base === "run" ? null : `Could not ${base}` });

/** The tools Smelt has a plain verb for, by the name Claude Code gives them. */
const VERBS: Record<string, Verbs> = {
  Bash: verbs("command", false, "run", "Running", "Ran"),
  Read: verbs("file_path", true, "read", "Reading", "Read"),
  Edit: verbs("file_path", true, "edit", "Editing", "Edited"),
  NotebookEdit: verbs("notebook_path", true, "edit", "Editing", "Edited"),
  Write: verbs("file_path", true, "write", "Writing", "Wrote"),
  Grep: verbs("pattern", false, "search for", "Searching for", "Searched for"),
  Glob: verbs("pattern", false, "look for files matching", "Looking for files matching", "Looked for files matching"),
  WebFetch: verbs("url", false, "fetch", "Fetching", "Fetched"),
  WebSearch: verbs("query", false, "search the web for", "Searching the web for", "Searched the web for"),
};

/** The fields that say what a call was aimed at, in the order they are looked for, when no verb names one. */
const TARGET_FIELDS = ["command", "file_path", "notebook_path", "pattern", "url", "query", "path"] as const;

const fields = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const shorten = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);
const firstLine = (value: string): string => value.trim().split("\n")[0] ?? "";
const lastPart = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) ?? path;

/** What a call ran or was aimed at, whole, from its own arguments: empty when none of them says. */
export function callTarget(input: unknown): string {
  const given = fields(input);
  for (const field of TARGET_FIELDS) if (text(given[field]) !== "") return text(given[field]);
  return "";
}

/** The agent's own sentence about why it made a call, when its arguments carry one. */
export function callReason(input: unknown): string | null {
  const description = text(fields(input).description).trim();
  return description === "" ? null : description;
}

const STATE_WORDS: Record<CallState, string> = { waiting: "waiting for your answer", running: "running", done: "", failed: "failed", refused: "not run", unfinished: "did not finish" };

export interface CallLine {
  /** The plain verb. Null when Smelt has none that is certainly true: the tool's own name is shown in its place. */
  verb: string | null;
  /** The tool's own name, as the agent reported it. */
  tool: string;
  /** The object on the line: one line of the command, the file's name, what was searched for. May be empty. */
  object: string;
  /** The whole of what the object was shortened from. */
  whole: string;
  /** What is added after the object, in words: "failed", or the state of a call shown by its own name. */
  note: string;
}

/** The one line for a call. */
export function callLine(name: string, input: unknown, state: CallState): CallLine {
  const known = VERBS[name];
  const whole = known === undefined ? "" : text(fields(input)[known.field]);
  // No verb, or not the argument the verb is about, or a call that neither returned nor is still going: the real name and argument, and the state in words.
  if (known === undefined || whole === "" || state === "unfinished") {
    const target = callTarget(input);
    return { verb: null, tool: name, object: shorten(firstLine(target), 80), whole: target, note: STATE_WORDS[state] };
  }
  const object = shorten(known.file ? lastPart(whole) : firstLine(whole), 80);
  if (state === "failed") return known.failed === null ? { verb: known.done, tool: name, object, whole, note: "failed" } : { verb: known.failed, tool: name, object, whole, note: "" };
  return { verb: state === "done" ? known.done : known[state], tool: name, object, whole, note: "" };
}

/** One line of a change, as a unified diff writes it: its sign, then its text. */
export type ChangeLine = `${"+" | "-" | " "}${string}`;

const MAX_DIFF_LINES = 400;

/**
 * The change an edit asked for, line by line, from the two texts in its own arguments. Null when either is too long
 * to compare here; the raw arguments still hold both.
 */
export function lineChanges(before: string, after: string): ChangeLine[] | null {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  // The longest run of lines the two share, by the standard table; what is outside it was removed or added.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const lines: ChangeLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (lines.push(` ${a[i]!}`), i++, j++);
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) lines.push(`-${a[i++]!}`);
    else lines.push(`+${b[j++]!}`);
  }
  while (i < a.length) lines.push(`-${a[i++]!}`);
  while (j < b.length) lines.push(`+${b[j++]!}`);
  return lines;
}

/**
 * What an Edit call changed, from its own arguments: the lines, and how many were added and removed. Null when the
 * call is not a single replacement whose two texts are there (one that replaces every occurrence changes an unknown
 * number of places, so no count is given for it).
 */
export function editChange(name: string, input: unknown): { lines: ChangeLine[]; added: number; removed: number } | null {
  const given = fields(input);
  if (name !== "Edit" || typeof given.old_string !== "string" || typeof given.new_string !== "string" || given.replace_all === true) return null;
  const lines = lineChanges(given.old_string, given.new_string);
  if (lines === null) return null;
  return { lines, added: lines.filter((line) => line.startsWith("+")).length, removed: lines.filter((line) => line.startsWith("-")).length };
}

/** The text a Write call wrote, from its own arguments, and how many lines it has. Null when it is not there. */
export function writtenText(name: string, input: unknown): { text: string; lines: number } | null {
  const content = fields(input).content;
  if (name !== "Write" || typeof content !== "string") return null;
  return { text: content, lines: content === "" ? 0 : content.replace(/\n$/, "").split("\n").length };
}

/** How long something took, from two stored times: "42s", "2m 14s", "1h 3m". Null when either is not a time or they are out of order. */
export function duration(from: string, to: string): string | null {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
