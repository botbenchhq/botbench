import type { RunSourceRef, TaskStatus } from "../api/client.ts";

/*
 * "Make this a run" (src/engine/run-source.ts): the owner's note on a finished task or a chat opens the composer on Plan
 * a run, with the note as the prompt. Only the owner's words go with it, and nothing is stored until Send. What the
 * screens decide is here, as plain functions, so it is tested without a browser; the words are the server's own.
 */

/** The longest note, in characters; the server holds the same limit (src/engine/run-source.ts `MAX_RUN_NOTE`). */
export const MAX_RUN_NOTE = 10_000;
export const NOTE_EMPTY = "The note is empty. Say in it what the run should do.";
export const noteTooLong = (length: number): string => `The note is too long: ${MAX_RUN_NOTE.toLocaleString("en-US")} characters at most, and this one has ${length.toLocaleString("en-US")}.`;

/** Why `note` cannot be sent as the run's message, in the server's words; null when it can. */
export function noteProblem(note: string): string | null {
  if (note.trim() === "") return NOTE_EMPTY;
  if (note.length > MAX_RUN_NOTE) return noteTooLong(note.length);
  return null;
}

/** Whether a task's screen offers "Make this a run": once it is ready for review, accepted or rejected, never while it is at work. */
export const offersRun = (status: TaskStatus): boolean => status === "awaiting_decision" || status === "accepted" || status === "rejected";

export const MAKE_RUN = "Make this a run";
export const NOTE_LABEL = "Note for the run";
export const ABOUT = {
  task: "Your note opens Plan a run in this task's repository, with your note as the message. The run is told this task's number and branch, and nothing the agents wrote here. Nothing starts until you press Send.",
  chat: "Your note opens Plan a run, with your note as the message. Nothing the agents wrote in this chat goes with it. Nothing starts until you press Send.",
} as const;
/** The heading over the owner's own messages in a chat, any of which may be used as the note. */
export const PICK_HEADING = "Use one of your messages";
export const PICK_ABOUT = "Only your own messages are listed. Choosing one puts it in the note, where you can change it.";

/** The composer's address for a run made from `source`. */
export const composerAddress = (source: RunSourceRef): string => `#/turn?start=run&from=${source.kind}-${source.id}`;

/** The source in a composer's address, or null. */
export function sourceInAddress(at: string): RunSourceRef | null {
  const m = /^\/turn\?start=run&from=(task|chat)-([1-9]\d{0,14})$/.exec(at);
  return m === null ? null : { kind: m[1] as RunSourceRef["kind"], id: Number(m[2]) };
}

/**
 * What is handed to the composer across the screen change: the source it is for, the note, and the repository the
 * composer opens on (the task's; for a chat, the one it read on this device, or none).
 */
export interface HandOff {
  source: RunSourceRef;
  note: string;
  repo: string | null;
}

/** What a task or a chat gives "Make this a run": a task with its repository, or a chat. */
export type MakeRunSource = { kind: "task"; id: number; repo: string } | { kind: "chat"; id: number };

/**
 * Make this a run, decided: the composer's address and what is handed to it, or the plain reason the note is refused
 * (the server's words). `chatRepo`: for a chat, the repository it read on this device, or null; a task's is its own.
 */
export function makeRun(source: MakeRunSource, note: string, chatRepo: string | null = null): { address: string; handOff: HandOff } | { refused: string } {
  const refused = noteProblem(note);
  if (refused !== null) return { refused };
  const ref: RunSourceRef = { kind: source.kind, id: source.id };
  return { address: composerAddress(ref), handOff: { source: ref, note, repo: source.kind === "task" ? source.repo : chatRepo } };
}

/** The one line saying where a run came from; the server's own (src/engine/run-source.ts `sourceLabel`). */
export const sourceLabel = (source: RunSourceRef): string => (source.kind === "task" ? `From task ${source.id}` : "From a chat");

/** What the composer opens with for a run made from a task or a chat. */
export interface Opening {
  kind: "run";
  /** The note, as the prompt. */
  prompt: string;
  /** The repository the composer opens on: the task's, or for a chat the one handed over; null leaves the composer's own. */
  repo: string | null;
  source: ComposerSource;
}

/**
 * The composer's opening state, from the source in its address and what was handed to it. Null, a plain composer
 * with no error, when nothing was handed over (the address opened again, or on its own) or it was for another source.
 */
export function composerOpening(from: RunSourceRef | null, handed: HandOff | null): Opening | null {
  if (from === null || handed === null || handed.source.kind !== from.kind || handed.source.id !== from.id) return null;
  return { kind: "run", prompt: handed.note, repo: handed.repo, source: { ref: from, label: sourceLabel(from), repo: from.kind === "task" ? handed.repo : null } };
}

/** Where the hand-off is kept: this tab's session storage, which a browser may refuse. */
export interface HandOffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const tabStorage = (): HandOffStorage => window.sessionStorage;

const HAND_OFF_KEY = "botbench.runNote";
/** Kept in this page too, for a browser that refuses storage: the hand-off then lasts until a reload. */
let held: HandOff | null = null;

/** Keep the note for the composer, which takes it once. Nothing leaves the device. */
export function handOff(given: HandOff, storage: () => HandOffStorage = tabStorage): void {
  held = given;
  let kept: HandOffStorage;
  try {
    kept = storage();
  } catch {
    // Private browsing may refuse storage; `held` still carries it within this page.
    return;
  }
  // An older note is never left behind: it goes first, and again if this one could not be written (storage full).
  try {
    kept.removeItem(HAND_OFF_KEY);
    kept.setItem(HAND_OFF_KEY, JSON.stringify(given));
  } catch {
    try {
      kept.removeItem(HAND_OFF_KEY);
    } catch {
      // Nothing more can be done with this storage; `held` carries the note within this page.
    }
  }
}

/**
 * The note handed to the composer, once: whatever kept it, it is gone after this is read. The one held in this page is
 * the newest and wins; the stored one counts only after a reload, when nothing is held.
 */
export function takeHandOff(storage: () => HandOffStorage = tabStorage): HandOff | null {
  const inPage = held;
  held = null;
  let stored: HandOff | null = null;
  try {
    const kept = storage();
    const raw = kept.getItem(HAND_OFF_KEY);
    kept.removeItem(HAND_OFF_KEY);
    if (raw !== null) stored = readHandOff(raw);
  } catch {
    // No storage: what was held in this page stands.
  }
  return inPage ?? stored;
}

/** A stored hand-off, each part checked: anything that is not one is none. */
export function readHandOff(raw: string): HandOff | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { source, note, repo } = parsed as Record<string, unknown>;
    if (typeof note !== "string" || typeof source !== "object" || source === null) return null;
    const { kind, id } = source as Record<string, unknown>;
    if ((kind !== "task" && kind !== "chat") || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
    return { source: { kind, id }, note, repo: typeof repo === "string" && repo !== "" ? repo : null };
  } catch {
    return null;
  }
}

/** A message the owner wrote, as the picker shows it: one line, cut. The whole message is what is put in the note. */
export function messagePreview(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

/** The source a composer holds once the server has read it: its line, and for a task the repository it must stay in. */
export interface ComposerSource {
  ref: RunSourceRef;
  label: string;
  repo: string | null;
}

/** Why a run from `source` cannot be sent from `repoPath`, in the server's words; null when it can. */
export function sourceRepoProblem(source: ComposerSource, repoPath: string): string | null {
  if (source.ref.kind !== "task" || source.repo === null || repoPath === source.repo) return null;
  return `Task ${source.ref.id} was built in ${source.repo}, not ${repoPath}. A run made from it works in the same repository.`;
}
