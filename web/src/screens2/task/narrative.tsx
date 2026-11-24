import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, CircleAlert, CircleDot, Clock, Minus } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible";
import { cn } from "@/ui/lib/utils";
import { RESTART_STOPPED, type StoredEvent } from "../../api/client.ts";
import { agentName } from "../../app/chat.ts";
import { counted, duration } from "../../app/format.ts";
import { MarkdownView } from "../../components/markdown-view.tsx";
import { readStory } from "../../components/transcript-story.ts";
import { narrative, type Part, type Step } from "./task-model.ts";

/*
 * A task's activity as a narrative (boards V2Executing, V2MExecuting), from its stored events and nothing else: what
 * the owner sent, what the agent said, and its steps. Steps that are over fold under one line that counts them; the
 * step that runs now stands open with a clock. What a step printed is shown once it has returned: an agent's program
 * reports a call when it starts and when it returns, and nothing in between.
 */

const short = (ms: number): string => duration(ms, "short").words;

/** How much of a step's output is drawn: its last lines, which is where a command says how it ended. */
const MAX_OUTPUT = 4000;

/** A clock that counts from `since`, once a second. Outside any live region: a screen reader is not read each second. */
export function Running({ since, className }: { since: string | number; className?: string }) {
  const from = typeof since === "number" ? since : Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!Number.isFinite(from)) return null;
  return (
    <span data-testid="clock" className={cn("inline-flex items-center gap-1.5 text-meta text-muted-foreground tabular-nums", className)}>
      <Clock aria-hidden="true" className="size-3.5" />
      {short(Math.max(0, now - from))}
    </span>
  );
}

/** A step's one line: the plain verb, then its object as the agent gave it. */
function StepLine({ step }: { step: Step }) {
  const { line } = step;
  return (
    <span className="min-w-0 break-words">
      {line.verb === null ? <code>{line.tool}</code> : line.verb}
      {line.object !== "" && (
        <>
          {" "}
          <code data-ds-content="" title={line.whole === line.object ? undefined : line.whole} className="text-foreground">
            {line.object}
          </code>
        </>
      )}
      {line.note !== "" && <span className="text-muted-foreground">{`, ${line.note}`}</span>}
    </span>
  );
}

function Output({ step }: { step: Step }) {
  if (step.output === null) return null;
  const cut = step.output.length > MAX_OUTPUT;
  return (
    <pre tabIndex={0} role="group" aria-label="What it printed" data-ds-content="" className="max-h-80 overflow-auto rounded-md bg-sunken p-3 text-foreground">
      {step.output === "" ? "(no output)" : cut ? `…\n${step.output.slice(-MAX_OUTPUT)}` : step.output}
    </pre>
  );
}

/** One step inside a folded group: its line and its time; its output and why it did not end well behind the line. */
function StepRow({ step }: { step: Step }) {
  const bad = step.state !== "done";
  const Mark = step.state === "done" ? Check : step.state === "refused" ? Minus : CircleAlert;
  const more = step.output !== null || step.note !== null;
  const head = (
    <>
      <Mark aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", bad && step.state !== "refused" ? "text-destructive" : "text-muted-foreground")} />
      <StepLine step={step} />
      {step.ms !== null && <span className="ml-auto pl-3 text-meta text-muted-foreground tabular-nums">{short(step.ms)}</span>}
    </>
  );
  if (!more) return <li className="flex items-start gap-3 px-5 py-2.5 text-sm">{head}</li>;
  return (
    <li>
      <Collapsible defaultOpen={bad}>
        <CollapsibleTrigger className="group/step flex min-h-(--control) w-full items-start gap-3 px-5 py-2.5 text-left text-sm outline-none hover:bg-fill/50 focus-visible:ring-3 focus-visible:ring-ring/50">
          {head}
          <ChevronDown aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/step:rotate-180", step.ms === null && "ml-auto")} />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 px-5 pb-3">
          {step.note !== null && <p className="text-meta text-muted-foreground">{step.note}</p>}
          <Output step={step} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** Steps that are over, under one line: how many, and what they did in the transcript's own counted words. */
function Steps({ part }: { part: Extract<Part, { kind: "steps" }> }) {
  const [open, setOpen] = useState(part.open);
  // A group that gains a step that did not end well opens by itself; what the reader chose after that stands.
  useEffect(() => {
    if (part.open) setOpen(true);
  }, [part.open]);
  const done = part.steps.every((step) => step.state === "done");
  return (
    <li data-testid="steps" className="overflow-hidden rounded-xl bg-raised">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group/steps flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-left outline-none hover:bg-fill/50 focus-visible:ring-3 focus-visible:ring-ring/50">
          {done ? <Check aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />}
          <span className="text-sm font-semibold">{`${counted(part.steps.length, "step", "steps")} ${done ? "done" : "ended"}`}</span>
          <span className="min-w-0 flex-1 basis-40 truncate text-meta text-muted-foreground">{part.summary}</span>
          <span className="inline-flex items-center gap-1 text-meta font-medium text-muted-foreground">
            {open ? "Hide steps" : "Show steps"}
            <ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-panel-open/steps:rotate-180" />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="divide-y border-t">
            {part.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** The step that runs now, or waits for the owner's answer: open, with how long it has run. */
function NowStep({ step }: { step: Step }) {
  const waits = step.state === "waiting";
  return (
    <li data-testid="step-now" data-state={step.state} className="flex flex-col gap-2 rounded-xl bg-raised px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold">
        <CircleDot aria-hidden="true" className={cn("size-4 shrink-0", waits ? "text-attention" : "text-primary")} />
        <StepLine step={step} />
        {!waits && <Running since={step.at} className="ml-auto" />}
      </div>
      <p className="text-meta text-muted-foreground">{waits ? "It waits for your answer, on the card above." : "What it prints is shown here once it has returned."}</p>
    </li>
  );
}

function Said({ who, children }: { who: string; children: ReactNode }) {
  return (
    <li data-testid="said" className="flex gap-3">
      <span aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary">
        {who.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <span className="sr-only">{`${who}: `}</span>
        {children}
      </div>
    </li>
  );
}

/**
 * The narrative of the events given, oldest first. `live`: something is still running, so a step with no result yet is
 * running and not unfinished. `who` names the agent of a session, for a task that moved between agents. `children`
 * follow the last part, inside the list: what the task waits for now.
 */
export function Narrative({ events, live, who, builder, children }: { events: readonly StoredEvent[]; live: boolean; who: (attemptId: number) => string | null; builder: string; children?: ReactNode }) {
  const parts = useMemo(() => narrative(events, readStory(events, live)), [events, live]);
  return (
    // The log is the wrapper, so the list inside keeps its items; only what is added is read out.
    <div role="log" aria-label="Activity" aria-relevant="additions" data-testid="narrative">
    <ol className="flex flex-col gap-4">
      {parts.map((part) => {
        switch (part.kind) {
          case "prompt":
            return (
              <li key={part.id} data-testid="prompt" className="max-w-[85%] self-end rounded-xl bg-fill px-4 py-3 text-base">
                <span className="sr-only">You: </span>
                <span data-ds-content="" className="break-words whitespace-pre-wrap">
                  {part.text}
                </span>
              </li>
            );
          case "said":
            return (
              <Said key={part.id} who={agentName(who(part.attemptId) ?? builder)}>
                <MarkdownView text={part.text} className="flex flex-col gap-2 text-base break-words" />
              </Said>
            );
          case "steps":
            return <Steps key={part.id} part={part} />;
          case "step":
            return <NowStep key={part.id} step={part.step} />;
          case "ended":
            return (
              <li key={part.id} data-testid="ended" className="text-meta text-muted-foreground">
                {part.reason === "interrupted" ? (part.detail === RESTART_STOPPED ? `${RESTART_STOPPED}.` : "Stopped before it finished.") : part.detail === null ? "Ended with an error." : "Ended with an error: "}
                {part.reason === "error" && part.detail !== null && <span data-ds-content="">{part.detail}</span>}
              </li>
            );
          case "problem":
            return (
              <li key={part.id} className="text-meta text-destructive">
                <span data-ds-content="">{part.message}</span>
              </li>
            );
        }
      })}
      {children}
    </ol>
    </div>
  );
}
