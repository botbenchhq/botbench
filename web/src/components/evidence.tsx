import type { ChecksMark, CommandList, Evidence, Refinement, Review } from "../api/client.ts";
import { failureExtract } from "./failure-extract.ts";
import { Alert } from "./header.tsx";
import { LOOKS } from "./looks.ts";
import { StatusBadge } from "./status.tsx";

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
      return { words: "Passed", look: "ds-check-list__result--passed" };
    case "failed":
      return { words: row.exitCode === null ? `Failed, ended by ${row.signal ?? "a signal"}` : `Failed, exit code ${row.exitCode}`, look: "ds-check-list__result--failed" };
    case "timed_out":
      return { words: `Timed out after ${duration(row.limitMs).words}`, look: "ds-check-list__result--timed-out" };
    case "stopped":
      // Stopped by Botbench (the run was cancelled, or Botbench stopped): it says nothing about the command itself.
      return { words: "Stopped before it finished", look: "" };
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The count a check list opens with: how many passed out of the whole list, then each other result by itself. The
 * whole list is `total`, recorded before its first command ran; a round from before that was recorded counts its rows.
 */
function summary(rows: readonly Evidence[], what: { one: string; many: string }, total = rows.length): string {
  const count = (outcome: Evidence["outcome"]): number => rows.filter((row) => row.outcome === outcome).length;
  const others = [
    count("failed") > 0 ? `${count("failed")} failed` : null,
    count("timed_out") > 0 ? `${count("timed_out")} timed out` : null,
    count("stopped") > 0 ? `${count("stopped")} stopped` : null,
  ].filter((part) => part !== null);
  const notRun = total - rows.length;
  if (notRun > 0) others.push(`${notRun} not run`);
  return `${count("passed")} of ${plural(total, what.one, what.many)} passed.${others.length === 0 ? "" : ` ${others.join(", ")}.`}`;
}

/**
 * The commands Botbench ran on a task, in the order they ran, as the design system's check list: each command, its
 * result in words, how long it took, and its output behind a disclosure. The commands and their output are the
 * owner's and the program's text, marked as such.
 */
export function CommandEvidence({ rows, what, failedFirst = false, testId, total }: { rows: readonly Evidence[]; what: { one: string; many: string }; failedFirst?: boolean; testId?: string; total?: number }) {
  if (rows.length === 0) return null;
  // Checks are read by what needs the reader first; setup commands in the order they ran, which is why a later one never ran.
  const RANK: Record<Evidence["outcome"], number> = { failed: 0, timed_out: 1, stopped: 2, passed: 3 };
  const shownRows = failedFirst ? [...rows].sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || a.position - b.position) : rows;
  return (
    <div data-testid={testId} className="ds-check-list">
      <p className="ds-check-list__summary">{summary(rows, what, Math.max(total ?? rows.length, rows.length))}</p>
      <ul className="ds-check-list__items">
        {shownRows.map((row) => {
          const shown = result(row);
          const took = duration(row.durationMs);
          return (
            <li key={row.id} className="ds-check-list__item">
              <span data-ds-content="" className="ds-check-list__name">
                {row.command}
              </span>
              <span className={`ds-check-list__result ${shown.look}`.trim()}>{shown.words}</span>
              <span className="ds-check-list__duration">
                <time dateTime={took.iso}>{took.words}</time>
              </span>
              {row.kind === "check" && row.outcome === "failed" && <FailureExtract row={row} />}
              <details className="ds-check-list__output">
                <summary className="ds-check-list__toggle">
                  Output
                  <span data-ds-content="" className="ds-visually-hidden">{` of ${row.command}`}</span>
                </summary>
                <pre data-ds-content="" className="ds-check-list__log">
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

/**
 * Above a failed check's output, which opens at its tail: the first lines that look like the failure, with their line
 * numbers, labelled as an extract. The full output stays one tap away below it.
 */
function FailureExtract({ row }: { row: Evidence }) {
  const lines = failureExtract(row.output);
  if (lines.length === 0) return null;
  return (
    <figure data-testid="failure-extract" className="ds-code-block">
      <figcaption className="ds-code-block__caption">{`Extract: lines of the output${row.truncated ? " shown" : ""} that look like the failure`}</figcaption>
      <pre data-ds-content="" className="ds-code-block__body">
        <code className="ds-code-block__lines">
          {lines.map((line) => (
            <span key={line.line} className="ds-code-block__line">
              <span className="ds-code-block__number">{line.line}</span>
              <span className="ds-code-block__text">{line.text}</span>
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

/** The rows of the newest time a list of commands was run on the task: what its result stands on. */
export const latestRound = (rows: readonly Evidence[]): Evidence[] => {
  const newest = Math.max(0, ...rows.map((row) => row.round));
  return rows.filter((row) => row.round === newest);
};

/**
 * A list of commands as it was last run, and before it, folded away, each earlier time it was run: a list stopped by a
 * restart is run again from the start, and what the stopped one did stays on record.
 */
export function CommandRounds({ rows, lists, what, failedFirst = false, testId }: { rows: readonly Evidence[]; lists: readonly CommandList[]; what: { one: string; many: string }; failedFirst?: boolean; testId?: string }) {
  const latest = latestRound(rows);
  const kind = rows[0]?.kind;
  const totalOf = (round: number | undefined): number | undefined => lists.find((list) => list.kind === kind && list.round === round)?.total;
  const earlier = [...new Set(rows.map((row) => row.round))].filter((round) => round !== latest[0]?.round).sort((a, b) => a - b);
  return (
    <>
      <CommandEvidence rows={latest} what={what} failedFirst={failedFirst} total={totalOf(latest[0]?.round)} {...(testId === undefined ? {} : { testId })} />
      {earlier.map((round) => (
        <details key={round} className="ds-disclosure">
          <summary className="ds-disclosure__summary">{`${what.many.charAt(0).toUpperCase()}${what.many.slice(1)} before Botbench restarted`}</summary>
          <div className="ds-disclosure__content">
            <CommandEvidence rows={rows.filter((row) => row.round === round)} what={what} total={totalOf(round)} />
          </div>
        </details>
      ))}
    </>
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
      <StatusBadge look={checks === "passed" ? LOOKS.checkPassed : LOOKS.checkFailed}>{checks === "passed" ? "Checks passed:" : "Checks failed:"}</StatusBadge>
      {checks === "passed" ? ` ${rows.length} of ${plural(rows.length, "check", "checks")} passed.` : ` ${notPassed} of ${plural(rows.length, "check", "checks")} did not pass.`}
    </p>
  );
}

/** The plain sentence about what checks are, shown wherever their results are. */
export const CHECKS_RISK = "Checks run this repository's own commands on the agent's work, on this Mac, in a sandbox: they cannot read the sign-in, key and credential folders Botbench keeps them from or Botbench's own files, can change files only in this task's copy and a temporary folder, and reach the internet only at hosts allowed for this repository in Botbench's settings file. They can still read the rest of your home folder. The agent may have changed the code they run, so read the output, not only the result.";

/** An agent by its product name, as the screens name it (docs/product/voice.md). */
export const agentName = (agent: string): string => ({ "claude-code": "Claude Code", codex: "Codex", "gemini-cli": "Gemini CLI", grok: "Grok", antigravity: "Antigravity" })[agent] ?? agent;

/** The reviewer and its model, as a screen names them: "Codex, gpt-6-luna", or "Codex, its default model". */
export const reviewerWords = (reviewer: { agent: string; model: string | null }): string => `${agentName(reviewer.agent)}, ${reviewer.model ?? "its default model"}`;

/** The plain sentence about what a review is, shown wherever one is. */
export const REVIEW_RISK = "A model's opinion of the changes, not a check. The reviewer read the diff where it could change nothing and reach no network. Botbench reads only its verdict line: with concerns, the builder is given the review to fix what it agrees with, under the same permissions as for its build, and the same reviewer looks again.";

/** A review's verdict line: the verdict in words when the reply gave it in the asked form. */
function verdictWords(review: Review): string {
  if (review.verdict === "looks_right") return "Verdict: looks right";
  if (review.verdict === "concerns") return "Verdict: concerns";
  return "No verdict in the asked form";
}

/**
 * A task's review, under its checks: the verdict line, with the reviewer's own words one tap away behind a disclosure.
 * A review that did not happen says why, in view. The reply is the model's text, marked as such and shown as text.
 */
export function ReviewEvidence({ review }: { review: Review }) {
  if (review.outcome !== "reviewed") {
    return (
      <Alert tone="warning" testId="review-problem">
        {review.problem ?? "There is no review."}
      </Alert>
    );
  }
  const took = duration(review.durationMs);
  return (
    <details data-testid="review-detail" className="ds-disclosure">
      <summary className="ds-disclosure__summary">
        <span data-testid="review-verdict">{verdictWords(review)}</span>
        <span className="ds-disclosure__meta">
          <time dateTime={took.iso}>{took.words}</time>
        </span>
      </summary>
      <div className="ds-disclosure__content ds-stack ds-gap-sm">
        {review.diffCut && <p>{`The diff was ${review.diffChars} characters long, and the reviewer was sent only its first part.`}</p>}
        <figure className="ds-code-block">
          <pre data-ds-content="" data-testid="review-text" className="ds-code-block__body">
            <code>{review.text}</code>
          </pre>
        </figure>
      </div>
    </details>
  );
}

/** A round of fixes in a few words: what the builder did, from its reply's two headings when it used them. */
function fixesWords(fix: Refinement): string {
  const explained = fix.notAddressed === null ? "" : `, explained ${fix.notAddressed.length}`;
  if (!fix.changed) return `Changed nothing${explained}`;
  return fix.addressed === null ? "Changed the work" : `Addressed ${fix.addressed.length}${explained}`;
}

/**
 * One round of fixes, under the review it answers: what the builder did in a few words, with its own reply one tap
 * away. A round that did not finish says why, in view. The reply is the model's text, shown as text.
 */
export function FixesEvidence({ fix }: { fix: Refinement }) {
  if (fix.outcome !== "finished") {
    return (
      <Alert tone="warning" testId="fixes-problem">
        {fix.problem ?? "This round of fixes did not finish."}
      </Alert>
    );
  }
  const took = duration(Math.max(0, Date.parse(fix.endedAt) - Date.parse(fix.startedAt)));
  return (
    <details data-testid="fixes-detail" className="ds-disclosure">
      <summary className="ds-disclosure__summary">
        <span data-testid="fixes-summary">{fixesWords(fix)}</span>
        <span className="ds-disclosure__meta">
          <time dateTime={took.iso}>{took.words}</time>
        </span>
      </summary>
      <div className="ds-disclosure__content ds-stack ds-gap-sm">
        {fix.changed && fix.headCommit !== null && <p>{`Committed as ${fix.headCommit.slice(0, 12)}, and the checks ran again on it.`}</p>}
        <figure className="ds-code-block">
          <pre data-ds-content="" data-testid="fixes-text" className="ds-code-block__body">
            <code>{fix.reply === "" ? "(No reply.)" : fix.reply}</code>
          </pre>
        </figure>
      </div>
    </details>
  );
}
