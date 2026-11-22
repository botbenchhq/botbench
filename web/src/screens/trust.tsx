import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getActionLog, listGrants, revokeGrant, type LogEntry, type LogRule, type StandingGrant } from "../api/client.ts";
import { times, visible } from "../components/approval-card.tsx";
import { ConfirmAction } from "../components/confirm.tsx";
import { Header } from "../components/header.tsx";

/** How many log entries are read at a time. */
const PAGE = 10;

/** The rule that decided, in words. */
const RULE_WORDS: Record<LogRule, string> = {
  asked_owner: "Asked you",
  owner_allowed: "You allowed",
  owner_declined: "You declined",
  ended_unanswered: "Ended without your answer",
  auto_worktree_edit: "Edited a file in the worktree, without asking",
  broker_failure_denied: "Smelt denied",
  stored_answer_applied: "Your answer from before a restart was used",
  stored_answer_discarded: "Your answer from before a restart was not used",
  preapproved: "Ran pre-approved, without asking",
  standing: "Ran on standing permission, without asking",
  standing_granted: "You gave standing permission",
  standing_revoked: "You took standing permission back",
};

const when = (ts: string): string => new Date(ts).toLocaleString();
/** An edit's entry holds the whole file it wrote; the list shows where each entry begins. */
const shorten = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}…` : text);
/** Where a standing permission applies, in words. The path is relative to the worktree of whichever task asks. */
const directoryWords = (cwd: string): string => (cwd === "." ? "The top of a task's worktree" : `${cwd}, inside a task's worktree`);

/**
 * What Smelt may do without asking, and what it did: the standing permissions in force, each with the control
 * that takes it back, and the action log, newest first.
 */
export function TrustScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [grants, setGrants] = useState<StandingGrant[] | null>(null);
  const [offerAfter, setOfferAfter] = useState<number | null>(null);
  const [log, setLog] = useState<{ entries: LogEntry[]; older: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Counts reads of the log's newest page, so an answer that arrives after a newer one was asked for is dropped. */
  const reads = useRef(0);

  const failed = useCallback(
    (what: string) =>
      (err: unknown): void => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setBusy(false);
        setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what} Smelt could not be reached.`);
      },
    [onSignedOut],
  );

  const load = useCallback((): void => {
    const read = ++reads.current;
    listGrants().then((answer) => {
      setGrants(answer.grants);
      setOfferAfter(answer.offerStandingAfter);
    }, failed("The standing permissions could not be read."));
    getActionLog(PAGE).then((page) => read === reads.current && setLog(page), failed("The action log could not be read."));
  }, [failed]);

  useEffect(load, [load]);

  const loadOlder = (): void => {
    const oldest = log?.entries.at(-1);
    if (oldest === undefined) return;
    const read = reads.current;
    setBusy(true);
    getActionLog(PAGE, oldest.id).then((page) => {
      setBusy(false);
      // The newest page was read again meanwhile: this older page no longer follows what is shown.
      if (read !== reads.current) return;
      setLog((have) => (have === null ? have : { entries: [...have.entries, ...page.entries], older: page.older }));
    }, failed("The older entries could not be read."));
  };

  const takeBack = (grant: StandingGrant): void => {
    setBusy(true);
    setProblem(null);
    revokeGrant(grant.id).then(() => {
      setBusy(false);
      load();
    }, (err: unknown) => {
      failed("The standing permission was not taken back.")(err);
      load();
    });
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-transcript flex-col">
      <Header current="trust" />
      <main className="flex flex-col gap-lg p-lg">
        <h1 className="font-semibold">Trust</h1>
        {problem !== null && (
          <p role="alert" className="break-words font-medium">
            {problem}
          </p>
        )}
        <section aria-labelledby="trust-grants" className="flex flex-col gap-sm">
          <h2 id="trust-grants" className="font-semibold">
            Standing permissions
          </h2>
          {grants === null ? (
            problem === null && (
              <p role="status" className="text-muted">
                Reading standing permissions.
              </p>
            )
          ) : grants.length === 0 ? (
            <p data-testid="grants-none" className="text-muted">
              {`No standing permissions.${offerAfter === null ? "" : ` After you have allowed the same command ${times(offerAfter)}, its card offers one.`}`}
            </p>
          ) : (
            <ul data-testid="grant-list" className="flex flex-col">
              {grants.map((grant) => (
                <li key={grant.id} className="flex flex-col gap-xs border-b py-md">
                  <code data-testid="grant-command" className="whitespace-pre-wrap break-all font-mono text-mono font-semibold">
                    {visible(grant.command)}
                  </code>
                  <span>{`Runs without asking for the ${grant.role}. ${directoryWords(grant.cwd)}, in this repository:`}</span>
                  <span className="break-all font-mono text-mono text-muted">{visible(grant.repo)}</span>
                  <span className="text-muted">
                    {`Given ${when(grant.grantedAt)}${grant.taskId === null ? "" : `, in task ${grant.taskId}`}. ${grant.lastUsedAt === null ? "Not used yet." : `Used ${times(grant.timesUsed)}, last ${when(grant.lastUsedAt)}.`}`}
                  </span>
                  <ConfirmAction label="Take back" confirmLabel="Take it back" cancelLabel="Keep it" disabled={busy} testId="take-back-confirm" onConfirm={() => takeBack(grant)}>
                    <p className="break-words">Take this standing permission back? The next time this command is asked for, Smelt asks you again.</p>
                  </ConfirmAction>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="trust-log" className="flex flex-col gap-sm">
          <h2 id="trust-log" className="font-semibold">
            Action log
          </h2>
          {log === null ? (
            problem === null && (
              <p role="status" className="text-muted">
                Reading the action log.
              </p>
            )
          ) : log.entries.length === 0 ? (
            <p data-testid="log-none" className="text-muted">
              Nothing has been asked, allowed or run yet.
            </p>
          ) : (
            <>
              <ul data-testid="action-log" className="flex flex-col">
                {log.entries.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-xs border-b py-sm">
                    <span className="font-medium">{RULE_WORDS[entry.rule] ?? entry.rule}</span>
                    <code className="whitespace-pre-wrap break-all font-mono text-mono">{visible(shorten(entry.command === "" ? entry.tool : entry.tool === "Bash" ? entry.command : `${entry.tool} ${entry.command}`))}</code>
                    {entry.detail !== null && <span className="break-words text-muted">{visible(entry.detail)}</span>}
                    <span className="font-mono text-mono text-muted">{`${entry.taskId === null ? "" : `Task ${entry.taskId} · `}${when(entry.ts)}`}</span>
                  </li>
                ))}
              </ul>
              {log.older && (
                <button type="button" disabled={busy} onClick={loadOlder} className="min-h-touch self-start rounded-sm border border-muted px-lg font-medium">
                  Load older
                </button>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
