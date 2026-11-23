import type { IssueLink, TaskDetail } from "../api/client.ts";
import { threadHref } from "../app/paired-words.ts";
import { Icon } from "./icon.tsx";
import { LOOKS } from "./looks.ts";
import { StatusBadge } from "./status.tsx";

/**
 * What a run or task that read outside text says about it: the Outside text badge, what that changes, and where the
 * text came from: a link to the GitHub issue, or, for a task the owner gave a paired workbench's message, a link to
 * that conversation. The title of an issue and the other workbench's name are other people's words, shown as plain text.
 */
export function OutsideText({ issue, given = null, what }: { issue: IssueLink | null; given?: TaskDetail["givenMessage"]; what: "run" | "task" }) {
  return (
    <div className="ds-stack ds-gap-xs" data-testid="outside-text">
      <p>
        <StatusBadge look={LOOKS.outsideText}>Outside text</StatusBadge>
      </p>
      {given !== null ? (
        <p>
          {`This ${what} was given a message from `}
          <span data-ds-content="">{given.peerName}</span>
          {"'s workbench, which another person wrote. No command is allowed for it in advance or always allowed, it cannot be fully autonomous, and nothing is sent to that workbench unless you press Send."}
        </p>
      ) : (
        <p>{`This ${what} read a GitHub issue, which people outside this project wrote. No command is allowed for it in advance or always allowed, and it cannot be fully autonomous.`}</p>
      )}
      {given !== null && given.contextId !== null && (
        <a data-testid="given-link" className="ds-link" href={threadHref(given.pairingId, given.contextId)}>
          The conversation it came from
        </a>
      )}
      {issue !== null && (
        <a data-testid="issue-link" className="ds-link" href={issue.url} target="_blank" rel="noopener noreferrer">
          {`Issue #${issue.number} on GitHub`}
          <Icon name="external-link" className="ds-link__icon" />
          <span className="ds-link__hint">(opens in a new tab)</span>
        </a>
      )}
    </div>
  );
}
