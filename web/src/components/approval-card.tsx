import { useContext, useEffect, useId, useRef, useState } from "react";
import { answerApproval, ApiError, grantStanding, type Approval } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ConfirmAction } from "./confirm.tsx";

/** The tray's last "open" a card has answered by taking the focus. Kept across screens, so one open moves the focus once. */
let focusedFor = 0;

/**
 * Text with the characters that cannot be seen, or that reorder what is read (direction overrides, zero-width
 * marks, control codes other than tab and newline), written out by code point, so the card reads as what would run.
 */
export function visible(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/** A count as it is said: "once", "3 times". */
export const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

/** Where the agent stood, in words. The path is relative to the task's worktree. */
function directoryWords(cwd: string): string {
  if (cwd === ".") return "The top of the task's worktree";
  if (cwd === "") return "Not reported";
  return cwd === ".." || cwd.startsWith("../") ? `${cwd} (outside the task's worktree)` : `${cwd} (inside the task's worktree)`;
}

/**
 * The pending count, in words, on every signed-in screen. With something
 * waiting it is a link to the oldest request's task, where its card is.
 */
export function ApprovalTray() {
  const { pending, problem, open } = useContext(ApprovalsContext);
  const oldest = pending?.[0];
  return (
    <div data-testid="approval-tray" aria-live="polite" aria-atomic="true" className="gw-pending-tray">
      {oldest === undefined ? (
        <span className="gw-pending-tray__text">{pending === null ? (problem ?? "Checking for approvals.") : "No approvals are waiting."}</span>
      ) : (
        <a href={oldest.taskId === null ? `#/runs/${oldest.runId}` : `#/tasks/${oldest.taskId}`} onClick={open} className="gw-pending-tray__link">
          <span className="gw-pending-tray__count">{pending!.length}</span>
          {pending!.length === 1 ? " approval is waiting. Open it." : " approvals are waiting. Open the oldest."}
        </a>
      )}
    </div>
  );
}

/** One fact of a request: what it is, then its value. */
function Fact({ term, testId, children }: { term: string; testId: string; children: string }) {
  return (
    <li className="gw-approval__fact">
      <span className="gw-approval__term">{term}</span> <span data-testid={testId} className="gw-approval__value">{children}</span>
    </li>
  );
}

/**
 * One request waiting for the owner: what would run, where, for which role and
 * task, and the agent's reason when it gave one. A task's screen shows one card
 * at a time, so Allow is that view's one primary action; Decline sits at the far
 * end of the same row, and a note for the agent can go with it from the
 * disclosure below (a note that was typed is never dropped: either Decline sends it). `more` is how many further requests of the same task wait
 * behind this one. When the server says this command has been allowed often
 * enough, the card also offers standing permission, last: a secondary step that
 * states the grant's scope in a dialog and does nothing until it is confirmed.
 */
export function ApprovalCard({ approval, more, onSignedOut }: { approval: Approval; more: number; onSignedOut: () => void }) {
  const { refresh, opened } = useContext(ApprovalsContext);
  const [note, setNote] = useState("");
  /** The answer being sent, while it is. */
  const [sending, setSending] = useState<"allow" | "decline" | "grant" | null>(null);
  // A card that takes the place of one just answered must be read before it can be answered: a second tap
  // meant for the first card does nothing.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), 700);
    return () => window.clearTimeout(timer);
  }, []);
  const [problem, setProblem] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const heading = useId();
  const noteField = useId();

  useEffect(() => {
    if (opened <= focusedFor) return;
    focusedFor = opened;
    card.current?.focus();
    card.current?.scrollIntoView({ block: "nearest" });
  }, [opened]);

  const send = (decision: "allow" | "decline", withNote: boolean): void => {
    setSending(decision);
    setProblem(null);
    answerApproval(approval.id, decision, withNote ? note : undefined).then(
      // The card goes when the list no longer has the request.
      () => refresh(),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setSending(null);
        setProblem(err instanceof ApiError ? `Your answer was not taken. ${err.message}` : "Your answer was not sent: Smelt could not be reached. Nothing was allowed.");
        refresh();
      },
    );
  };

  const offer = approval.standingOffer;
  const grant = (): void => {
    setSending("grant");
    setProblem(null);
    grantStanding(approval.id).then(
      () => refresh(),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setSending(null);
        setProblem(err instanceof ApiError ? `Standing permission was not given, and nothing was allowed. ${err.message}` : "Standing permission was not given: Smelt could not be reached. Nothing was allowed.");
        refresh();
      },
    );
  };

  const waiting = sending !== null || !settled;

  return (
    <article ref={card} tabIndex={-1} data-testid="approval-card" data-approval-id={approval.id} aria-labelledby={heading} className="gw-approval">
      <h2 id={heading} className="gw-approval__title">
        {approval.tool === "Bash" ? "Claude Code asks to run a command" : `Claude Code asks to use ${approval.tool}`}
      </h2>
      <pre data-testid="approval-command" className="gw-approval__command">
        {visible(approval.command)}
      </pre>
      <ul className="gw-approval__facts">
        <Fact term="Directory" testId="approval-directory">
          {directoryWords(approval.cwd)}
        </Fact>
        <Fact term="Role" testId="approval-role">
          {approval.role}
        </Fact>
        <Fact term={approval.taskId === null ? "Run" : "Task"} testId="approval-task">{`${approval.taskId === null ? `Run ${approval.runId}` : `Task ${approval.taskId}`} · ${approval.taskTitle}`}</Fact>
        {approval.reason !== null && (
          <Fact term="Its reason" testId="approval-reason">
            {visible(approval.reason)}
          </Fact>
        )}
      </ul>
      {approval.parkedAt !== null && <p data-testid="approval-parked">Asked before Smelt restarted. Claude Code is stopped; your answer starts it again where it stood, and counts only if it asks for exactly this again.</p>}
      {more > 0 && <p>{more === 1 ? "1 more request of this task waits behind this one." : `${more} more requests of this task wait behind this one.`}</p>}
      {problem !== null && (
        <p role="alert" className="gw-approval__error">
          {problem}
        </p>
      )}
      <div className="gw-approval__actions">
        <button type="button" data-gw-critical="" disabled={waiting} aria-busy={sending === "allow"} onClick={() => send("allow", false)} className="gw-button gw-button--primary">
          {sending === "allow" ? "Allowing" : "Allow"}
        </button>
        <button type="button" data-gw-critical="" disabled={waiting} aria-busy={sending === "decline"} onClick={() => send("decline", note.trim() !== "")} className="gw-button">
          {sending === "decline" ? "Declining" : "Decline"}
        </button>
      </div>
      <details className="gw-approval__details">
        <summary className="gw-approval__summary">Decline with a note</summary>
        <div className="gw-approval__note">
          <div className="gw-field">
            <label htmlFor={noteField} className="gw-field__label">
              Note to the agent
            </label>
            <input id={noteField} type="text" name="note" autoComplete="off" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="gw-field__control" />
          </div>
          <div className="gw-cluster">
            <button type="button" disabled={waiting} onClick={() => send("decline", true)} className="gw-button">
              Decline and send note
            </button>
          </div>
        </div>
      </details>
      {offer !== undefined && (
        <div data-testid="standing-offer" className="gw-stack gw-gap-sm">
          <p>{`You have allowed this command ${times(offer.approvals)}.`}</p>
          <div className="gw-cluster">
            <ConfirmAction label="Stop asking for this command" title="Stop asking for this command?" confirmLabel="Give standing permission" cancelLabel="Cancel" disabled={waiting} testId="standing-confirm" onConfirm={grant}>
              <p>
                Standing permission: from now on Smelt will run exactly this command without asking you, each time this role asks for it from this directory in a task of this repository. A different argument still asks, and dangerous commands always ask. If the command runs a script or a test, it runs whatever those files hold at the time, with your account's rights. It allows this request too. You can take it back on the Trust screen.
              </p>
              <dl className="gw-key-value">
                <div className="gw-key-value__item">
                  <dt className="gw-key-value__label">Command</dt>
                  <dd data-testid="standing-command" className="gw-key-value__value gw-key-value__value--mono">
                    {visible(offer.command)}
                  </dd>
                </div>
                <div className="gw-key-value__item">
                  <dt className="gw-key-value__label">Repository</dt>
                  <dd data-testid="standing-repo" className="gw-key-value__value gw-key-value__value--mono">
                    {visible(offer.repo)}
                  </dd>
                </div>
                <div className="gw-key-value__item">
                  <dt className="gw-key-value__label">Directory</dt>
                  <dd data-testid="standing-directory" className="gw-key-value__value">
                    {directoryWords(offer.cwd)}
                  </dd>
                </div>
                <div className="gw-key-value__item">
                  <dt className="gw-key-value__label">Role</dt>
                  <dd data-testid="standing-role" className="gw-key-value__value">
                    {offer.role}
                  </dd>
                </div>
              </dl>
            </ConfirmAction>
          </div>
        </div>
      )}
    </article>
  );
}
