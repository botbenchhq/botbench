import type { EvidenceState, StoredEvent } from "../../api/client.ts";

/*
 * What the rebuilt review screen works out for itself (ADR 0012). It is little, on purpose: whether there is an Accept
 * is the server's to say (src/engine/evidence.ts), and the sentences about the evidence are the server's own.
 */

/**
 * The actions the decision panel offers, from the server's state of the task's evidence alone: Accept while the checks
 * are about the commit it keeps, "Accept without verification" when no checks ran, and none while the checks are out of
 * date or the task's copy differs from the commit, or when the server could not read the state. Run checks again is
 * offered only for out-of-date checks the server says it can run again. The server refuses any other accept whatever
 * a screen draws.
 */
export function offered(evidence: EvidenceState | null): { accept: "accept" | "unverified" | null; runAgain: boolean } {
  if (evidence === null) return { accept: null, runAgain: false };
  return { accept: evidence.state === "current" ? "accept" : evidence.state === "none" ? "unverified" : null, runAgain: evidence.state === "stale" && evidence.canRunAgain };
}

/** One row of a diff as the screen draws it: its line number in the new file (the old file's for a removed line), and its text without the sign. */
export interface DiffRow {
  kind: "hunk" | "context" | "added" | "removed" | "note";
  number: number | null;
  text: string;
}

/**
 * A unified diff of one file as rows with line numbers, read from git's own hunk headers. The file headers before the
 * first hunk are left out: the screen names the file itself. Inside a hunk a line is told by its first character, so a
 * removed line that starts with "--" is a removed line, not a header.
 */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let before = 0;
  let after = 0;
  let inHunk = false;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", number: null, text: line });
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push({ kind: "added", number: after++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "removed", number: before++, text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "note", number: null, text: line });
    } else {
      before++;
      rows.push({ kind: "context", number: after++, text: line.slice(1) });
    }
  }
  return rows;
}

/** What is stored of the agent's work, for the one line over its folded activity: its steps (tool calls), and the time from the first stored event to the last. */
export function activityLine(events: readonly StoredEvent[]): { steps: number; ms: number } {
  if (events.length === 0) return { steps: 0, ms: 0 };
  const times = events.map((event) => new Date(event.ts).getTime());
  return { steps: events.filter((event) => event.type === "tool_call").length, ms: Math.max(...times) - Math.min(...times) };
}
