import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getActionLog, listGrants, revokeGrant, type LogEntry, type LogRule, type StandingGrant } from "../api/client.ts";
import { stepWord, times, visible } from "../components/approval-card.tsx";
import { ConfirmAction } from "../components/confirm.tsx";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";

/** How many log entries are read at a time. */
const PAGE = 10;

/** The rule that decided, in words. */
const RULE_WORDS: Record<LogRule, string> = {
  asked_owner: "Asked you",
  owner_allowed: "You allowed",
  owner_declined: "You denied",
  ended_unanswered: "Ended without your answer",
  auto_worktree_edit: "Edited a file in the task's copy, without asking",
  broker_failure_denied: "Botbench denied",
  stored_answer_applied: "Your answer from before a restart was used",
  stored_answer_discarded: "Your answer from before a restart was not used",
  preapproved: "Ran without asking: allowed for this task",
  standing: "Ran without asking: always allowed",
  standing_granted: "You chose Always allow",
  standing_revoked: "You took Always allow back",
  owner_accepted: "You accepted",
  owner_rejected: "You rejected",
  owner_discarded: "You discarded",
  mode_allowed: "Ran without asking: kept in the task's copy",
  mode_refused: "Refused without asking: fully autonomous",
  mode_accepted: "Accepted without you: fully autonomous",
  delivery: "Pull request",
  web_allowed: "Ran without asking: Web access is Allow",
  web_refused: "Refused without asking: Web access is Off",
  bookkeeping: "Ran without asking: Claude Code's own to-do list or tool loading",
  issue_claim: "Issue claim",
  sandboxed: "Ran without asking: kept by its own sandbox, as Codex and Grok cannot ask",
  memory: "Memory",
  owner_answered: "You answered Claude Code's question",
  question_unasked: "Not asked: fully autonomous, Claude Code chose itself",
};

const when = (ts: string): string => new Date(ts).toLocaleString();
/** An edit's entry holds the whole file it wrote; the list shows where each entry begins. */
const shorten = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}…` : text);
/** Where a standing permission applies, in words. The path is relative to the worktree of whichever task asks. */
const directoryWords = (cwd: string): string => (cwd === "." ? "The top folder of a task's copy" : `${cwd}, inside a task's copy`);

/**
 * What Botbench may do without asking, and what it did: the standing permissions in force, each with the control
 * that takes it back, and the action log, newest first.
 */
export function TrustScreen({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <Frame current={null} back={{ href: "#/settings", label: "Settings" }}>
      <Page>
        <PageHeader title="Permissions" />
        <Permissions onSignedOut={onSignedOut} />
      </Page>
    </Frame>
  );
}

/** What the Permissions screen holds below its title: on its own screen, and as the Permissions section of the two-pane Settings. */
export function Permissions({ onSignedOut }: { onSignedOut: () => void }) {
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
        setProblem(err instanceof ApiError ? `${what} ${err.message}` : `${what} Botbench could not be reached.`);
      },
    [onSignedOut],
  );

  const load = useCallback((): void => {
    const read = ++reads.current;
    listGrants().then((answer) => {
      setGrants(answer.grants);
      setOfferAfter(answer.offerStandingAfter);
    }, failed("The always-allowed commands could not be read."));
    getActionLog(PAGE).then((page) => read === reads.current && setLog(page), failed("The activity could not be read."));
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
      failed("Always allow was not taken back.")(err);
      load();
    });
  };

  return (
    <>
        {problem !== null && (
          <Alert tone="error" role="alert">
            {problem}
          </Alert>
        )}
        <section aria-labelledby="trust-grants" className="ds-stack ds-gap-sm">
          <h2 id="trust-grants">Always allowed</h2>
          {grants === null ? (
            problem === null && (
              <p role="status" className="ds-spinner">
                Reading what is always allowed.
              </p>
            )
          ) : grants.length === 0 ? (
            <p data-testid="grants-none">{`Nothing is always allowed.${offerAfter === null ? "" : ` After you have allowed the same command ${times(offerAfter)}, its request offers Always allow.`}`}</p>
          ) : (
            <ul data-testid="grant-list" className="ds-list">
              {grants.map((grant) => (
                <li key={grant.id} className="ds-list__row">
                  <div className="ds-list__content">
                    <span className="ds-list__body">
                      <code data-testid="grant-command" data-ds-content="" className="ds-list__primary">
                        {visible(grant.command)}
                      </code>
                      <span className="ds-list__secondary">
                        {`Claude Code runs this without asking you during the ${stepWord(grant.role)} step. ${directoryWords(grant.cwd)}, in this repository: `}
                        <code data-ds-content="">{visible(grant.repo)}</code>
                      </span>
                      <span className="ds-list__secondary">
                        {`Chosen ${when(grant.grantedAt)}${grant.taskId === null ? "" : `, in task ${grant.taskId}`}. ${grant.lastUsedAt === null ? "Not used yet." : `Used ${times(grant.timesUsed)}, last ${when(grant.lastUsedAt)}.`}`}
                      </span>
                    </span>
                  </div>
                  <div className="ds-list__action">
                    <ConfirmAction
                      label="Take back"
                      opener={{ small: true, name: `Take back ${visible(grant.command)}` }}
                      title="Stop always allowing this command?"
                      confirmLabel="Take it back"
                      cancelLabel="Keep it"
                      disabled={busy}
                      losing
                      testId="take-back-confirm"
                      onConfirm={() => takeBack(grant)}
                    >
                      <p>The next time this command is asked for, Botbench asks you again.</p>
                      <ul className="ds-confirm-dialog__losses">
                        <li className="ds-confirm-dialog__loss">
                          <code data-ds-content="">{visible(grant.command)}</code>
                        </li>
                      </ul>
                    </ConfirmAction>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="trust-log" className="ds-stack ds-gap-sm">
          <h2 id="trust-log">Activity</h2>
          {log === null ? (
            problem === null && (
              <p role="status" className="ds-spinner">
                Reading the activity.
              </p>
            )
          ) : log.entries.length === 0 ? (
            <p data-testid="log-none">Nothing has been asked, allowed or run yet.</p>
          ) : (
            <div className="ds-show-more">
              <p>Newest first.</p>
              <ul data-testid="action-log" className="ds-list ds-list--dense">
                {log.entries.map((entry) => (
                  <li key={entry.id} className="ds-list__row">
                    <div className="ds-list__content">
                      <span className="ds-list__body">
                        <span className="ds-list__primary">{RULE_WORDS[entry.rule] ?? entry.rule}</span>
                        <code data-ds-content="" className="ds-list__secondary">{visible(shorten(entry.command === "" ? entry.tool : entry.tool === "Bash" || entry.rule === "owner_accepted" || entry.rule === "owner_rejected" || entry.rule === "owner_discarded" || entry.rule === "mode_accepted" || entry.rule === "delivery" || entry.rule === "issue_claim" || entry.rule === "memory" ? entry.command : `${entry.tool} ${entry.command}`))}</code>
                        {/* The server's own sentence, which may hold the command it is about; its wording is checked where it is built. */}
                        {entry.detail !== null && (
                          <span data-ds-content="" className="ds-list__secondary">
                            {visible(entry.detail)}
                          </span>
                        )}
                        <span className="ds-list__secondary">{`${entry.taskId === null ? "" : `Task ${entry.taskId} · `}${when(entry.ts)}`}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {log.older && (
                <button type="button" disabled={busy} aria-busy={readingOlder} onClick={loadOlder} className="ds-button ds-button--quiet ds-show-more__all">
                  Show older activity
                </button>
              )}
            </div>
          )}
        </section>
    </>
  );
}
