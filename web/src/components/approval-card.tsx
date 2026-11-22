import { useContext, useEffect, useId, useRef, useState } from "react";
import { answerApproval, ApiError, type Approval } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";

/** The tray's last "open" a card has answered by taking the focus. Kept across screens, so one open moves the focus once. */
let focusedFor = 0;

/**
 * Text with the characters that cannot be seen, or that reorder what is read (direction overrides, zero-width
 * marks, control codes other than tab and newline), written out by code point, so the card reads as what would run.
 */
export function visible(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

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
    <p data-testid="approval-tray" role="status" className="flex min-h-touch items-center font-mono text-mono">
      {oldest === undefined ? (
        <span className="text-muted">{pending === null ? (problem ?? "Checking for approvals.") : "No approvals are waiting."}</span>
      ) : (
        <a href={`#/tasks/${oldest.taskId}`} onClick={open} className="flex min-h-touch flex-1 items-center rounded-sm bg-border px-md font-semibold underline underline-offset-xs">
          {pending!.length === 1 ? "1 approval is waiting. Open it." : `${pending!.length} approvals are waiting. Open the oldest.`}
        </a>
      )}
    </p>
  );
}

/**
 * One request waiting for the owner: what would run, where, for which role and
 * task, and the agent's reason when it gave one. Allow is the one primary
 * action. Decline is set apart below it, with an optional note for the agent.
 * `more` is how many further requests of the same task wait behind this one.
 */
export function ApprovalCard({ approval, more, onSignedOut }: { approval: Approval; more: number; onSignedOut: () => void }) {
  const { refresh, opened } = useContext(ApprovalsContext);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
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

  const send = (decision: "allow" | "decline"): void => {
    setSending(true);
    setProblem(null);
    answerApproval(approval.id, decision, decision === "decline" ? note : undefined).then(
      // The card goes when the list no longer has the request.
      () => refresh(),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setSending(false);
        setProblem(err instanceof ApiError ? `Your answer was not taken. ${err.message}` : "Your answer was not sent: Smelt could not be reached. Nothing was allowed.");
        refresh();
      },
    );
  };

  return (
    <section ref={card} tabIndex={-1} data-testid="approval-card" aria-labelledby={heading} className="flex flex-col gap-md rounded-md border border-accent p-lg">
      <h2 id={heading} className="font-semibold">
        {approval.tool === "Bash" ? "Claude Code asks to run a command" : `Claude Code asks to use ${approval.tool}`}
      </h2>
      <pre data-testid="approval-command" className="whitespace-pre-wrap break-all rounded-sm bg-border p-md font-mono text-mono">
        {visible(approval.command)}
      </pre>
      <dl className="flex flex-col gap-xs">
        <div className="flex gap-sm">
          <dt className="shrink-0 text-muted">Directory</dt>
          <dd data-testid="approval-directory" className="min-w-0 break-all">
            {directoryWords(approval.cwd)}
          </dd>
        </div>
        <div className="flex gap-sm">
          <dt className="shrink-0 text-muted">Role</dt>
          <dd data-testid="approval-role">{approval.role}</dd>
        </div>
        <div className="flex gap-sm">
          <dt className="shrink-0 text-muted">Task</dt>
          <dd data-testid="approval-task" className="min-w-0 break-words">{`Task ${approval.taskId} · ${approval.taskTitle}`}</dd>
        </div>
        {approval.reason !== null && (
          <div className="flex gap-sm">
            <dt className="shrink-0 text-muted">Its reason</dt>
            <dd data-testid="approval-reason" className="min-w-0 whitespace-pre-wrap break-words">
              {visible(approval.reason)}
            </dd>
          </div>
        )}
      </dl>
      {more > 0 && <p className="text-muted">{more === 1 ? "1 more request of this task waits behind this one." : `${more} more requests of this task wait behind this one.`}</p>}
      {problem !== null && (
        <p role="alert" className="break-words font-medium">
          {problem}
        </p>
      )}
      <button type="button" disabled={sending || !settled} onClick={() => send("allow")} className="min-h-touch rounded-sm border border-accent bg-accent px-lg font-medium uppercase tracking-wide text-surface">
        Allow
      </button>
      <div className="mt-xl flex flex-col gap-sm border-t pt-lg">
        <label htmlFor={noteField} className="font-mono text-mono text-muted">
          Note to the agent if you decline (optional)
        </label>
        <input id={noteField} type="text" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="min-h-touch rounded-sm border bg-surface px-md" />
        <button type="button" disabled={sending || !settled} onClick={() => send("decline")} className="min-h-touch self-start rounded-sm border border-muted px-lg font-medium">
          Decline
        </button>
      </div>
    </section>
  );
}
