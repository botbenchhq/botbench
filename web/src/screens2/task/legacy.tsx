import type { ModelList, StoredEvent, TaskDetail } from "../../api/client.ts";
import { folderName } from "../../app/composer.ts";
import { number, plural } from "../../app/format.ts";
import { offersRun } from "../../app/run-source.ts";
import { CheckTogether } from "../../components/check-together.tsx";
import { agentName, CHECKS_LIMITS, CommandRounds, REVIEW_LIMITS } from "../../components/evidence.tsx";
import { MakeRunSection } from "../../components/make-run.tsx";
import { modelName, modelState, sessionModel } from "../../components/model-picker.tsx";
import { PullRequestSection } from "../../components/pull-request.tsx";
import { answeredOther, notMergedLine } from "../../components/task-status.ts";
import { firstLine } from "../../../../src/shorten.ts";

/*
 * The parts of a task's screen that are not rebuilt yet (ADR 0012): they are the components and the markup of the
 * screen this one replaced, drawn with the design system's classes inside the rebuilt screen, under its main parts.
 * Each is unchanged in what it says and does: the commands allowed in advance, the setup commands, checking together,
 * the requests refused without asking, what the agent can do, the pull request, runs made from the task, and the
 * details. They are restyled when the screens they are shared with are rebuilt.
 */

/**
 * One refused request in the task's list: its first line, shortened, and when that is not all of it, a disclosure with
 * the whole of it and how many lines it has. A here-document of thousands of characters stays one line until opened.
 */
function RefusedCommand({ command }: { command: string }) {
  const first = firstLine(command, 100);
  const lines = command.trim().split("\n").length;
  if (first === command.trim()) return <code data-testid="refused-command" data-ds-content="">{first}</code>;
  return (
    <details data-testid="refused-command" className="ds-disclosure">
      <summary className="ds-disclosure__summary">
        <code data-ds-content="">{first}</code>
        <span className="ds-disclosure__meta">{lines === 1 ? `${number(command.trim().length)} characters` : `${number(lines)} lines`}</span>
      </summary>
      <div className="ds-disclosure__content">
        <figure className="ds-code-block">
          <pre data-testid="refused-full" data-ds-content="" className="ds-code-block__body">
            <code>{command}</code>
          </pre>
        </figure>
      </div>
    </details>
  );
}

/** `current`: the events of the session the task names now, from which the model that answered is read. */
export function TaskMore({ task, current, models, onChanged, onSignedOut }: { task: TaskDetail; current: readonly StoredEvent[]; models: ModelList | null; onChanged: () => void; onSignedOut: () => void }) {
  const nameOf = (model: string): string => modelName(models, model);
  const session = sessionModel(current as StoredEvent[]);
  return (
    <div data-testid="task-more" className="ds-stack ds-gap-md border-t pt-6">
      {/* The model asked for is the first agent's: after a move to another agent it says nothing of the one at work now. */}
      {task.handoffs.length === 0 && answeredOther(models, session?.model ?? null, task.requestedModel) && (
        <dl className="ds-key-value">
          <div className="ds-key-value__item">
            <dt className="ds-key-value__label">Model</dt>
            <dd data-testid="task-model" className="ds-key-value__value">{`${modelState(session, nameOf)}. You asked for: ${nameOf(task.requestedModel!)}.`}</dd>
          </div>
        </dl>
      )}

      {task.preapproved.length > 0 && (
        <section className="ds-stack ds-gap-sm">
          <h2>Allowed for this task</h2>
          <ul data-testid="task-preapproved" className="ds-list ds-list--dense">
            {task.preapproved.map((command) => (
              <li key={command} className="ds-list__row">
                <div className="ds-list__content">
                  <span className="ds-list__body">
                    <code data-ds-content="" className="ds-list__primary">
                      {command}
                    </code>
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p>You listed these when you started the task. They run without asking, with further arguments too, unless Botbench's safety rules catch them (git push, sudo, deleting outside the task's copy and the like) or they are chained, piped or redirected: those still ask.</p>
        </section>
      )}

      {task.evidence.some((row) => row.kind === "setup") && (
        <section aria-labelledby="setup-heading" className="ds-stack ds-gap-sm">
          <h2 id="setup-heading">Setup</h2>
          <p>Botbench ran this repository's setup commands in the task's copy before Claude Code started, as your settings list them.</p>
          <CommandRounds lists={task.commandLists} rows={task.evidence.filter((row) => row.kind === "setup")} what={{ one: "setup command", many: "setup commands" }} />
        </section>
      )}

      {task.checks !== null && task.checks !== "none" && <CheckTogether taskId={task.id} repo={task.repo} ready={task.status === "awaiting_decision"} onSignedOut={onSignedOut} />}

      {task.refused.length > 0 && (
        <section aria-labelledby="refused-heading" data-testid="refused" className="ds-stack ds-gap-sm">
          <h2 id="refused-heading">Refused without asking</h2>
          <p>{`Botbench refused ${plural(task.refused.length, "this request", `these ${number(task.refused.length)} requests`)} during this task without asking you. Each shows its first line; open one to see all of it.`}</p>
          <ul className="ds-stack ds-gap-xs">
            {task.refused.map((command, i) => (
              <li key={i}>
                <RefusedCommand command={command} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.decision === null && task.branch !== null && task.remains?.discardedAt == null && (
        <section className="ds-stack ds-gap-sm">
          <p data-testid="not-merged">{notMergedLine(task)}</p>
          <details data-testid="can-do" className="ds-disclosure">
            <summary className="ds-disclosure__summary">What Claude Code can do here</summary>
            <div className="ds-disclosure__content">
              <p data-testid="can-do-text">
                {`Claude Code may read and change files inside this task's copy of the project without asking. ${task.mode === "manual" ? `A shell command kept inside this copy runs without asking, apart from those the safety rules always ask you about; with Ask before every command on in Settings, every one waits for your answer first, unless you ${task.preapproved.length > 0 ? "listed it above or " : ""}chose Always allow for it (see Permissions). Botbench sends you anything else it wants to do as well.` : task.mode === "semi" ? "A shell command kept inside this copy runs without asking, apart from those the safety rules always ask you about; Botbench sends you anything else it wants to do as well." : "Its run is fully autonomous, so its shell commands run without asking, and what would need your answer is refused instead: those the safety rules always ask about, and anything else it wants to do."} The separate copy (a git worktree) keeps changes apart from your own files. A command you allow${task.preapproved.length > 0 ? " or list in advance" : ""} runs in Claude Code's sandbox: it cannot read your sign-ins, your keys or the rest of your home folder (apart from this repository's git data and your git settings), can change files only in this copy and a temporary folder, and reaches the internet only at hosts allowed for this repository in Botbench's settings file.`}
              </p>
            </div>
          </details>
        </section>
      )}

      {task.decision?.decision === "accept" && <PullRequestSection taskId={task.id} view={task.pullRequest} target={task.pullRequestTarget} onChanged={onChanged} onSignedOut={onSignedOut} />}

      {task.runsMade.length > 0 && (
        <section aria-labelledby="runs-made-heading" data-testid="runs-made" className="ds-stack ds-gap-sm">
          <h2 id="runs-made-heading">Runs made from this task</h2>
          <ul className="ds-list ds-list--dense">
            {task.runsMade.map((runId) => (
              <li key={runId} className="ds-list__row">
                <a href={`#/runs/${runId}`} className="ds-list__link">
                  <span className="ds-list__body">
                    <span className="ds-list__primary">{`Run ${runId}`}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {offersRun(task.status) && <MakeRunSection taskId={task.id} repo={task.repo} />}

      <details data-testid="task-details" className="ds-disclosure">
        <summary className="ds-disclosure__summary">Details</summary>
        <div className="ds-disclosure__content ds-stack ds-gap-sm">
          <dl className="ds-key-value">
            <div className="ds-key-value__item">
              <dt className="ds-key-value__label">Repository</dt>
              <dd data-testid="task-repo" data-ds-content="" className="ds-key-value__value ds-key-value__value--mono">
                {task.repo}
              </dd>
            </div>
          </dl>
          {/* The full limits of the checks and the review, once, rather than under every result. */}
          {task.checks !== null && task.checks !== "none" && <p data-testid="checks-limits">{CHECKS_LIMITS}</p>}
          {task.reviewer !== null && task.review !== null && <p data-testid="review-limits">{`${agentName(task.reviewer.agent)}'s review: ${REVIEW_LIMITS}`}</p>}
        </div>
      </details>
    </div>
  );
}

/** The task's number and repository, as its bar names it. */
export const taskName = (task: Pick<TaskDetail, "id" | "repo">): string => `Task ${task.id} · ${folderName(task.repo)}`;
