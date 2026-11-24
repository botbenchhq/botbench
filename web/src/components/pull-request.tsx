import { useState } from "react";
import { ApiError, openPullRequest, type PullRequestTarget, type PullRequestView } from "../api/client.ts";
import { ConfirmAction } from "./confirm.tsx";
import { Alert } from "./alert.tsx";
import { Icon } from "./icon.tsx";

/** A pull request's link: it opens GitHub in a new tab. */
export function PullRequestLink({ view }: { view: PullRequestView }) {
  if (view.url === null || view.number === null) return null;
  return (
    <a data-testid="pull-request-link" className="ds-link" href={view.url} target="_blank" rel="noopener noreferrer">
      {`Pull request #${view.number} on GitHub`}
      <Icon name="external-link" className="ds-link__icon" />
      <span className="ds-link__hint">(opens in a new tab)</span>
    </a>
  );
}

/** Where a task's pull request stands, in one sentence. */
export function pullRequestWords(view: PullRequestView): string | null {
  if (view.state === "opened") return view.adopted ? `Pull request #${view.number} was already there for this branch${view.prState === null ? "" : ` (${view.prState.toLowerCase()})`}, so Botbench opened no second one. Nothing was merged.` : `The branch is on ${view.remote ?? "the remote"}, and Botbench opened pull request #${view.number}${view.base === null ? "" : ` into ${view.base}`}. Nothing was merged.`;
  if (view.state === "sending") return "Botbench is pushing the branch and opening the pull request.";
  if (view.state === "failed") return `The pull request was not opened. ${view.problem ?? ""} The task is still accepted and its branch is kept.`;
  return null;
}

/**
 * A task's pull request, on its own screen: the state in words with the link, and for an accepted task with a kept
 * branch and none open yet, Open a pull request (or Try again), which first states the remote and branch.
 */
export function PullRequestSection({ taskId, view, target, onChanged, onSignedOut }: { taskId: number; view: PullRequestView; target: PullRequestTarget | null; onChanged: () => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const said = pullRequestWords(view);
  if (said === null && target === null) return null;
  const send = (to: PullRequestTarget): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    openPullRequest(taskId, to).then(
      () => {
        setBusy(false);
        onChanged();
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem(`The pull request was not opened. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
        onChanged();
      },
    );
  };
  return (
    <section aria-labelledby="pull-request-heading" className="ds-stack ds-gap-sm">
      <h2 id="pull-request-heading">Pull request</h2>
      {said !== null &&
        (view.state === "failed" ? (
          <Alert tone="error" role="alert">
            <span data-testid="pull-request-state">{said}</span>
          </Alert>
        ) : (
          <p data-testid="pull-request-state" role="status">
            {said}
          </p>
        ))}
      <PullRequestLink view={view} />
      {problem !== null && (
        <Alert tone="error" role="alert">
          {problem}
        </Alert>
      )}
      {target !== null && (
        <ConfirmAction label={view.state === "failed" ? "Try again" : "Open a pull request"} title="Open a pull request?" confirmLabel="Push and open" cancelLabel="Cancel" disabled={false} busy={busy} busyLabel="Opening" testId="open-pull-request" onConfirm={() => send(target)}>
          <p>
            {"Botbench pushes the branch "}
            <code data-ds-content="">{target.branch}</code>
            {" to the remote "}
            <code data-ds-content="">{target.remote}</code>
            {" ("}
            <code data-ds-content="">{target.address}</code>
            {`) and opens a pull request into ${target.base ?? "the repository's default branch"}, with your own git and gh.`}
          </p>
          <p>Only this branch is sent, at the commit you accepted. Botbench never merges, never pushes by force, and never pushes to the default branch.</p>
        </ConfirmAction>
      )}
    </section>
  );
}
