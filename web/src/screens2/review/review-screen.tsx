import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleCheck, CircleDashed, CircleX, Clock, Minus, X } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/ui/lib/utils";
import { ApiError, getTask, getTaskDiff, getTranscript, openEventStream, type Evidence, type FileChange, type StoredEvent, type TaskDetail } from "../../api/client.ts";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { agentName } from "../../app/chat.ts";
import { folderName } from "../../app/composer.ts";
import { counted, duration, plural } from "../../app/format.ts";
import { shownAttempts } from "../../app/handoff-words.ts";
import { behindLine } from "../../app/main-words.ts";
import { CHECKS_LINE, checksSummary, commandResult, latestRound, REVIEW_LINE, reviewerWords } from "../../components/evidence.tsx";
import { fileMarks, statusSentence, statusWord, taskTitle } from "../../components/task-status.ts";
import { mergeEvents } from "../../components/transcript.tsx";
import { TaskScreen } from "../../screens/task.tsx";
import { DecisionPanel } from "./decision-panel.tsx";
import { activityLine, diffRows } from "./review-model.ts";
import { NextShell } from "../../shell/shell.tsx";

/*
 * A task that is ready for review, or decided, rebuilt on shadcn/ui and Tailwind 4 (ADR 0012), at the task's own
 * address with ?new=1. It is the review of the approved board (V2Review): the verification result with its kinds of
 * claim, the changed files with their diffs, what nothing verified, the agent's activity folded away, and the decision
 * at the right. Everything shown is read through the API client; every sentence about the evidence is the server's.
 * A task in any other state is shown by the old screen, which has what such a task needs (its approval card first).
 */

const short = (commit: string): string => commit.slice(0, 7);

/** The label of a claim: what kind of claim the row beside it is. Not pressable. A check is filled, a model's or an agent's words outlined, what nothing verified dashed. */
function ClaimLabel({ kind }: { kind: "check" | "review" | "agent" | "unverified" }) {
  const words = { check: "Check", review: "Review", agent: "Agent said", unverified: "Not verified" }[kind];
  return (
    <span className={cn("inline-flex h-5 w-fit items-center rounded-sm border px-1.5 text-xs", kind === "check" ? "border-transparent bg-fill font-semibold text-foreground" : "font-medium text-muted-foreground", kind === "unverified" && "border-dashed border-edge")}>
      {words}
    </span>
  );
}

/** One claim: its label in a column of its own, then the claim. */
function Claim({ kind, children }: { kind: "check" | "review" | "agent" | "unverified"; children: ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      <ClaimLabel kind={kind} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A block of text a program wrote, on the sunken surface. It scrolls inside itself, so the page never scrolls sideways. */
function Output({ label, children }: { label: string; children: ReactNode }) {
  return (
    <pre tabIndex={0} role="group" aria-label={label} data-ds-content-label="" data-ds-content="" className="mt-2 max-h-80 overflow-auto rounded-md bg-sunken p-3 text-foreground">
      {children}
    </pre>
  );
}

/** One check Botbench ran: the command, its result in words, the commit it ran on and how long it took, and its output behind a button. */
function CheckClaim({ row, current }: { row: Evidence; current: boolean }) {
  const result = commandResult(row).words;
  const passed = row.outcome === "passed";
  const took = duration(row.durationMs, "units");
  // Green only for a check that passed on the commit under review. One that ran on another commit keeps its word and loses the colour.
  const tone = !current ? "border-border text-muted-foreground" : passed ? "border-transparent bg-success-subtle text-success" : row.outcome === "failed" || row.outcome === "timed_out" ? "border-transparent bg-destructive-subtle text-destructive" : "border-border text-muted-foreground";
  const Mark = !current ? Minus : passed ? CircleCheck : row.outcome === "failed" || row.outcome === "timed_out" ? CircleX : Minus;
  return (
    <Claim kind="check">
      <Collapsible>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Mark aria-hidden="true" className={cn("size-4 shrink-0", current && passed ? "text-success" : current && (row.outcome === "failed" || row.outcome === "timed_out") ? "text-destructive" : "text-muted-foreground")} />
          <code data-ds-content="" className="min-w-0 break-words text-foreground">
            {row.command}
          </code>
          <Badge variant="outline" className={tone}>
            {result}
          </Badge>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" />}>
            Output
            <span data-ds-content="" className="sr-only">{` of ${row.command}`}</span>
          </CollapsibleTrigger>
        </div>
        <p className="mt-1 text-meta text-muted-foreground">
          {row.commit === null ? "Botbench has no record of the commit it ran on. " : <>{"Botbench ran it on commit "}<code>{short(row.commit)}</code>{". "}</>}
          <time dateTime={took.iso}>{took.words}</time>.
        </p>
        <CollapsibleContent>
          <Output label={`Output of ${row.command}`}>{row.truncated ? `…\n${row.output}` : row.output === "" ? "(no output)" : row.output}</Output>
        </CollapsibleContent>
      </Collapsible>
    </Claim>
  );
}

/**
 * The verification result: one mark, the checks' count as the heading, and under it the server's own sentence about
 * whether that evidence is about the commit Accept would keep. Then one row per claim. The mark is green only when the
 * checks passed on the commit under review.
 */
function Verification({ task }: { task: TaskDetail }) {
  const state = task.evidenceState;
  const rows = latestRound(task.evidence.filter((row) => row.kind === "check"));
  const lists = task.commandLists.filter((list) => list.kind === "check");
  const total = lists.find((list) => list.round === rows[0]?.round)?.total;
  // Once decided there is no evidence state: the checks are shown as they were recorded, in the neutral tone.
  const current = state?.state === "current";
  const look = state === null ? "plain" : state.state === "none" ? "none" : !current ? "attention" : state.checks === "passed" ? "passed" : "failed";
  const Mark = { passed: Check, failed: X, attention: Clock, none: CircleDashed, plain: Minus }[look];
  const heading = task.checks === null ? "No checks ran on this work" : task.checks === "none" ? "No checks are set up for this repository" : checksSummary(rows, { one: "check", many: "checks" }, Math.max(total ?? rows.length, rows.length)).replace(/\.$/, "");
  const review = task.review ?? null;
  return (
    <Card data-testid="verification" className="gap-0 py-0">
      <div className="flex items-start gap-4 p-5">
        <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", { passed: "bg-success-subtle text-success", failed: "bg-destructive-subtle text-destructive", attention: "bg-attention-subtle text-attention", none: "border border-dashed border-edge text-muted-foreground", plain: "bg-fill text-muted-foreground" }[look])}>
          <Mark className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 data-testid="verification-heading" className="text-heading font-semibold tracking-tight">
            {heading}
          </h2>
          {state !== null && (
            <p data-testid="evidence-words" data-evidence={state.state} className="text-base text-muted-foreground">
              {state.words}
            </p>
          )}
          {state === null && task.evidenceProblem !== null && (
            <p data-testid="evidence-problem" className="text-base text-muted-foreground">
              {task.evidenceProblem}
            </p>
          )}
          {state?.ignoredWords != null && (
            <p data-testid="evidence-ignored" data-ds-content="" className="mt-1 text-meta text-muted-foreground">
              {state.ignoredWords}
            </p>
          )}
        </div>
      </div>
      {state?.state === "differs" && (
        <ul data-testid="evidence-files" className="border-t px-5 py-3 text-base">
          {state.files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-baseline justify-between gap-x-4 py-1">
              <code data-ds-content="" className="text-foreground">
                {file.path}
              </code>
              <span className="text-meta text-muted-foreground">{file.change === "changed" ? "Changed since the commit" : "Not on the branch"}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="divide-y border-t">
        {rows.map((row) => (
          <CheckClaim key={row.id} row={row} current={current && row.commit !== null && row.commit === state?.headCommit} />
        ))}
        {rows.length > 0 && <p className="px-5 py-3 text-meta text-muted-foreground">{CHECKS_LINE}</p>}
        {task.reviewer !== null && review !== null ? (
          <Claim kind="review">
            <p className="text-base">
              <span className="font-semibold">{reviewerWords(review)}</span>
              {task.reviewLine !== null && <span data-testid="review-outcome" className="text-muted-foreground">{` ${task.reviewLine}`}</span>}
            </p>
            <p className="text-meta text-muted-foreground">
              {REVIEW_LINE}
              {review.checked.length > 0 && ` ${agentName(review.agent)} says it checked:`}
            </p>
            {review.checked.length > 0 && (
              <ul data-ds-content="" className="mt-1 list-disc pl-5 text-meta text-muted-foreground">
                {review.checked.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
            {state?.review != null && !state.review.current && (
              <p data-testid="evidence-review" className="mt-1 text-meta text-attention">
                {state.review.words}
              </p>
            )}
          </Claim>
        ) : (
          <Claim kind="unverified">
            <p data-testid="not-reviewed" className="text-base text-muted-foreground">
              {task.reviewer === null ? "Not reviewed: this run has no reviewer." : "Not reviewed."}
            </p>
          </Claim>
        )}
      </div>
    </Card>
  );
}

/** What is known about one file's diff: being fetched, fetched, or why it could not be. */
type DiffState = { kind: "loading" } | { kind: "loaded"; diff: string; truncated: boolean } | { kind: "failed"; why: string };

/** A file's diff, on the sunken surface: a line number, the sign, and the line. The sign stays in the text; the colour only repeats it. */
function Diff({ path, state }: { path: string; state: DiffState | undefined }) {
  if (state === undefined || state.kind === "loading") {
    return (
      <p role="status" className="border-t px-5 py-3 text-meta text-muted-foreground">
        Loading the changes.
      </p>
    );
  }
  if (state.kind === "failed") {
    return <p role="alert" className="border-t px-5 py-3 text-meta text-destructive">{`The changes could not be loaded. ${state.why}`}</p>;
  }
  return (
    <>
      <pre data-testid="diff" tabIndex={0} role="group" aria-label={`Changes in ${path}`} data-ds-content-label="" data-ds-content="" className="overflow-x-auto border-t bg-sunken py-2">
        <code className="grid min-w-max">
          {diffRows(state.diff).map((row, i) => {
            const Line = row.kind === "added" ? "ins" : row.kind === "removed" ? "del" : "span";
            return (
              <Line key={i} data-line={row.kind} className={cn("grid grid-cols-[3rem_1.5rem_minmax(0,1fr)] px-2 no-underline", row.kind === "added" && "bg-success-subtle text-success", row.kind === "removed" && "bg-destructive-subtle text-destructive", (row.kind === "hunk" || row.kind === "note") && "text-muted-foreground")}>
                <span className="pr-2 text-right tabular-nums select-none">{row.number ?? ""}</span>
                <span>{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span>
                <span className="whitespace-pre">{row.text}</span>
              </Line>
            );
          })}
        </code>
      </pre>
      {state.truncated && <p className="border-t px-5 py-3 text-meta text-muted-foreground">These changes are longer than Botbench shows here. All of them are on the branch.</p>}
    </>
  );
}

/** A file's line counts: each a sign and a number, finished in words for a screen reader. */
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-meta tabular-nums whitespace-nowrap">
      <span className="text-success">
        {`+${added}`}
        <span className="sr-only">{plural(added, " line added", " lines added")}</span>
      </span>{" "}
      <span className="text-destructive">
        {`−${removed}`}
        <span className="sr-only">{plural(removed, " line removed", " lines removed")}</span>
      </span>
    </span>
  );
}

/** The changed files, each with its diff from the API: the first one open, the rest read when opened. */
function ChangedFiles({ task, onSignedOut }: { task: TaskDetail; onSignedOut: () => void }) {
  const files = task.files;
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const asked = useRef(new Set<string>());
  const read = useCallback(
    (path: string): void => {
      if (asked.current.has(path)) return;
      asked.current.add(path);
      setDiffs((have) => ({ ...have, [path]: { kind: "loading" } }));
      getTaskDiff(task.id, path).then(
        ({ diff, truncated }) => setDiffs((have) => ({ ...have, [path]: { kind: "loaded", diff, truncated } })),
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
          asked.current.delete(path);
          setDiffs((have) => ({ ...have, [path]: { kind: "failed", why: err instanceof ApiError ? err.message : "Botbench could not be reached." } }));
        },
      );
    },
    [task.id, onSignedOut],
  );
  const first = files?.[0]?.path;
  useEffect(() => {
    if (first !== undefined) read(first);
  }, [first, read]);

  if (files === null) return task.filesProblem === null ? null : <p role="alert" className="text-base text-destructive">{task.filesProblem}</p>;
  if (files.length === 0) return <p data-testid="no-changes" className="text-base text-muted-foreground">No file was changed, so the branch is still at the commit it started from.</p>;
  const text = files.filter((file) => !file.binary);
  return (
    <Card data-testid="changed-files" className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <h2 className="text-base font-semibold">{`${counted(files.length, "file", "files")} changed`}</h2>
        <Counts added={text.reduce((sum, file) => sum + file.added, 0)} removed={text.reduce((sum, file) => sum + file.removed, 0)} />
      </div>
      {files.map((file: FileChange, i) => (
        <Collapsible key={file.path} defaultOpen={i === 0} onOpenChange={(open) => open && read(file.path)} className="border-t">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2">
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group/file -ml-3 min-w-0 justify-start font-normal" />}>
              <ChevronRight aria-hidden="true" className="transition-transform group-data-panel-open/file:rotate-90" />
              <code data-ds-content="" className="truncate text-foreground">
                {file.path}
              </code>
            </CollapsibleTrigger>
            {fileMarks(file).map((mark) => (
              <Badge key={mark} variant="outline" className="border-attention/50 text-attention">
                {mark}
              </Badge>
            ))}
            <span className="ml-auto flex items-center gap-3 text-meta text-muted-foreground">
              {file.status}
              {file.binary ? "binary" : <Counts added={file.added} removed={file.removed} />}
            </span>
          </div>
          <CollapsibleContent>
            <Diff path={file.path} state={diffs[file.path]} />
          </CollapsibleContent>
        </Collapsible>
      ))}
    </Card>
  );
}

/** One line per stored step of the agent's work: the tool it used, or what it said. */
function ActivityList({ events }: { events: readonly StoredEvent[] }) {
  const lines = events.flatMap((event): { id: number; tool: string | null; text: string | null }[] => (event.payload.type === "tool_call" ? [{ id: event.id, tool: event.payload.name, text: null }] : event.payload.type === "text" ? [{ id: event.id, tool: null, text: event.payload.text }] : []));
  if (lines.length === 0) return <p className="px-5 py-3 text-meta text-muted-foreground">Nothing is stored of this task's work.</p>;
  return (
    <ol data-testid="activity-list" className="divide-y border-t">
      {lines.map((line) => (
        <li key={line.id} className="px-5 py-2 text-meta">
          {line.tool !== null ? <code data-ds-content="">{line.tool}</code> : <span data-ds-content="" className="whitespace-pre-wrap text-muted-foreground">{line.text}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The agent's own last words as a quotation, with no mark of success, then its activity folded away under one line that counts it. */
function Activity({ task, events, open = false }: { task: TaskDetail; events: readonly StoredEvent[]; open?: boolean }) {
  const agent = agentName(task.builder);
  const said = events.findLast((event) => event.payload.type === "text")?.payload;
  const { steps, ms } = activityLine(events);
  return (
    <Card data-testid="activity" className="gap-0 bg-transparent py-0">
      {said?.type === "text" && (
        <Claim kind="agent">
          <blockquote data-testid="agent-said" data-ds-content="" className="line-clamp-4 border-l-2 border-edge pl-3 text-base whitespace-pre-wrap">
            {said.text}
          </blockquote>
          <p className="mt-1 text-meta text-muted-foreground">{`${agent}'s own words`}</p>
        </Claim>
      )}
      <Collapsible defaultOpen={open} className={said?.type === "text" ? "border-t" : undefined}>
        <CollapsibleTrigger render={<Button variant="ghost" className="group/activity h-auto min-h-(--control) w-full justify-start rounded-none px-5 font-normal" />}>
          <ChevronRight aria-hidden="true" className="transition-transform group-data-panel-open/activity:rotate-90" />
          <span className="font-semibold">{`What ${agent} did`}</span>
          <span data-testid="activity-count" className="ml-auto text-meta text-muted-foreground tabular-nums">
            {`${counted(steps, "step", "steps")}${ms > 0 ? `, ${duration(ms, "short").words}` : ""}`}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ActivityList events={events} />
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/** What nothing verified, on a dashed card with no fill: here, how the branch stands against main as it is now. */
function Limitation({ task }: { task: TaskDetail }) {
  // Only when main has commits the branch lacks: a branch that holds everything on main has nothing unverified here.
  const behind = task.status === "awaiting_decision" && (task.mainUpdate.behind ?? 0) > 0 ? behindLine(task.mainUpdate) : null;
  const problem = task.status === "awaiting_decision" ? task.mainUpdate.problem : null;
  if (behind === null && problem === null) return null;
  return (
    <div data-testid="limitation" className="rounded-xl border border-dashed border-edge">
      <Claim kind="unverified">
        <p className="text-base">{behind ?? problem}</p>
        <p className="text-meta text-muted-foreground">The checks and the review saw the branch alone.</p>
      </Claim>
    </div>
  );
}

/** The rebuilt review of one task. `id` is the task; the old screen stays at the address without ?new=1. */
export default function ReviewScreen({ id, onSignedOut }: { id: number; onSignedOut: () => void }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const reads = useRef(0);
  const missing = useRef(false);

  /** Read the task as it stands, and its stored transcript. Only the newest read may set what the screen shows. */
  const load = useCallback((): void => {
    if (missing.current) return;
    const read = ++reads.current;
    getTask(id).then(
      (next) => {
        if (read !== reads.current) return;
        setTask(next);
        setProblem(null);
        for (const attempt of shownAttempts(next)) {
          getTranscript(attempt).then(
            (transcript) => setEvents((have) => mergeEvents(have, transcript.events)),
            (err: unknown) => err instanceof ApiError && err.status === 401 && onSignedOut(),
          );
        }
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (read !== reads.current) return;
        if (err instanceof ApiError && err.status === 404) {
          missing.current = true;
          return setProblem(`There is no task ${id}.`);
        }
        setProblem(err instanceof ApiError ? `The task could not be read. ${err.message}` : "The task could not be read: Botbench could not be reached.");
      },
    );
  }, [id, onSignedOut]);

  // The task is read again each time live updates come up and each time it reaches a new state.
  useEffect(() => {
    load();
    return openEventStream(0, {
      onEvent: () => {},
      onConnection: (connected) => connected && load(),
      onSignedOut,
      onTask: (announcement) => announcement.taskId === id && load(),
    });
  }, [id, load, onSignedOut]);

  const heading = useRef<HTMLHeadingElement>(null);
  const reviewable = task !== null && (task.status === "awaiting_decision" || task.decision !== null);
  useEffect(() => {
    document.title = tabTitle(`Task ${id}`);
  }, [id]);
  useEffect(() => {
    if (reviewable) arrive(heading.current);
  }, [reviewable]);

  const shown = useMemo(() => {
    const ids = new Set(task === null ? [] : shownAttempts(task));
    return events.filter((event) => ids.has(event.attemptId));
  }, [events, task]);

  // Any other state (working, checking, needs input, failed) is the old screen's: it has that state's own controls.
  if (task !== null && !reviewable) return <TaskScreen id={id} onSignedOut={onSignedOut} />;

  const title = taskTitle(id, task?.prompt ?? null);
  return (
    <NextShell
      open={task === null ? null : { title, href: `#/tasks/${id}?new=1` }}
      bar={
        <nav aria-label="Where this is" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <a href="#/work" className="inline-flex min-h-(--control-small) items-center text-muted-foreground hover:text-foreground">
            Work
          </a>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <span className="font-semibold">{`Task ${id}`}</span>
          {task !== null && (
            <>
              <Badge data-testid="task-state" variant="outline" className={task.status === "awaiting_decision" ? "border-transparent bg-attention-subtle text-attention" : "text-muted-foreground"}>
                {statusWord(task)}
              </Badge>
              <span data-ds-content="" className="ml-auto text-muted-foreground max-md:hidden">
                {folderName(task.repo)}
              </span>
            </>
          )}
        </nav>
      }
      aside={
        task !== null && (
          <aside aria-label="Decision" className="border-t bg-pane px-4 py-6 md:px-6 xl:min-h-svh xl:border-t-0 xl:border-l">
            <div className="mx-auto flex max-w-[47.5rem] flex-col gap-6 xl:sticky xl:top-6">
              <DecisionPanel task={task} onDecided={load} onSignedOut={onSignedOut} />
              <p data-testid="task-status" role="status" className="text-meta text-muted-foreground">
                {statusSentence(task)}
              </p>
            </div>
          </aside>
        )
      }
    >
        <main className="min-w-0 px-4 pt-4 pb-12 md:px-8">
          <div className="mx-auto flex max-w-[47.5rem] flex-col gap-6">
            <header className="flex flex-col gap-2">
              <h1 ref={heading} tabIndex={-1} data-ds-content={task === null ? undefined : ""} className="text-[1.5rem] leading-[1.875rem] font-bold tracking-tight text-balance outline-none md:text-title">
                {title}
              </h1>
              {task !== null && (
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
                  <span>{agentName(task.builder)}</span>
                  {task.branch !== null && (
                    <span>
                      {"Branch "}
                      <code data-testid="branch" data-ds-content="" className="break-all text-foreground">
                        {task.branch}
                      </code>
                    </span>
                  )}
                  {task.headCommit !== null && (
                    <span>
                      {"Commit "}
                      {/* The short form is what every sentence names; the whole of it is one hover or one Tab away. */}
                      <Tooltip>
                        <TooltipTrigger render={<code data-testid="commit" tabIndex={0} className="rounded-sm text-foreground" />}>{short(task.headCommit)}</TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-none">
                          <code data-testid="commit-whole">{task.headCommit}</code>
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  )}
                </p>
              )}
            </header>
            {problem !== null && (
              <p role="alert" className="rounded-xl border border-destructive/60 bg-destructive-subtle px-5 py-3 text-base text-destructive">
                {problem}
              </p>
            )}
            {task === null ? (
              problem === null && (
                <p role="status" className="text-base text-muted-foreground">
                  Reading the task.
                </p>
              )
            ) : (
              <Tabs defaultValue="review" className="gap-6">
                <TabsList variant="line" className="w-full justify-start gap-6 border-b p-0 group-data-horizontal/tabs:h-auto">
                  <TabsTrigger value="review" className="h-(--control) flex-none px-0 text-sm group-data-horizontal/tabs:after:bottom-[-1px] group-data-[variant=line]/tabs-list:after:bg-primary">
                    Review
                  </TabsTrigger>
                  <TabsTrigger value="activity" className="h-(--control) flex-none px-0 text-sm group-data-horizontal/tabs:after:bottom-[-1px] group-data-[variant=line]/tabs-list:after:bg-primary">
                    Activity
                    <span className="text-muted-foreground tabular-nums">{activityLine(shown).steps}</span>
                  </TabsTrigger>
                  <TabsTrigger value="files" className="h-(--control) flex-none px-0 text-sm group-data-horizontal/tabs:after:bottom-[-1px] group-data-[variant=line]/tabs-list:after:bg-primary">
                    Files
                    <span className="text-muted-foreground tabular-nums">{task.files?.length ?? 0}</span>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="review" className="flex flex-col gap-4">
                  <Verification task={task} />
                  <ChangedFiles task={task} onSignedOut={onSignedOut} />
                  <Limitation task={task} />
                  <Activity task={task} events={shown} />
                </TabsContent>
                <TabsContent value="activity" className="flex flex-col gap-4">
                  <Activity task={task} events={shown} open />
                </TabsContent>
                <TabsContent value="files" className="flex flex-col gap-4">
                  <ChangedFiles task={task} onSignedOut={onSignedOut} />
                </TabsContent>
              </Tabs>
            )}
          </div>
        </main>
    </NextShell>
  );
}
