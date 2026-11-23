/*
 * How a tool call is said in one plain line (docs/product/voice.md, "Tool activity"). Everything here is derived
 * from the call's own name and arguments and from the events that followed it. Nothing is guessed: a tool with no
 * verb below, or a call whose arguments do not hold what the verb needs, is shown by its own name and main argument.
 */

import { counted, duration } from "../app/format.ts";

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

/** The tools Botbench has a plain verb for, by the name Claude Code gives them. */
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
  // Claude Code's question to the owner: its object is the one question's text (`questionText`), not a field of its own.
  AskUserQuestion: { field: "", file: false, waiting: "Asks you", running: "Asking you", done: "Asked you", refused: "Did not ask you", failed: "Could not ask you" },
};

/** The one question an AskUserQuestion call asks, from its own arguments; empty when it holds no single question. */
function questionText(input: unknown): string {
  const questions = fields(input).questions;
  return Array.isArray(questions) && questions.length === 1 ? text(fields(questions[0]).question) : "";
}

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
  /** The plain verb. Null when Botbench has none that is certainly true: the tool's own name is shown in its place. */
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
  const whole = known === undefined ? "" : name === "AskUserQuestion" ? questionText(input) : text(fields(input)[known.field]);
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

/**
 * How long a call ran, in milliseconds, from stored times: from when it was allowed when the owner was asked (the wait
 * for the answer is not running), else from the call, to its result. Null when a time is missing or out of order: a
 * call that was asked about with no stored answer shows no time rather than one that holds the wait.
 */
export function ranFor(t: { calledAt?: string | undefined; asked: boolean; allowedAt?: string | undefined; returnedAt?: string | undefined }): number | null {
  const from = t.asked ? t.allowedAt : t.calledAt;
  if (from === undefined || t.returnedAt === undefined) return null;
  const ms = Date.parse(t.returnedAt) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** How long something took, from two stored times, in the transcript's short form ("42s", "2m 14s", "1h 3m"). Null when either is not a time or they are out of order. */
export function workedFor(from: string, to: string): string | null {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? duration(ms, "short").words : null;
}

/** What a step group counts each tool's calls as, in the past tense the rows use: the verb, and the thing in one and many. */
const KINDS: Record<string, [verb: string, one: string, many: string]> = {
  Bash: ["ran", "command", "commands"],
  Read: ["read", "file", "files"],
  Edit: ["edited", "file", "files"],
  NotebookEdit: ["edited", "notebook", "notebooks"],
  Write: ["wrote", "file", "files"],
  Grep: ["searched", "time", "times"],
  Glob: ["looked for files", "time", "times"],
  WebFetch: ["fetched", "page", "pages"],
  WebSearch: ["searched the web", "time", "times"],
};

/**
 * The line of a step group (the design system's step group), counted from its calls: each kind of call that ran and
 * returned, in the order the kinds first appear ("Ran 2 commands, edited 1 file"), then how many were not run and how
 * many did not finish. A call that failed, runs or waits is not in a count: the group says it in words of its own.
 * Empty when no call has ended in one of these ways yet.
 */
export function stepsSummary(steps: readonly { name: string; state: CallState }[]): string {
  const counts = new Map<string, { kind: [string, string, string]; n: number }>();
  for (const step of steps) {
    if (step.state !== "done") continue;
    const kind = KINDS[step.name] ?? [`used ${step.name}`, "time", "times"];
    const key = kind.join("|");
    counts.set(key, { kind, n: (counts.get(key)?.n ?? 0) + 1 });
  }
  const parts = [...counts.values()].map(({ kind: [verb, one, many], n }) => `${verb} ${counted(n, one, many)}`);
  const notRun = steps.filter((step) => step.state === "refused").length;
  const unfinished = steps.filter((step) => step.state === "unfinished").length;
  if (notRun > 0) parts.push(`${notRun} not run`);
  if (unfinished > 0) parts.push(`${unfinished} did not finish`);
  const line = parts.join(", ");
  return line === "" ? "" : `${line[0]!.toUpperCase()}${line.slice(1)}`;
}

/**
 * What the sandbox kept a call from, in plain words, from what its result reports (U27): a note for the call's line and
 * the sentences behind it. The report is read from the output, which the command also writes, so the words say what
 * the output says. Null when it says nothing of the kind.
 */
export function confinedWords(confined: { hosts: string[]; files: boolean } | undefined): { note: string; sentences: string[] } | null {
  if (confined === undefined || (confined.hosts.length === 0 && !confined.files)) return null;
  const hosts = confined.hosts.length > 0;
  const note = confined.files && hosts ? "kept from a file and the network" : confined.files ? "kept from a file" : "kept from the network";
  const sentences: string[] = [];
  if (confined.files) sentences.push("Its output says it was not allowed to open a file. The agent cannot read your sign-ins, your keys or Botbench's own files.");
  if (hosts) sentences.push(`Its output says a connection to ${confined.hosts.join(", ")} was not allowed. The agent's commands reach only the hosts allowed for this repository in Botbench's settings file, and none when no host is.`);
  return { note, sentences };
}

/**
 * Whether a step group is drawn open. The reader's own choice stands. Otherwise it is open while the reply it belongs to
 * is still arriving, so the calls are seen as they happen, and stays open while any call in it failed, was not run, did
 * not finish or waits for an answer; once the reply has finished well it folds to its one line, one tap from the calls.
 */
export function stepGroupOpen({ touched, live, states }: { touched: boolean | null; live: boolean; states: readonly CallState[] }): boolean {
  if (touched !== null) return touched;
  return live || states.some((state) => state !== "done");
}

/** Where the agent stood, in words. The path is relative to the task's own copy of the project; "" is a folder nobody reported. */
export function directoryWords(cwd: string): string {
  if (cwd === ".") return "The top folder of the task's copy";
  if (cwd === "") return "Not reported";
  return cwd === ".." || cwd.startsWith("../") ? `${cwd} (outside the task's copy)` : `${cwd} (inside the task's copy)`;
}

/** The tools whose request names one file: their card shows that file, not the folder the agent stood in. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);

/** The path a file tool's request names, from what the card shows of it: a Read's path alone, or the field of its input. */
function givenPath(tool: string, command: string): string | null {
  let input: unknown;
  try {
    input = JSON.parse(command);
  } catch {
    // A Read with nothing but its path is shown as the path itself.
    return tool === "Read" && command !== "" ? command : null;
  }
  // A Read's path alone may itself read as JSON (a file named `123` or `null`): it is still the path.
  if (typeof input !== "object" || input === null || Array.isArray(input)) return tool === "Read" && command !== "" ? command : null;
  const fields = input as Record<string, unknown>;
  const found = fields.file_path ?? fields.notebook_path;
  return typeof found === "string" && found !== "" ? found : null;
}

/**
 * Where a request is aimed, as its card says it: the file of a file tool, the folder a search looks in, and otherwise the
 * folder the agent stood in. `target` is the server's: relative to the task's copy (or a chat's folder) when inside it, a
 * full path when not. In a chat a tool that is neither the shell nor a file tool (a web fetch or search) is aimed at what
 * its own line names, not at a folder: null then.
 */
export function placeWords(approval: { tool: string; cwd: string; target: string | null; command: string; chat?: boolean }): { term: "File" | "Folder"; words: string } | null {
  const file = FILE_TOOLS.has(approval.tool);
  const chat = approval.chat === true;
  const where = chat ? "the chat's folder" : "the task's copy";
  const folder = (cwd: string): string => (!chat ? directoryWords(cwd) : cwd === "." ? "The chat's own folder" : cwd === "" ? "Not reported" : cwd === ".." || cwd.startsWith("../") ? `${cwd} (outside the chat's folder)` : `${cwd} (inside the chat's folder)`);
  if (chat && !file && approval.tool !== "Bash" && !SEARCH_TOOLS.has(approval.tool)) return null;
  const { target } = approval;
  if (target === null && file) {
    // The server could not place it (a relative path from a folder nobody reported): the path as the agent gave it.
    const given = givenPath(approval.tool, approval.command);
    return { term: "File", words: given === null ? "Not reported" : `${given} (the folder it starts from was not reported)` };
  }
  if (target === null) return { term: "Folder", words: folder(approval.cwd) };
  if (target === ".") return { term: "Folder", words: folder(".") };
  return { term: file ? "File" : "Folder", words: target.startsWith("/") ? `${target} (outside ${where})` : `${target} (inside ${where})` };
}

/** The tools that search files: their card shows the folder they look in. */
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);

/**
 * How an approval card says what is asked: for a tool that is not a shell command, a line in words from the tool's name
 * and main argument (as the transcript says it), with its raw arguments, which are what an allow lets run, laid out for
 * one tap away. `line` is null when the command itself is the line: a shell command, or text that is not the JSON of an
 * object.
 */
export function approvalWords(tool: string, command: string): { line: string | null; raw: string } {
  if (tool === "Bash") return { line: null, raw: command };
  let input: unknown;
  try {
    input = JSON.parse(command);
  } catch {
    return { line: null, raw: command };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { line: null, raw: command };
  const said = callLine(tool, input, "waiting");
  const line = said.verb === null ? (said.object === "" ? tool : `${tool}: ${said.object}`) : `${said.verb} ${said.object}`;
  return { line, raw: JSON.stringify(input, null, 2) };
}
