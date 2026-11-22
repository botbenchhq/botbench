import type { IssueLink } from "../api/client.ts";
import { Icon } from "./icon.tsx";
import { LOOKS } from "./looks.ts";
import { StatusBadge } from "./status.tsx";

/**
 * What a run or task that read a GitHub issue says about it: the Outside text badge, what that changes, and a link to
 * the issue on GitHub. The title is text people outside the project wrote, so it is shown as plain text.
 */
export function OutsideText({ issue, what }: { issue: IssueLink | null; what: "run" | "task" }) {
  return (
    <div className="ds-stack ds-gap-xs" data-testid="outside-text">
      <p>
        <StatusBadge look={LOOKS.outsideText}>Outside text</StatusBadge>
      </p>
      <p>
        {`This ${what} read a GitHub issue, which people outside this project wrote. No command is allowed for it in advance or always allowed, and it cannot be fully autonomous.`}
      </p>
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
