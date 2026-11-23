import { useEffect, useId, useState } from "react";
import { ApiError, getPeers, getPeersOf, type PeersView } from "../api/client.ts";
import { folderName } from "../app/composer.ts";
import { Icon } from "./icon.tsx";

/**
 * Work's quiet section "Other workbenches" (Peers P2): for each repository the owner has used, what other workbenches
 * have in flight on its shared remote, read only: their open pull requests (each a link that opens GitHub in a new tab)
 * and their pushed branches with no pull request yet. Shown only when there is something; nothing at all otherwise,
 * also while it is read or when it cannot be read (never a state that holds anything up). Everything in it but the
 * numbers is outside text, shown as plain text.
 */
export function OtherWorkbenches({ onSignedOut }: { onSignedOut: () => void }) {
  const [views, setViews] = useState<PeersView[] | null>(null);
  const id = useId();
  useEffect(() => {
    let live = true;
    getPeers().then(
      (found) => live && setViews(found),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
      },
    );
    return () => {
      live = false;
    };
  }, [onSignedOut]);

  const shown = (views ?? []).flatMap((view) => (view.state === "ready" && (view.pullRequests.length > 0 || view.branches.length > 0) ? [view] : []));
  if (shown.length === 0) return null;
  return (
    <section data-testid="other-workbenches" aria-labelledby={`${id}-heading`} className="ds-stack ds-gap-sm">
      <h2 id={`${id}-heading`}>Other workbenches</h2>
      {shown.map((view) => (
        <ul key={view.repo} aria-label={`Other workbenches in ${folderName(view.repo)}`} className="ds-list">
          {view.pullRequests.map((pr) => (
            <li key={`pr ${pr.number}`} className="ds-list__row">
              <a data-testid="peer-pull-request" href={pr.url} target="_blank" rel="noopener noreferrer" className="ds-list__link">
                <span className="ds-list__body">
                  <span className="ds-list__primary">
                    {`Pull request #${pr.number}: `}
                    <span data-ds-content="">{pr.title}</span>
                  </span>
                  <span className="ds-list__secondary">
                    <span data-ds-content="">{pr.workbench}</span>
                    {`${pr.closes.length === 0 ? "" : ` · Closes ${pr.closes.map((n) => `#${n}`).join(", ")}`} · ${folderName(view.repo)} (opens GitHub in a new tab)`}
                  </span>
                </span>
                <Icon name="external-link" className="ds-list__icon" />
              </a>
            </li>
          ))}
          {view.branches.map((b) => (
            <li key={`branch ${b.branch}`} className="ds-list__row">
              <div data-testid="peer-branch" className="ds-list__content">
                <span className="ds-list__body">
                  <code data-ds-content="" className="ds-list__primary">
                    {b.branch}
                  </code>
                  <span className="ds-list__secondary">
                    <span data-ds-content="">{b.workbench}</span>
                    {` · Pushed, no pull request yet · ${folderName(view.repo)}`}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}

/**
 * The view of other workbenches' work for one repository, for the composer and the task screen: null while it is read,
 * when no repository is given, and when it cannot be read (nothing is ever held up by it).
 */
export function usePeersOf(repo: string, onSignedOut: () => void): PeersView | null {
  const [view, setView] = useState<PeersView | null>(null);
  useEffect(() => {
    setView(null);
    if (repo === "") return;
    let live = true;
    getPeersOf(repo).then(
      (found) => live && setView(found),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
      },
    );
    return () => {
      live = false;
    };
  }, [repo, onSignedOut]);
  return view;
}
