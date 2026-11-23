import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { askEveryCommand, RUN_MODES, type RunMode } from "../engine/modes.ts";
import { IMPLEMENTER } from "../engine/roles.ts";
import { askWords, gate, type AskWhy, type FloorSettings } from "./gate.ts";
import { entryProblem, MAX_ENTRY, realRepo, showWords, standingGrants, type Grant, type GrantKind } from "./grants.ts";
import { splitPlain } from "./shell.ts";

/*
 * What a command would get, asked of the gate itself, before any run exists: the Permissions screen's check. For each
 * mode the gate is handed the request a build would send for it (a confined shell command from the top folder of a
 * task's copy, by the builder) with the broker's own floor settings, and the grants such a task would have: the
 * commands the repository's settings offer for each task, as in-memory grants of a run that does not exist, and the
 * standing grants in the store. It only reads: nothing is inserted, logged or asked.
 *
 * What it assumes, and says nothing of beyond this: the owner keeps the offered commands when starting the task (they may
 * edit them), the run did not read outside text (a run from a GitHub issue has no grants), and the agent's driver runs
 * the command confined, as Claude Code and Codex do.
 */

/** No run has this id: the in-memory grants are its own, and no grant in the store names it. */
const PREVIEW_RUN = 0;

/** One mode's answer, for the screen. */
export interface ModePreview {
  mode: RunMode;
  verdict: "allow" | "ask" | "refuse";
  /** Why: the gate's allow rule, or the reason it would ask (also when a fully autonomous run refuses it instead). */
  rule: "preapproved" | "standing" | "mode_confined" | AskWhy;
  /** The always-ask rule that names the command, when one does. */
  floor?: string;
  /** The listed command or Always allow that lets it run. */
  grant?: { kind: GrantKind; command: string };
  /** The verdict and the rule, in one plain line. */
  words: string;
}

/** Why a command cannot be checked, in words; null when it can. */
export function commandProblem(command: string): string | null {
  if (command.trim() === "") return "Give a command to check.";
  if (command.length > MAX_ENTRY) return `The command is too long to check: ${MAX_ENTRY} characters at most.`;
  if (command.includes("\0")) return "The command holds a NUL character, which no shell can be handed, so it cannot be checked.";
  return null;
}

/**
 * What `command` would get in each mode in a task of `repo`. `preapproved` is what the repository's settings offer; an
 * entry a task's start would refuse is left out, as it could never be granted. Throws on a command that cannot be checked.
 */
export function previewCommand(db: DatabaseSync, o: { settings: FloorSettings & { dataDir: string }; repo: string; preapproved: readonly string[]; command: string }): ModePreview[] {
  const problem = commandProblem(o.command);
  if (problem !== null) throw new Error(problem);
  const repo = realRepo(o.repo);
  // Where a task's copy lies, as a build's request names it: inside Botbench's data folder, so that the other tasks'
  // copies and Botbench's records around it are guarded as they are for a real one. It need not exist.
  const worktree = path.join(o.settings.dataDir, "worktrees", "run-preview", "task-preview");
  const listed: Grant[] = o.preapproved
    .filter((entry) => entryProblem(entry) === null)
    .map((entry, i) => ({ id: -(i + 1), kind: "preapproved", role: IMPLEMENTER, repo, cwd: ".", words: splitPlain(entry)!, runId: PREVIEW_RUN, taskId: null, createdAt: "" }));
  const grants = [...listed, ...standingGrants(db, { role: IMPLEMENTER, repo })];
  // As the broker reads it for a manual run's request: one that cannot be read counts as on.
  let everyCommand: boolean;
  try {
    everyCommand = askEveryCommand(db);
  } catch (err) {
    console.error(`The setting Ask before every command could not be read: ${err instanceof Error ? err.message : String(err)}`);
    everyCommand = true;
  }
  return RUN_MODES.map((mode) => {
    const verdict = gate({ tool: "Bash", input: { command: o.command }, worktree, cwd: worktree, mode, confined: true, askEveryCommand: everyCommand, outsideText: false, scope: { role: IMPLEMENTER, repo, runId: PREVIEW_RUN } }, grants, o.settings);
    switch (verdict.verdict) {
      case "allow": {
        if (verdict.rule === "preapproved" || verdict.rule === "standing") {
          const grant = grants.find((g) => g.id === verdict.grantId)!;
          const command = showWords(grant.words);
          const words = verdict.rule === "standing" ? `Runs without asking: you chose Always allow for ${command}.` : `Runs without asking: this repository's settings offer ${command} as an allowed command for each task.`;
          return { mode, verdict: "allow", rule: verdict.rule, grant: { kind: grant.kind, command }, words };
        }
        if (verdict.rule === "mode_confined") return { mode, verdict: "allow", rule: "mode_confined", words: "Runs without asking: it runs kept in the task's copy, and the safety rules do not name it." };
        // The gate allows a shell command on no other rule: one it gave would be a change this check has not learnt.
        throw new Error(`The permission check allowed the command on a rule this check does not know (${verdict.rule}).`);
      }
      case "ask":
        return { mode, verdict: "ask", rule: verdict.why, ...(verdict.floor === undefined ? {} : { floor: verdict.floor }), words: `Asks you. ${askWords(verdict.why, { tool: "Bash", ...(verdict.floor === undefined ? {} : { floor: verdict.floor }) })}` };
      case "refuse":
        return { mode, verdict: "refuse", rule: verdict.why, ...(verdict.floor === undefined ? {} : { floor: verdict.floor }), words: `Refused: a fully autonomous run asks you nothing, so what would ask is not run. ${askWords(verdict.why, { tool: "Bash", ...(verdict.floor === undefined ? {} : { floor: verdict.floor }) })}` };
      case "deny":
        // Only a NUL in the command is denied, and it is refused above.
        throw new Error(verdict.reason);
    }
  });
}
