import type { Evidence } from "../api/client.ts";

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
      // Stopped by Smelt (the run was cancelled, or Smelt stopped): it says nothing about the command itself.
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
 * The commands Smelt ran on a task, in the order they ran, as the design system's check list: each command, its
 * result in words, how long it took, and its output behind a disclosure. The commands and their output are the
 * owner's and the program's text, marked as such.
 */
export function CommandEvidence({ rows, what }: { rows: readonly Evidence[]; what: { one: string; many: string } }) {
  if (rows.length === 0) return null;
  return (
    <div className="gw-check-list">
      <p className="gw-check-list__summary">{summary(rows, what)}</p>
      <ul className="gw-check-list__items">
        {rows.map((row) => {
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
