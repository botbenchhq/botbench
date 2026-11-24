import { useEffect, useId, useRef, useState } from "react";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { acceptTask, ApiError, rejectTask, runChecksAgain, type EvidenceState, type TaskDecision } from "../api/client.ts";
import { Alert } from "./header.tsx";
import { ConfirmAction } from "./confirm.tsx";
import { Icon } from "./icon.tsx";
import { number, plural } from "../app/format.ts";

/** Put `value` on the clipboard; resolves with whether it was, in words. */
export function copyWords(value: string, refused = "Not copied: this browser refused. Select the text to copy it."): Promise<string> {
  // The clipboard is only there on a secure page (HTTPS, or this Mac itself) and may still refuse.
  const written = navigator.clipboard === undefined ? Promise.reject(new Error("no clipboard")) : navigator.clipboard.writeText(value);
  return written.then(
    () => "Copied.",
    () => refused,
  );
}

/** Put `value` on the clipboard, and say in words whether it was. */
function useCopy(value: string): { copied: string | null; copy: () => void } {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (): void => void copyWords(value).then(setCopied);
  return { copied, copy };
}

/**
 * A task's branch: its name as text, whole and wrapping at any width, with the button that copies it beside it (the
 * design system's copy button). A branch name is somebody's words only in part, so it is marked as content.
 */
export function BranchCopy({ branch }: { branch: string }) {
  const { copied, copy } = useCopy(branch);
  return (
    <dl className="ds-key-value">
      <div className="ds-key-value__item">
        <dt className="ds-key-value__label">Branch</dt>
        <dd className="ds-key-value__value ds-key-value__value--mono">
          <span className="ds-cluster ds-gap-xs">
            <code data-testid="branch" data-ds-content="">
              {branch}
            </code>
            <span className="ds-copy-button">
              <button type="button" aria-label="Copy branch name" onClick={copy} className="ds-button ds-button--quiet ds-button--small">
                <Icon name="copy" className="ds-button__icon" />
                Copy
              </button>
              <span data-testid="branch-copy-state" role="status" className="ds-copy-button__status">
                {copied}
              </span>
            </span>
          </span>
        </dd>
      </div>
    </dl>
  );
}

/** A value the owner copies as it is: a command. A read-only field and a button that copies it. */
export function CopyField({ label, value, testId, buttonName }: { label: string; value: string; testId: string; buttonName: string }) {
  const id = useId();
  const { copied, copy } = useCopy(value);
  return (
    <div className="ds-field">
      <label htmlFor={id} className="ds-field__label">
        {label}
      </label>
      <div className="ds-copy-field">
        <input id={id} data-testid={testId} type="text" readOnly value={value} className="ds-copy-field__value basis-full" />
        <button type="button" aria-label={buttonName} onClick={copy} className="ds-button">
          <Icon name="copy" className="ds-button__icon" />
          Copy
        </button>
        <p data-testid={`${testId}-copy-state`} role="status" className="ds-copy-field__status">
          {copied}
        </p>
      </div>
    </div>
  );
}

/** Files in the task's copy that are not on its branch, each by its path: those the checks left, or those a discard removes. */
export function Leftovers({ files }: { files: readonly string[] }) {
  return (
    <ul data-testid="leftovers" className="ds-list ds-list--dense">
      {files.map((file) => (
        <li key={file} className="ds-list__row">
          <div className="ds-list__content">
            <span className="ds-list__body">
              <code data-ds-content="" className="ds-list__primary">
                {file}
              </code>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

const LEFT_BEHIND = "These files were left by the checks and are not on the branch:";

/** The words for the no-checks accept, one place: it is never called plain Accept. */
const ACCEPT_UNVERIFIED = "Accept without verification";

/**
 * The state of a task's evidence, in the server's own words (`EvidenceState.words`): whether its checks are about the
 * commit Accept would keep, the files of a copy that differs from it, what git ignores there, and, apart, the commit
 * the review read. Nothing here is worked out by the client. `evidence` null: the server could not read it, and says why.
 */
export function EvidenceLines({ evidence, problem }: { evidence: EvidenceState | null; problem: string | null }) {
  if (evidence === null) return problem === null ? null : <span data-testid="evidence-problem">{problem}</span>;
  return (
    <>
      <span data-testid="evidence-words" data-evidence={evidence.state}>
        {evidence.words}
      </span>
      {evidence.ignoredWords !== null && (
        <span data-testid="evidence-ignored" data-ds-content="" className="ds-review-decision__caveat">
          {evidence.ignoredWords}
        </span>
      )}
      {evidence.review !== null && !evidence.review.current && (
        <span data-testid="evidence-review" className="ds-review-decision__caveat">
          {evidence.review.words}
        </span>
      )}
    </>
  );
}

/**
 * Accept and Reject, for a task that is ready for review. Which Accept there is comes from the server's state of the
 * task's evidence (`evidence`), never from the client: plain Accept while the checks are about the commit it keeps;
 * "Accept without verification", not drawn as the primary action, when no checks ran; and none at all while the checks
 * are out of date (Run checks again is offered in its place) or the task's copy differs from the commit. Accept keeps
 * the branch and removes the task's copy. Reject always asks, asks whether to keep the branch, and lists the files it
 * would remove with the copy.
 * `primary` is for the task's own screen, inside its review decision: Accept is the view's one primary action, both
 * buttons are marked critical, and a short note may go with either, stored on the decision and shown in Activity.
 * Otherwise this is a row of a list, whose buttons are plain and where `name` finishes each button's accessible name.
 * While a decision is sent the pressed button is busy and keeps focus, and the other is disabled. `onSending` is told
 * true as it is pressed and false if it fails, and the pressed button stays busy until the screen shows the result in its place.
 */
export function DecisionControls({ taskId, leftovers, evidence, evidenceProblem = null, primary, name, onDecided, onSending, onSignedOut }: { taskId: number; leftovers: readonly string[] | null; evidence: EvidenceState | null; evidenceProblem?: string | null; primary: boolean; name?: string; onDecided: () => void; onSending?: (sending: boolean) => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState<"accept" | "reject" | "checks" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [branch, setBranch] = useState<"keep" | "discard">("keep");
  const [note, setNote] = useState("");
  const radio = useId();
  const noteId = useId();
  const left = leftovers ?? [];

  const send = (what: "accept" | "reject"): void => {
    if (busy !== null) return;
    setBusy(what);
    setProblem(null);
    // Told before it is sent: a refresh from elsewhere may show the decision before this request answers.
    onSending?.(true);
    // For a reject, the owner confirmed exactly the files this screen showed; the server refuses, and lists them again, if
    // they changed since. An accept says only whether it is made without verification; the server decides if it may be.
    const given = note.trim() === "" ? null : note.trim();
    const sent = what === "accept" ? acceptTask(taskId, unverified, given) : rejectTask(taskId, branch, left, given);
    sent.then(
      () => onDecided(),
      (err: unknown) => {
        setBusy(null);
        onSending?.(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`${what === "accept" ? "The task was not accepted." : "The task was not rejected."} ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
        // The task may have moved on, or more files may have appeared: show what is so now.
        onDecided();
      },
    );
  };

  // Run checks again stays busy until the server's next word on the evidence arrives: the task at its checks (this
  // goes with the buttons), or, when they were quick, ready for review again with a state read anew.
  const asking = useRef(false);
  useEffect(() => {
    if (!asking.current) setBusy((now) => (now === "checks" ? null : now));
  }, [evidence]);

  const again = (): void => {
    if (busy !== null) return;
    setBusy("checks");
    setProblem(null);
    asking.current = true;
    runChecksAgain(taskId).then(
      () => {
        asking.current = false;
        onDecided();
      },
      (err: unknown) => {
        asking.current = false;
        setBusy(null);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The checks were not started. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
        onDecided();
      },
    );
  };

  // Which Accept, from the server's state alone.
  const offered = evidence?.state === "current" ? "accept" : evidence?.state === "none" ? "unverified" : null;
  const unverified = offered === "unverified";
  const acceptLabel = busy === "accept" ? "Accepting" : unverified ? ACCEPT_UNVERIFIED : "Accept";
  const rejectLabel = busy === "reject" ? "Rejecting" : "Reject";
  const opener = name === undefined ? undefined : { small: false, name: `${acceptLabel} ${name}` };
  // On a row of a list the state is said here; on the task's own screen the decision's evidence line says it.
  // When the server could not read the evidence, its reason for there being no Accept is said instead.
  const why = primary || offered === "accept" ? null : evidence === null ? evidenceProblem : evidence.words;
  return (
    <div className="ds-stack ds-gap-sm">
      {primary && (
        <div className="ds-field">
          <label htmlFor={noteId} className="ds-field__label">
            Note (optional)
          </label>
          <input id={noteId} data-testid="decision-note" type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby={`${noteId}-about`} className="ds-field__control" />
          <p id={`${noteId}-about`} className="ds-field__description">
            A short reason, kept with your Accept or Reject and shown in Activity.
          </p>
        </div>
      )}
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      {why !== null && <p data-testid="evidence-words">{why}</p>}
      <div className={primary ? "ds-review-decision__actions" : "ds-cluster"}>
        {offered !== null && (
          // Without verification it is not the view's primary action, and is not drawn as one.
          <button type="button" data-testid="accept" aria-busy={busy === "accept" || undefined} disabled={busy === "reject"} data-ds-critical={primary ? "" : undefined} aria-label={opener?.name} onClick={() => send("accept")} className={primary && !unverified ? "ds-button ds-button--primary" : "ds-button"}>
            {acceptLabel}
          </button>
        )}
        {evidence?.state === "stale" && evidence.canRunAgain && (
          <BusyButton data-testid="run-checks-again" busy={busy === "checks"} busyLabel="Starting the checks" disabled={busy === "reject"} {...(name === undefined ? {} : { "aria-label": `${busy === "checks" ? "Starting the checks" : "Run checks again"} for ${name}` })} onClick={again}>
            Run checks again
          </BusyButton>
        )}
        <ConfirmAction label={rejectLabel} {...(name === undefined ? {} : { opener: { small: false, name: `${rejectLabel} ${name}` } })} critical={primary} title="Reject this task?" confirmLabel="Reject" cancelLabel="Cancel" disabled={busy === "accept" || busy === "checks"} busy={busy === "reject"} losing testId="reject" onConfirm={() => send("reject")}>
          <fieldset className="ds-radio__group">
            <legend className="ds-radio__legend">What becomes of the branch?</legend>
            <div className="ds-radio">
              <input className="ds-radio__input" type="radio" id={`${radio}-keep`} name={`${radio}-branch`} value="keep" checked={branch === "keep"} onChange={() => setBranch("keep")} aria-describedby={`${radio}-keep-about`} />
              <label className="ds-radio__label" htmlFor={`${radio}-keep`}>
                Keep the branch
              </label>
              <p className="ds-radio__description" id={`${radio}-keep-about`}>
                The work stays in the repository on its branch, for you to merge or delete later.
              </p>
            </div>
            <div className="ds-radio">
              <input className="ds-radio__input" type="radio" id={`${radio}-discard`} name={`${radio}-branch`} value="discard" checked={branch === "discard"} onChange={() => setBranch("discard")} aria-describedby={`${radio}-discard-about`} />
              <label className="ds-radio__label" htmlFor={`${radio}-discard`}>
                Delete the branch
              </label>
              <p className="ds-radio__description" id={`${radio}-discard-about`}>
                The work on it is gone for good.
              </p>
            </div>
          </fieldset>
          {left.length > 0 && (
            <>
              <p>{LEFT_BEHIND}</p>
              <Leftovers files={left} />
            </>
          )}
          <p>Either way, the task's copy of the project is removed{left.length > 0 ? ", with these files" : ""}. Nothing is merged or pushed.</p>
        </ConfirmAction>
      </div>
    </div>
  );
}

/**
 * What the owner has once a task is decided. Accepted: the branch and, when `merge` (its run keeps branches rather than
 * opening pull requests), the command that merges it. Rejected with the branch kept: the branch, to look at or delete.
 * Rejected with the branch deleted: that it is gone. `compact` is for a row of a run, whose screen already names the
 * repository and says what was merged or pushed.
 */
export function DecisionOutcome({ decision, repo, merge, compact = false, pushed = null }: { decision: TaskDecision; repo: string; merge: boolean; compact?: boolean; pushed?: string | null }) {
  const noted = decision.note === null ? null : (
    <p data-testid="decision-note-shown">
      {"Your note: "}
      <span data-ds-content="">{decision.note}</span>
    </p>
  );
  const removed = decision.leftovers.length === 0 ? null : `The ${plural(decision.leftovers.length, "file", `${number(decision.leftovers.length)} files`)} the checks left ${plural(decision.leftovers.length, "was", "were")} removed with the task's copy: ${decision.leftovers.join(", ")}.`;
  if (compact) {
    if (decision.decision !== "accept" || !merge) return noted;
    return (
      <>
        {noted}
        <CopyField label="Merge command, to run in the repository" value={`git merge ${decision.branchName}`} testId="merge-command" buttonName="Copy merge command" />
      </>
    );
  }
  if (decision.branch === "deleted") {
    return (
      <div className="ds-stack ds-gap-sm">
        {noted}
        <p data-testid="not-merged">Nothing has been merged or pushed. The branch and the task's copy of the project are gone.</p>
        {removed !== null && <p data-ds-content="">{removed}</p>}
      </div>
    );
  }
  return (
    <div className="ds-stack ds-gap-sm">
      {noted}
      <BranchCopy branch={decision.branchName} />
      {decision.decision === "accept" ? (
        <>
          {merge && (
            <>
              <p>
                {"To bring the work into your own files, run this in the repository at "}
                <code data-testid="decision-repo" data-ds-content="">
                  {repo}
                </code>
                {", on the branch you want it in:"}
              </p>
              <CopyField label="Merge command" value={`git merge ${decision.branchName}`} testId="merge-command" buttonName="Copy merge command" />
            </>
          )}
          <p data-testid="not-merged">{pushed === null ? "Nothing has been merged or pushed. The branch stays in the repository until you merge or delete it." : `Nothing has been merged. The branch was pushed to ${pushed} for its pull request, and stays in the repository until you merge or delete it.`}</p>
        </>
      ) : (
        <p data-testid="not-merged">Nothing has been merged or pushed. The branch stays in the repository for you to look at, and to delete when you no longer want it.</p>
      )}
      {removed !== null && <p data-ds-content="">{removed}</p>}
    </div>
  );
}
