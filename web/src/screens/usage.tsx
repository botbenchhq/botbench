import { Fragment, useEffect, useState } from "react";
import { ApiError, getUsage, type UsageAgent, type UsageReport, type UsageRun, type UsageScope, type UsageTotals } from "../api/client.ts";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";
import { useModelNames } from "../components/model-picker.tsx";

/*
 * Usage: which agents did work, and how much, in words and numbers. Tokens only: Botbench stores no dollar amount, and
 * Botbench does not know a sign-in's limit, so there is no meter. Numbers are grouped by thousands and carry their unit.
 */

const number = (n: number): string => n.toLocaleString("en-US");
const replies = (n: number): string => `${number(n)} ${n === 1 ? "reply" : "replies"}`;
const tokens = (n: number): string => `${number(n)} ${n === 1 ? "token" : "tokens"}`;
const when = (iso: string): string => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

/** The product names of the agents Botbench has; an agent not listed is shown by its own id. */
const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "gemini-cli": "Gemini CLI", grok: "Grok", antigravity: "Antigravity" };
const agentName = (driver: string): string => AGENT_NAMES[driver] ?? driver;

const COST_WORDS = {
  subscription: "Signed in with a subscription. It has no dollar amount, so none is shown.",
  metered: "Signed in with a metered account. Botbench does not record what it costs yet, so no dollar amount is shown.",
  unknown: "Botbench cannot tell which kind of sign-in this is, so only tokens are shown.",
} as const;

function Numbers({ of }: { of: UsageTotals }) {
  return (
    <>
      <td className="ds-data-table__numeric" data-label="Replies">
        {replies(of.turns)}
      </td>
      <td className="ds-data-table__numeric" data-label="Input">
        {tokens(of.inputTokens)}
      </td>
      <td className="ds-data-table__numeric" data-label="Output">
        {tokens(of.outputTokens)}
      </td>
    </>
  );
}

const Head = ({ first }: { first: string }) => (
  <thead>
    <tr>
      <th scope="col">{first}</th>
      <th scope="col" className="ds-data-table__numeric">
        Replies
      </th>
      <th scope="col" className="ds-data-table__numeric">
        Input
      </th>
      <th scope="col" className="ds-data-table__numeric">
        Output
      </th>
    </tr>
  </thead>
);

function AgentTable({ caption, scope, modelName, testId }: { caption: string; scope: UsageScope; modelName: (id: string) => string; testId: string }) {
  return (
    <table className="ds-data-table" data-testid={testId}>
      <caption className="ds-data-table__caption">{caption}</caption>
      <Head first="Agent and model" />
      <tbody>
        {scope.agents.map((agent: UsageAgent) => (
          <Fragment key={agent.driver}>
            <tr data-testid="usage-agent">
              <th scope="row" data-ds-content="">
                {agentName(agent.driver)}
              </th>
              <Numbers of={agent} />
            </tr>
            {agent.models.map((model) => (
              <tr key={model.model ?? ""} data-testid="usage-model">
                <th scope="row" data-ds-content="">
                  {model.model === null ? `${agentName(agent.driver)}, model not recorded` : modelName(model.model)}
                </th>
                <Numbers of={model} />
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function RunTable({ runs }: { runs: UsageReport["runs"] }) {
  return (
    <>
      <table className="ds-data-table" data-testid="usage-runs">
        <caption className="ds-data-table__caption">Runs, most recent first</caption>
        <Head first="Run" />
        <tbody>
          {runs.items.map((run: UsageRun) => (
            <tr key={run.id} data-testid="usage-run">
              <th scope="row">
                <a data-ds-content="" className="ds-link" href={run.kind === "single" && run.tasks[0] ? `#/tasks/${run.tasks[0].id}` : `#/runs/${run.id}`}>
                  {run.title}
                </a>
              </th>
              <Numbers of={run} />
            </tr>
          ))}
        </tbody>
      </table>
      <p data-testid="usage-runs-count">{runs.total > runs.items.length ? `Showing the ${number(runs.items.length)} most recent of ${number(runs.total)} runs that used an agent.` : `${number(runs.total)} ${runs.total === 1 ? "run" : "runs"} used an agent.`}</p>
    </>
  );
}

export function UsageScreen({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <Frame current={null} back={{ href: "#/settings", label: "Settings" }}>
      <Page>
        <PageHeader title="Usage" />
        <Usage onSignedOut={onSignedOut} />
      </Page>
    </Frame>
  );
}

/** What the Usage screen holds below its title: on its own screen, and as the Usage section of the two-pane Settings. */
export function Usage({ onSignedOut }: { onSignedOut: () => void }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const modelName = useModelNames(onSignedOut);

  useEffect(() => {
    let stale = false;
    getUsage().then(
      (read) => !stale && setReport(read),
      (err: unknown) => {
        if (stale) return;
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else setFailed(err instanceof ApiError ? `The usage could not be read. ${err.message}` : "The usage could not be read: Botbench could not be reached.");
      },
    );
    return () => {
      stale = true;
    };
  }, [onSignedOut]);

  return (
    <>
        {failed !== null && (
          <Alert tone="error" role="alert">
            {failed}
          </Alert>
        )}
        {report === null ? (
          failed === null && (
            <p role="status" className="ds-spinner">
              Reading usage.
            </p>
          )
        ) : report.allTime.turns === 0 ? (
          <div data-testid="usage-empty" className="ds-empty-state">
            <h2 className="ds-empty-state__title">No usage yet</h2>
            <p className="ds-empty-state__body">Tokens are counted here after an agent has answered in a chat, a task or a run.</p>
          </div>
        ) : (
          <div className="ds-stack">
            <section className="ds-stack" aria-labelledby="usage-week">
              <h2 id="usage-week">This week</h2>
              <div data-testid="usage-week" className="ds-grid ds-grid-3">
                <div className="ds-stat">
                  <p className="ds-stat__label">Replies</p>
                  <p className="ds-stat__value">{replies(report.week.turns)}</p>
                  <p className="ds-stat__context">{`Since ${when(report.since)}, from every agent`}</p>
                </div>
                <div className="ds-stat">
                  <p className="ds-stat__label">Input</p>
                  <p className="ds-stat__value">{tokens(report.week.inputTokens)}</p>
                  <p className="ds-stat__context">Sent to the agents, cached tokens included</p>
                </div>
                <div className="ds-stat">
                  <p className="ds-stat__label">Output</p>
                  <p className="ds-stat__value">{tokens(report.week.outputTokens)}</p>
                  <p className="ds-stat__context">Written by the agents</p>
                </div>
              </div>
              <AgentTable caption="Agents and models this week" scope={report.week} modelName={modelName} testId="usage-agents-week" />
              <dl className="ds-key-value">
                {report.week.agents.map((agent) => (
                  <div key={agent.driver} className="ds-key-value__item">
                    <dt className="ds-key-value__label">{`${agentName(agent.driver)} cost`}</dt>
                    <dd className="ds-key-value__value">{COST_WORDS[agent.billing]}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="ds-stack" aria-labelledby="usage-all">
              <h2 id="usage-all">All time</h2>
              <AgentTable caption="Agents and models, all time" scope={report.allTime} modelName={modelName} testId="usage-agents-all" />
            </section>
            <section className="ds-stack" aria-labelledby="usage-runs-heading">
              <h2 id="usage-runs-heading">By run</h2>
              {report.runs.total === 0 ? <p data-testid="usage-runs-count">No run has used an agent yet. Chat replies belong to no run.</p> : <RunTable runs={report.runs} />}
            </section>
          </div>
        )}
    </>
  );
}
