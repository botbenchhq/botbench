import { Fragment, useEffect, useState, type ReactNode } from "react";
import { buttonVariants } from "@/ui/button";
import { cn } from "@/ui/lib/utils";
import { ApiError, getFallbacks, getUsage, type UsageAgent, type UsageReport, type UsageRun, type UsageScope, type UsageTotals } from "../../api/client.ts";
import { agentName } from "../../app/chat.ts";
import { LIMIT_WORDS } from "../../app/composer.ts";
import { counted, dayAndClock, number } from "../../app/format.ts";
import { orderWords } from "../../app/handoff-words.ts";
import { useModelNames } from "../../components/model-picker.tsx";
import { groupHref } from "../../app/settings-groups.ts";
import { About, More, Note, Panel, Reading, SectionHeading } from "./parts.tsx";

/*
 * Usage and limits: which agents did work, and how much, in words and numbers, and what happens when a builder reaches
 * its usage limit. Tokens only: Botbench stores no dollar amount, and it does not know a sign-in's limit, so there is no
 * meter. Numbers are grouped as the reader's region groups them and carry their unit (app/format.ts).
 */

const replies = (n: number): string => counted(n, "reply", "replies");
const tokens = (n: number): string => counted(n, "token", "tokens");

const COST_WORDS = {
  subscription: "Signed in with a subscription. It has no dollar amount, so none is shown.",
  metered: "Signed in with a metered account. Botbench does not record what it costs yet, so no dollar amount is shown.",
  unknown: "Botbench cannot tell which kind of sign-in this is, so only tokens are shown.",
} as const;

const CELL = "px-5 py-3 text-right tabular-nums max-sm:flex max-sm:justify-between max-sm:gap-4 max-sm:p-0 max-sm:text-left sm:whitespace-nowrap";

/** A number's cell. On a phone a row is a short list, so each number says what it counts. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <td className={CELL}>
      <span aria-hidden="true" className="text-muted-foreground sm:hidden">
        {label}
      </span>
      {children}
    </td>
  );
}

function Numbers({ of }: { of: UsageTotals }) {
  return (
    <>
      <Cell label="Replies">{replies(of.turns)}</Cell>
      <Cell label="Input">{tokens(of.inputTokens)}</Cell>
      <Cell label="Output">{tokens(of.outputTokens)}</Cell>
    </>
  );
}

const ROW = "align-top max-sm:flex max-sm:flex-col max-sm:gap-1 max-sm:px-5 max-sm:py-3";
const NAME = "px-5 py-3 text-left max-sm:p-0";

function Table({ caption, first, testId, children }: { caption: string; first: string; testId: string; children: ReactNode }) {
  return (
    <Panel className="overflow-hidden">
      <table data-testid={testId} className="w-full text-meta">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b text-muted-foreground max-sm:sr-only">
          <tr>
            <th scope="col" className="px-5 py-2 text-left font-semibold">
              {first}
            </th>
            {["Replies", "Input", "Output"].map((column) => (
              <th key={column} scope="col" className="px-5 py-2 text-right font-semibold">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </Panel>
  );
}

function AgentTable({ caption, scope, modelName, testId }: { caption: string; scope: UsageScope; modelName: (id: string) => string; testId: string }) {
  return (
    <Table caption={caption} first="Agent and model" testId={testId}>
      {scope.agents.map((agent: UsageAgent) => (
        <Fragment key={agent.driver}>
          <tr data-testid="usage-agent" className={ROW}>
            <th scope="row" data-ds-content="" className={`${NAME} text-sm font-semibold`}>
              {agentName(agent.driver)}
            </th>
            <Numbers of={agent} />
          </tr>
          {agent.models.map((model) => (
            <tr key={model.model ?? ""} data-testid="usage-model" className={`${ROW} text-muted-foreground`}>
              <th scope="row" data-ds-content="" className={`${NAME} font-normal sm:pl-9`}>
                {model.model === null ? `${agentName(agent.driver)}, model not recorded` : modelName(model.model)}
              </th>
              <Numbers of={model} />
            </tr>
          ))}
        </Fragment>
      ))}
    </Table>
  );
}

function RunTable({ runs }: { runs: UsageReport["runs"] }) {
  return (
    <Table caption="Runs, most recent first" first="Run" testId="usage-runs">
      {runs.items.map((run: UsageRun) => (
        <tr key={run.id} data-testid="usage-run" className={ROW}>
          <th scope="row" className={`${NAME} text-sm font-semibold`}>
            <a data-ds-content="" className="underline-offset-4 hover:underline" href={run.kind === "single" && run.tasks[0] ? `#/tasks/${run.tasks[0].id}` : `#/runs/${run.id}`}>
              {run.title}
            </a>
          </th>
          <Numbers of={run} />
        </tr>
      ))}
    </Table>
  );
}

/** One of the week's three numbers. */
function Stat({ label, value, context }: { label: string; value: string; context: string }) {
  return (
    <Panel className="flex flex-col gap-1 p-4">
      <p className="text-meta text-muted-foreground">{label}</p>
      <p className="text-heading font-semibold tabular-nums">{value}</p>
      <p className="text-meta text-muted-foreground">{context}</p>
    </Panel>
  );
}

/**
 * What happens when a builder reaches its usage limit: the two choices a run is started with, in the composer's own
 * words, and the order agents are tried in now, which is changed under Agents and models.
 */
function AtTheLimit({ onSignedOut }: { onSignedOut: () => void }) {
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => {
    getFallbacks().then(
      (found) => setOrder(found.list),
      (err: unknown) => err instanceof ApiError && err.status === 401 && onSignedOut(),
    );
  }, [onSignedOut]);
  return (
    <aside aria-labelledby="usage-limit" data-testid="usage-limit" className="flex flex-col gap-4">
      <SectionHeading id="usage-limit">{LIMIT_WORDS.title}</SectionHeading>
      <About>You choose one of two for each run, under Add context. A single task waits.</About>
      <Panel className="flex flex-col gap-2 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{LIMIT_WORDS.wait.name}</h3>
          <span className="inline-flex h-6 items-center rounded-sm border border-border px-2 text-xs text-muted-foreground">The default</span>
        </div>
        <About>{LIMIT_WORDS.wait.description}</About>
      </Panel>
      <Panel className="flex flex-col gap-2 p-5">
        <h3 className="text-base font-semibold">{LIMIT_WORDS.switch.name}</h3>
        <About>{LIMIT_WORDS.switch.description}</About>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <About data-testid="usage-order">{order === null ? "Reading the list." : order.length === 0 ? "The list is empty now." : `The list now: ${orderWords(order)}`}</About>
          <a href={groupHref("agents")} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Change the order
          </a>
        </div>
      </Panel>
    </aside>
  );
}

/** Usage and limits: this week by agent and model, all time, by run; and what happens at a usage limit. No money. */
export function UsageGroup({ onSignedOut }: { onSignedOut: () => void }) {
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
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div data-testid="usage" className="flex min-w-0 flex-col gap-8">
        {failed !== null && (
          <Note tone="error" role="alert">
            {failed}
          </Note>
        )}
        {report === null ? (
          failed === null && <Reading>Reading usage.</Reading>
        ) : report.allTime.turns === 0 ? (
          <Panel data-testid="usage-empty" className="flex flex-col gap-1 border-dashed bg-transparent p-5">
            <h2 className="text-base font-semibold">No usage yet</h2>
            <About>Tokens are counted here after an agent has answered in a chat, a task or a run.</About>
          </Panel>
        ) : (
          <>
            <section className="flex flex-col gap-4" aria-labelledby="usage-week">
              <SectionHeading id="usage-week">This week</SectionHeading>
              <div data-testid="usage-week" className="grid gap-3 sm:grid-cols-3">
                <Stat label="Replies" value={replies(report.week.turns)} context={`Since ${dayAndClock(report.since)}, from every agent`} />
                <Stat label="Input" value={tokens(report.week.inputTokens)} context="Sent to the agents, cached tokens included" />
                <Stat label="Output" value={tokens(report.week.outputTokens)} context="Written by the agents" />
              </div>
              <AgentTable caption="Agents and models this week" scope={report.week} modelName={modelName} testId="usage-agents-week" />
              <More about="Why no cost is shown">
                <dl className="flex flex-col gap-2">
                  {report.week.agents.map((agent) => (
                    <div key={agent.driver}>
                      <dt className="font-semibold text-foreground">{`${agentName(agent.driver)} cost`}</dt>
                      <dd>{COST_WORDS[agent.billing]}</dd>
                    </div>
                  ))}
                </dl>
              </More>
            </section>
            <section className="flex flex-col gap-4" aria-labelledby="usage-runs-heading">
              <SectionHeading id="usage-runs-heading">By run</SectionHeading>
              {report.runs.total === 0 ? (
                <p data-testid="usage-runs-count" className="text-sm text-muted-foreground">
                  No run has used an agent yet. Chat replies belong to no run.
                </p>
              ) : (
                <>
                  <RunTable runs={report.runs} />
                  <About data-testid="usage-runs-count">{report.runs.total > report.runs.items.length ? `Showing the ${number(report.runs.items.length)} most recent of ${number(report.runs.total)} runs that used an agent.` : `${counted(report.runs.total, "run", "runs")} used an agent.`}</About>
                </>
              )}
            </section>
            <section className="flex flex-col gap-4" aria-labelledby="usage-all">
              <SectionHeading id="usage-all">All time</SectionHeading>
              <AgentTable caption="Agents and models, all time" scope={report.allTime} modelName={modelName} testId="usage-agents-all" />
            </section>
          </>
        )}
      </div>
      <AtTheLimit onSignedOut={onSignedOut} />
    </div>
  );
}
