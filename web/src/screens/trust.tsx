import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getActionLog, listGrants, revokeGrant, type LogEntry, type LogRule, type StandingGrant } from "../api/client.ts";
import { times, visible } from "../components/approval-card.tsx";
import { ConfirmAction } from "../components/confirm.tsx";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";

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
  /** Whether it is the older log entries that are being read. */
  const [readingOlder, setReadingOlder] = useState(false);
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
    setReadingOlder(true);
    getActionLog(PAGE, oldest.id).then((page) => {
      setBusy(false);
      setReadingOlder(false);
      // The newest page was read again meanwhile: this older page no longer follows what is shown.
      if (read !== reads.current) return;
      setLog((have) => (have === null ? have : { entries: [...have.entries, ...page.entries], older: page.older }));
    }, (err: unknown) => {
      setReadingOlder(false);
      failed("The older entries could not be read.")(err);
    });
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
    <Frame current="trust">
      <Page>
        <PageHeader title="Trust" />
        {problem !== null && (
          <Alert tone="error" role="alert">
            {problem}
          </Alert>
        )}
        <section aria-labelledby="trust-grants" className="gw-stack gw-gap-sm">
          <h2 id="trust-grants">Standing permissions</h2>
          {grants === null ? (
            problem === null && (
              <p role="status" className="gw-spinner">
                Reading standing permissions.
              </p>
            )
          ) : grants.length === 0 ? (
            <p data-testid="grants-none">{`No standing permissions.${offerAfter === null ? "" : ` After you have allowed the same command ${times(offerAfter)}, its card offers one.`}`}</p>
          ) : (
            <ul data-testid="grant-list" className="gw-list">
              {grants.map((grant) => (
                <li key={grant.id} className="gw-list__row">
                  <div className="gw-list__content">
                    <span className="gw-list__body">
                      <code data-testid="grant-command" className="gw-list__primary">
                        {visible(grant.command)}
                      </code>
                      <span className="gw-list__secondary">
                        {`Runs without asking for the ${grant.role}. ${directoryWords(grant.cwd)}, in this repository: `}
                        <code>{visible(grant.repo)}</code>
                      </span>
                      <span className="gw-list__secondary">
                        {`Given ${when(grant.grantedAt)}${grant.taskId === null ? "" : `, in task ${grant.taskId}`}. ${grant.lastUsedAt === null ? "Not used yet." : `Used ${times(grant.timesUsed)}, last ${when(grant.lastUsedAt)}.`}`}
                      </span>
                    </span>
                  </div>
                  <div className="gw-list__action">
                    <ConfirmAction
                      label="Take back"
                      opener={{ small: true, name: `Take back ${visible(grant.command)}` }}
                      title="Take this standing permission back?"
                      confirmLabel="Take it back"
                      cancelLabel="Keep it"
                      disabled={busy}
                      losing
                      testId="take-back-confirm"
                      onConfirm={() => takeBack(grant)}
                    >
                      <p>The next time this command is asked for, Smelt asks you again.</p>
                      <ul className="gw-confirm-dialog__losses">
                        <li className="gw-confirm-dialog__loss">
                          <code>{visible(grant.command)}</code>
                        </li>
                      </ul>
                    </ConfirmAction>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="trust-log" className="gw-stack gw-gap-sm">
          <h2 id="trust-log">Action log</h2>
          {log === null ? (
            problem === null && (
              <p role="status" className="gw-spinner">
                Reading the action log.
              </p>
            )
          ) : log.entries.length === 0 ? (
            <p data-testid="log-none">Nothing has been asked, allowed or run yet.</p>
          ) : (
            <div className="gw-show-more">
              <ul data-testid="action-log" className="gw-list gw-list--dense">
                {log.entries.map((entry) => (
                  <li key={entry.id} className="gw-list__row">
                    <div className="gw-list__content">
                      <span className="gw-list__body">
                        <span className="gw-list__primary">{RULE_WORDS[entry.rule] ?? entry.rule}</span>
                        <code className="gw-list__secondary">{visible(shorten(entry.command === "" ? entry.tool : entry.tool === "Bash" ? entry.command : `${entry.tool} ${entry.command}`))}</code>
                        {entry.detail !== null && <span className="gw-list__secondary">{visible(entry.detail)}</span>}
                        <span className="gw-list__secondary">{`${entry.taskId === null ? "" : `Task ${entry.taskId} · `}${when(entry.ts)}`}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {log.older && (
                <button type="button" disabled={busy} aria-busy={readingOlder} onClick={loadOlder} className="gw-button gw-button--quiet gw-show-more__all">
                  Load older
                </button>
              )}
            </div>
          )}
        </section>
      </Page>
    </Frame>
  );
}
