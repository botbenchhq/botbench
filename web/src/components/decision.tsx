import { useId, useState } from "react";
import { acceptTask, ApiError, rejectTask, type TaskDecision } from "../api/client.ts";
import { Alert } from "./header.tsx";
import { ConfirmAction } from "./confirm.tsx";
import { Icon } from "./icon.tsx";

/** A value the owner copies as it is: a branch name, a command. A read-only field and a button that copies it. */
export function CopyField({ label, value, testId, buttonName }: { label: string; value: string; testId: string; buttonName: string }) {
  const id = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (): void => {
    // The clipboard is only there on a secure page (HTTPS, or this Mac itself) and may still refuse.
    const written = navigator.clipboard === undefined ? Promise.reject(new Error("no clipboard")) : navigator.clipboard.writeText(value);
    written.then(
      () => setCopied("Copied."),
      () => setCopied("Not copied: this browser refused. Select the text to copy it."),
    );
  };
  return (
    <div className="gw-field">
      <label htmlFor={id} className="gw-field__label">
        {label}
      </label>
      <div className="gw-copy-field">
        <input id={id} data-testid={testId} type="text" readOnly value={value} className="gw-copy-field__value basis-full" />
        <button type="button" aria-label={buttonName} onClick={copy} className="gw-button">
          <Icon name="copy" className="gw-button__icon" />
          Copy
        </button>
        <p data-testid={`${testId}-copy-state`} role="status" className="gw-copy-field__status">
          {copied}
        </p>
      </div>
    </div>
  );
}

/** The files the checks left in the task's copy, each by its path. */
function Leftovers({ files }: { files: readonly string[] }) {
  return (
    <ul data-testid="leftovers" className="gw-list gw-list--dense">
      {files.map((file) => (
        <li key={file} className="gw-list__row">
          <div className="gw-list__content">
            <span className="gw-list__body">
              <code data-gw-content="" className="gw-list__primary">
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

/**
 * Accept and Reject, for a task that is ready for review. Accept keeps the branch and removes the task's copy; when the
 * checks left files in the copy it asks first, naming them. Reject always asks, and asks whether to keep the branch.
 * `primary` draws Accept as the view's one primary action: on the task's own screen, not on a row of a list.
 * `name` finishes each button's accessible name on a list, where there is one pair for each task.
 */
export function DecisionControls({ taskId, leftovers, primary, name, onDecided, onSignedOut }: { taskId: number; leftovers: readonly string[] | null; primary: boolean; name?: string; onDecided: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [branch, setBranch] = useState<"keep" | "discard">("keep");
  const radio = useId();
  const left = leftovers ?? [];

  const send = (what: "accept" | "reject"): void => {
    if (busy !== null) return;
    setBusy(what);
    setProblem(null);
    // The owner confirmed exactly the files this screen showed; the server refuses, and lists them again, if they changed since.
    const sent = what === "accept" ? acceptTask(taskId, left) : rejectTask(taskId, branch, left);
    sent.then(
      () => {
        setBusy(null);
        onDecided();
      },
      (err: unknown) => {
        setBusy(null);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`${what === "accept" ? "The task was not accepted." : "The task was not rejected."} ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
        // The task may have moved on, or more files may have appeared: show what is so now.
        onDecided();
      },
    );
  };

  const acceptLabel = busy === "accept" ? "Accepting" : "Accept";
  const opener = name === undefined ? undefined : { small: false, name: `${acceptLabel} ${name}` };
  return (
    <div className="gw-stack gw-gap-sm">
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      <div className="gw-cluster">
        {left.length === 0 ? (
          <button type="button" aria-busy={busy === "accept"} disabled={busy !== null} aria-label={opener?.name} onClick={() => send("accept")} className={primary ? "gw-button gw-button--primary" : "gw-button"}>
            {acceptLabel}
          </button>
        ) : (
          <ConfirmAction label={acceptLabel} {...(opener ? { opener } : {})} primary={primary} title="Accept this task?" confirmLabel="Accept and remove them" cancelLabel="Keep the copy" disabled={busy !== null} losing testId="accept-leftovers" onConfirm={() => send("accept")}>
            <p>{LEFT_BEHIND}</p>
            <Leftovers files={left} />
            <p>Accepting keeps the branch and removes the task's copy of the project, and these files with it. Copy out any you want to keep first.</p>
          </ConfirmAction>
        )}
        <ConfirmAction label={busy === "reject" ? "Rejecting" : "Reject"} {...(name === undefined ? {} : { opener: { small: false, name: `${busy === "reject" ? "Rejecting" : "Reject"} ${name}` } })} title="Reject this task?" confirmLabel="Reject" cancelLabel="Cancel" disabled={busy !== null} losing testId="reject" onConfirm={() => send("reject")}>
          <fieldset className="gw-radio__group">
            <legend className="gw-radio__legend">What becomes of the branch?</legend>
            <div className="gw-radio">
              <input className="gw-radio__input" type="radio" id={`${radio}-keep`} name={`${radio}-branch`} value="keep" checked={branch === "keep"} onChange={() => setBranch("keep")} aria-describedby={`${radio}-keep-about`} />
              <label className="gw-radio__label" htmlFor={`${radio}-keep`}>
                Keep the branch
              </label>
              <p className="gw-radio__description" id={`${radio}-keep-about`}>
                The work stays in the repository on its branch, for you to merge or delete later.
              </p>
            </div>
            <div className="gw-radio">
              <input className="gw-radio__input" type="radio" id={`${radio}-discard`} name={`${radio}-branch`} value="discard" checked={branch === "discard"} onChange={() => setBranch("discard")} aria-describedby={`${radio}-discard-about`} />
              <label className="gw-radio__label" htmlFor={`${radio}-discard`}>
                Delete the branch
              </label>
              <p className="gw-radio__description" id={`${radio}-discard-about`}>
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
 * What the owner has once a task is decided. Accepted: the branch and the command that merges it. Rejected with the
 * branch kept: the branch, to look at or delete. Rejected with the branch deleted: that it is gone. `compact` is for a
 * row of a run, whose screen already names the repository and says nothing was merged or pushed.
 */
export function DecisionOutcome({ decision, repo, compact = false }: { decision: TaskDecision; repo: string; compact?: boolean }) {
  const removed = decision.leftovers.length === 0 ? null : `The ${decision.leftovers.length === 1 ? "file" : `${decision.leftovers.length} files`} the checks left ${decision.leftovers.length === 1 ? "was" : "were"} removed with the task's copy: ${decision.leftovers.join(", ")}.`;
  if (compact) {
    if (decision.decision !== "accept") return null;
    return <CopyField label="Merge command, to run in the repository" value={`git merge ${decision.branchName}`} testId="merge-command" buttonName="Copy merge command" />;
  }
  if (decision.branch === "deleted") {
    return (
      <div className="gw-stack gw-gap-sm">
        <p data-testid="not-merged">Nothing has been merged or pushed. The branch and the task's copy of the project are gone.</p>
        {removed !== null && <p data-gw-content="">{removed}</p>}
      </div>
    );
  }
  return (
    <div className="gw-stack gw-gap-sm">
      <CopyField label="Branch" value={decision.branchName} testId="branch" buttonName="Copy branch name" />
      {decision.decision === "accept" ? (
        <>
          <p>
            {"To bring the work into your own files, run this in the repository at "}
            <code data-testid="decision-repo" data-gw-content="">
              {repo}
            </code>
            {", on the branch you want it in:"}
          </p>
          <CopyField label="Merge command" value={`git merge ${decision.branchName}`} testId="merge-command" buttonName="Copy merge command" />
          <p data-testid="not-merged">Nothing has been merged or pushed. The branch stays in the repository until you merge or delete it.</p>
        </>
      ) : (
        <p data-testid="not-merged">Nothing has been merged or pushed. The branch stays in the repository for you to look at, and to delete when you no longer want it.</p>
      )}
      {removed !== null && <p data-gw-content="">{removed}</p>}
    </div>
  );
}
