import type { DriverEvent, StoredEvent, TaskDetail } from "../../api/client.ts";
import { callLine, ranFor, stepsSummary, type CallLine, type CallState } from "../../components/tool-summary.ts";
import { exchangeOf, RESOLVED_LABEL, RESOLVED_SAID, shownOf, stateOf, type Story } from "../../components/transcript-story.ts";

/*
 * What the task screen works out for itself from a task's stored events, as plain functions (test/task-model.test.ts).
 * The events are read by the transcript's own model (components/transcript.tsx, `readStory`) and worded by the same
 * rules as its rows (components/tool-summary.ts); nothing here says more than the events do.
 */

type Call = Extract<DriverEvent, { type: "tool_call" }>;

/** One step of the agent's work: a tool call, what became of it, and its one line. */
export interface Step {
  id: number;
  call: Call;
  state: CallState;
  line: CallLine;
  /** Why it did not run or end well, in words; null for a step that ran and returned, runs, or waits. */
  note: string | null;
  /** What it returned, once it has. */
  output: string | null;
  /** How long it ran, when its times are stored. */
  ms: number | null;
  /** When it was called. */
  at: string;
}

/** One part of the narrative, in the order things happened. */
export type Part =
  | { kind: "prompt"; id: number; text: string }
  | { kind: "said"; id: number; attemptId: number; text: string; at: string }
  /** Steps that are over, in a row with nothing said between them: folded under one line. */
  | { kind: "steps"; id: number; steps: Step[]; summary: string; open: boolean }
  /** A step that runs now, or waits for the owner's answer: drawn open. */
  | { kind: "step"; id: number; step: Step }
  /** What became of a request to the owner: the owner's answer or note with it (`theirs`), or Botbench's own reason. */
  | { kind: "answer"; id: number; label: string; said: string; note: string | null; theirs: boolean; question: boolean }
  | { kind: "ended"; id: number; reason: "error" | "interrupted"; detail: string | null }
  | { kind: "problem"; id: number; message: string };

const stepOf = (event: StoredEvent, call: Call, story: Story): Step => {
  const state = stateOf(story, call.id, exchangeOf(event));
  const ms = ranFor({ calledAt: story.calledAt.get(call.id), asked: story.asked.has(call.id), allowedAt: story.allowedAt.get(call.id), returnedAt: story.returnedAt.get(call.id) });
  return { id: event.id, call, state, line: callLine(call.name, call.input, state), note: shownOf(story, call.id, state).note, output: story.results.get(call.id)?.output ?? null, ms, at: event.ts };
};

/**
 * The agent's work as a narrative: the owner's messages, what the agent said, and its steps. Steps that are over fold
 * under one line that counts them; a step that runs or waits stands alone, open. A folded group is open by itself only
 * when one of its steps did not end well.
 */
export function narrative(events: readonly StoredEvent[], story: Story): Part[] {
  const parts: Part[] = [];
  let run: Step[] = [];
  const close = (): void => {
    if (run.length === 0) return;
    parts.push({ kind: "steps", id: run[0]!.id, steps: run, summary: stepsSummary(run.map((step) => ({ name: step.call.name, state: step.state }))), open: run.some((step) => step.state !== "done") });
    run = [];
  };
  for (const event of events) {
    const e = event.payload;
    if (e.type === "tool_call") {
      const step = stepOf(event, e, story);
      if (step.state === "running" || step.state === "waiting") {
        close();
        parts.push({ kind: "step", id: event.id, step });
      } else run.push(step);
      continue;
    }
    if (e.type === "user_prompt") (close(), parts.push({ kind: "prompt", id: event.id, text: e.text }));
    else if (e.type === "text") (close(), parts.push({ kind: "said", id: event.id, attemptId: event.attemptId, text: e.text, at: event.ts }));
    else if (e.type === "permission_resolved" && e.decision !== "web" && e.decision !== "chat" && e.decision !== "mode" && e.decision !== "bookkeeping" && e.decision !== "files") (close(), parts.push({ kind: "answer", id: event.id, label: RESOLVED_LABEL[e.decision], said: RESOLVED_SAID[e.decision], note: e.note, theirs: e.decision !== "denied", question: e.decision === "answered" }));
    else if (e.type === "turn_ended" && e.reason !== "completed") (close(), parts.push({ kind: "ended", id: event.id, reason: e.reason, detail: e.detail }));
    else if (e.type === "error") (close(), parts.push({ kind: "problem", id: event.id, message: e.message }));
  }
  close();
  return parts;
}

/** A file the agent's own edits touched, with what the last of them did to it. */
export interface Touched {
  path: string;
  did: "Edited" | "Written";
}

const WRITES: Record<string, Touched["did"]> = { Edit: "Edited", NotebookEdit: "Edited", MultiEdit: "Edited", Write: "Written" };

/**
 * The files the agent's own file edits touched so far, in the order first touched, from its stored calls that returned
 * without an error. A path is shown from the task's copy down where the copy's folder is in it (".../task-7/src/a.ts"
 * is "src/a.ts"). What a shell command changed is not in it: nothing reports that until Botbench commits.
 */
export function filesTouched(events: readonly StoredEvent[], story: Story, taskId: number): Touched[] {
  const files = new Map<string, Touched>();
  const inCopy = `/task-${taskId}/`;
  for (const event of events) {
    const e = event.payload;
    if (e.type !== "tool_call" || WRITES[e.name] === undefined || stateOf(story, e.id, exchangeOf(event)) !== "done") continue;
    const input = e.input as { file_path?: unknown; notebook_path?: unknown } | null;
    const given = typeof input?.file_path === "string" ? input.file_path : typeof input?.notebook_path === "string" ? input.notebook_path : null;
    if (given === null) continue;
    const at = given.lastIndexOf(inCopy);
    const path = at === -1 ? given : given.slice(at + inCopy.length);
    files.set(path, { path, did: files.get(path)?.did === "Written" ? "Written" : WRITES[e.name]! });
  }
  return [...files.values()];
}

/** One stage a task goes through on its way to a decision. */
export interface Stage {
  name: string;
  state: "done" | "now" | "later";
}

/**
 * The stages of a task that is on its way, for its progress: the work, the checks, the review when its run names a
 * reviewer, and the decision, which is the owner's unless the run is fully autonomous.
 */
export function stages(task: Pick<TaskDetail, "status" | "reviewer" | "mode">): Stage[] {
  const names = ["Work", "Checks", ...(task.reviewer === null ? [] : ["Review"]), task.mode === "full" ? "Decision" : "Your decision"];
  const at = task.status === "verifying" ? 1 : task.status === "reviewing" ? 2 : task.status === "awaiting_decision" ? names.length - 1 : 0;
  return names.map((name, i) => ({ name, state: i < at ? "done" : i === at ? "now" : "later" }));
}

/** Which body the task's screen shows: the review (ready for review, or decided), the recovery (it ended without a result to review), or the work under way. */
export function viewOf(task: Pick<TaskDetail, "status" | "decision">): "review" | "recovery" | "work" {
  if (task.status === "awaiting_decision" || task.decision !== null) return "review";
  if (task.status === "failed" || task.status === "interrupted" || task.status === "cancelled" || task.status === "drafted") return "recovery";
  return "work";
}

/**
 * A reason the server gives for how a task ended, as what happened and, apart, the agent's own last message when the
 * server quotes it after "Its last message:" (src/engine/task.ts): the one is Botbench's sentence, the other a model's
 * words, and the screen draws them as different kinds of claim.
 */
export function reasonParts(reason: string): { what: string; said: string | null } {
  const mark = " Its last message: ";
  const at = reason.indexOf(mark);
  return at === -1 ? { what: reason, said: null } : { what: reason.slice(0, at), said: reason.slice(at + mark.length) };
}
