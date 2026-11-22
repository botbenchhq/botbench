import type { ChecksMark, Evidence } from "../api/client.ts";
import { Icon } from "./icon.tsx";

/** A duration in words with its unit, and as an ISO 8601 duration for the time element. */
export function duration(ms: number): { words: string; iso: string } {
  if (ms < 10_000) {
    const s = Math.round(ms / 100) / 10;
    return { words: `${s} s`, iso: `PT${s}S` };
  }
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const s = total % 60;
  if (min === 0) return { words: `${s} s`, iso: `PT${s}S` };
  return { words: s === 0 ? `${min} min` : `${min} min ${s} s`, iso: `PT${min}M${s === 0 ? "" : `${s}S`}` };
}

/** A command's result in words, and the modifier that draws its icon. The word always says it; the icon only repeats it. */
function result(row: Evidence): { words: string; look: string } {
  switch (row.outcome) {
    case "passed":
      return { words: "Passed", look: "gw-check-list__result--passed" };
    case "failed":
      return { words: row.exitCode === null ? `Failed, ended by ${row.signal ?? "a signal"}` : `Failed, exit code ${row.exitCode}`, look: "gw-check-list__result--failed" };
    case "timed_out":
      return { words: `Timed out after ${duration(row.limitMs).words}`, look: "gw-check-list__result--timed-out" };
    case "stopped":
      // Stopped by Botbench (the run was cancelled, or Botbench stopped): it says nothing about the command itself.
      return { words: "Stopped before it finished", look: "" };
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The count a check list opens with: how many passed, then each other result by itself. */
function summary(rows: readonly Evidence[], what: { one: string; many: string }): string {
  const count = (outcome: Evidence["outcome"]): number => rows.filter((row) => row.outcome === outcome).length;
  const others = [
    count("failed") > 0 ? `${count("failed")} failed` : null,
    count("timed_out") > 0 ? `${count("timed_out")} timed out` : null,
    count("stopped") > 0 ? `${count("stopped")} stopped` : null,
  ].filter((part) => part !== null);
  return `${count("passed")} of ${plural(rows.length, what.one, what.many)} passed.${others.length === 0 ? "" : ` ${others.join(", ")}.`}`;
}

/**
 * The commands Botbench ran on a task, in the order they ran, as the design system's check list: each command, its
 * result in words, how long it took, and its output behind a disclosure. The commands and their output are the
 * owner's and the program's text, marked as such.
 */
export function CommandEvidence({ rows, what, failedFirst = false, testId }: { rows: readonly Evidence[]; what: { one: string; many: string }; failedFirst?: boolean; testId?: string }) {
  if (rows.length === 0) return null;
  // Checks are read by what needs the reader first; setup commands in the order they ran, which is why a later one never ran.
  const RANK: Record<Evidence["outcome"], number> = { failed: 0, timed_out: 1, stopped: 2, passed: 3 };
  const shownRows = failedFirst ? [...rows].sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || a.position - b.position) : rows;
  return (
    <div data-testid={testId} className="gw-check-list">
      <p className="gw-check-list__summary">{summary(rows, what)}</p>
      <ul className="gw-check-list__items">
        {shownRows.map((row) => {
          const shown = result(row);
          const took = duration(row.durationMs);
          return (
            <li key={row.id} className="gw-check-list__item">
              <span data-gw-content="" className="gw-check-list__name">
                {row.command}
              </span>
              <span className={`gw-check-list__result ${shown.look}`.trim()}>{shown.words}</span>
              <span className="gw-check-list__duration">
                <time dateTime={took.iso}>{took.words}</time>
              </span>
              <details className="gw-check-list__output">
                <summary className="gw-check-list__toggle">
                  Output
                  <span data-gw-content="" className="gw-visually-hidden">{` of ${row.command}`}</span>
                </summary>
                <pre data-gw-content="" className="gw-check-list__log">
                  {row.truncated ? `…\n${row.output}` : row.output === "" ? "(no output)" : row.output}
                </pre>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What a task's checks found, in a word or two, for lists. */
export function checksWords(checks: ChecksMark): string {
  return checks === "passed" ? "Checks passed" : checks === "failed" ? "Checks failed" : "No checks set up";
}

/**
 * What a task's checks found, as a badge with its icon and a sentence: the words always say it, the icon and tone only
 * repeat it. A repository with no check commands says so, with no badge: nothing that reads as a pass.
 */
export function ChecksResult({ checks, rows }: { checks: ChecksMark; rows: readonly Evidence[] }) {
  if (checks === "none") return <p data-testid="checks-result">No checks are set up for this repository.</p>;
  const notPassed = rows.filter((row) => row.outcome !== "passed").length;
  return (
    <p data-testid="checks-result">
      <span className={checks === "passed" ? "gw-badge gw-badge--success" : "gw-badge gw-badge--danger"}>
        <Icon name={checks === "passed" ? "circle-check" : "circle-alert"} className="gw-badge__icon" />
        {checks === "passed" ? "Checks passed:" : "Checks failed:"}
      </span>
      {checks === "passed" ? ` ${rows.length} of ${plural(rows.length, "check", "checks")} passed.` : ` ${notPassed} of ${plural(rows.length, "check", "checks")} did not pass.`}
    </p>
  );
}

/** The plain sentence about what checks are, shown wherever their results are. */
export const CHECKS_RISK = "Checks run this repository's own commands on the agent's work, on this Mac, with your account's rights. The agent may have changed the code they run, so read the output, not only the result.";
