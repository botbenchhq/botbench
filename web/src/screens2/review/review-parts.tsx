import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleCheck, CircleDashed, CircleX, Clock, LoaderCircle, Minus, X } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible";
import { cn } from "@/ui/lib/utils";
import { ApiError, getTaskDiff, type Evidence, type FileChange, type Refinement, type Review, type StoredEvent, type TaskDetail } from "../../api/client.ts";
import { agentName } from "../../app/chat.ts";
import { counted, duration, plural } from "../../app/format.ts";
import { CHECKS_LINE, checksSummary, commandResult, fixesWords, latestRound, REVIEW_LINE, reviewerWords, verdictWords } from "../../components/evidence.tsx";
import { MarkdownView } from "../../components/markdown-view.tsx";
import { reviewDiffLine } from "../../components/review-diff-words.ts";
import { fileMarks } from "../../components/task-status.ts";
import { diffRows } from "./review-model.ts";

/*
 * The parts of a task's review (ADR 0012, board V2Review), drawn by the task's screen (screens2/task/task-screen.tsx)
 * once the task is ready for review or decided: the verification result with its kinds of claim, the reviewer's
 * findings when its run has a reviewer, and the changed files with their diffs. Everything shown is read through the
 * API client; every sentence about the evidence is the server's.
 */

export const short = (commit: string): string => commit.slice(0, 7);

/** The label of a claim: what kind of claim the row beside it is. Not pressable. A check is filled, a model's or an agent's words outlined, what nothing verified dashed. */
export function ClaimLabel({ kind }: { kind: "check" | "review" | "agent" | "unverified" }) {
  const words = { check: "Check", review: "Review", agent: "Agent said", unverified: "Not verified" }[kind];
  return (
    <span className={cn("inline-flex h-5 w-fit items-center rounded-sm border px-1.5 text-xs", kind === "check" ? "border-transparent bg-fill font-semibold text-foreground" : "font-medium text-muted-foreground", kind === "unverified" && "border-dashed border-edge")}>
      {words}
    </span>
  );
}

/** One claim: its label in a column of its own, then the claim. */
export function Claim({ kind, children }: { kind: "check" | "review" | "agent" | "unverified"; children: ReactNode }) {
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
 * The reviewer's findings, round by round: each review's verdict, what it says it checked, and its own words, then the
 * round of fixes that answered it. The texts are a model's, shown as text: the safe markdown subset makes no link,
 * image or element the text names. A review or a round that did not happen says why.
 */
function ReviewRounds({ reviews, refinements }: { reviews: readonly Review[]; refinements: readonly Refinement[] }) {
  return (
    <ol data-testid="review-rounds" className="mt-3 flex flex-col gap-4 border-t pt-3">
      {reviews.map((review) => {
        const fix = refinements.find((r) => r.round === review.round);
        return (
          <li key={review.id} data-testid="review-round" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{`Review ${review.round}`}</h3>
            {review.outcome !== "reviewed" ? (
              <p data-testid="review-problem" className="text-meta text-attention">
                {review.problem ?? "There is no review."}
              </p>
            ) : (
              <>
                <p data-testid="review-verdict" className="text-meta">
                  {verdictWords(review)}
                  <span className="text-muted-foreground">{`, in ${duration(review.durationMs, "units").words}`}</span>
                </p>
                {review.accountNote !== null ? (
                  <p data-testid="review-no-account" className="text-meta text-muted-foreground">
                    {review.accountNote}
                  </p>
                ) : (
                  <ul data-testid="review-checked" data-ds-content="" className="list-disc pl-5 text-meta text-muted-foreground">
                    {review.checked.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
                {/* How much of the change the reviewer was sent: said before its words, so a review of a cut diff is read as one. */}
                {reviewDiffLine(review) !== null && (
                  <p data-testid="review-diff" className="text-meta text-muted-foreground">
                    {reviewDiffLine(review)}
                  </p>
                )}
                <MarkdownView text={review.text} className="flex flex-col gap-2 rounded-md bg-sunken p-3 text-meta break-words" testId="review-text" />
              </>
            )}
            {fix !== undefined && (
              <div data-testid="fixes-round" className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{`${agentName("claude-code")}'s fixes ${fix.round}`}</h3>
                {fix.outcome !== "finished" ? (
                  <p data-testid="fixes-problem" className="text-meta text-attention">
                    {fix.problem ?? "This round of fixes did not finish."}
                  </p>
                ) : (
                  <>
                    <p data-testid="fixes-summary" className="text-meta">
                      {fixesWords(fix)}
                      {fix.changed && fix.headCommit !== null && <span className="text-muted-foreground">{`. Committed as ${short(fix.headCommit)}, and the checks ran again on it.`}</span>}
                    </p>
                    <pre data-testid="fixes-text" data-ds-content="" tabIndex={0} className="max-h-80 overflow-auto rounded-md bg-sunken p-3 whitespace-pre-wrap text-foreground">
                      {fix.reply === "" ? "(No reply.)" : fix.reply}
                    </pre>
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The verification result: one mark, the checks' count as the heading, and under it the server's own sentence about
 * whether that evidence is about the commit Accept would keep. Then one row per claim. The mark is green only when the
 * checks passed on the commit under review.
 */
export function Verification({ task }: { task: TaskDetail }) {
  const state = task.evidenceState;
  const rows = latestRound(task.evidence.filter((row) => row.kind === "check"));
  const lists = task.commandLists.filter((list) => list.kind === "check");
  const total = lists.find((list) => list.round === rows[0]?.round)?.total;
  // Once decided there is no evidence state: the checks are shown as they were recorded, in the neutral tone.
  const current = state?.state === "current";
  const running = task.status === "verifying";
  const look = running ? "running" : state === null ? "plain" : state.state === "none" ? "none" : !current ? "attention" : state.checks === "passed" ? "passed" : "failed";
  const Mark = { passed: Check, failed: X, attention: Clock, none: CircleDashed, plain: Minus, running: LoaderCircle }[look];
  const heading = running ? (task.checkingAgain ? "The checks are running again" : "The checks are running") : task.checks === null ? "No checks ran on this work" : task.checks === "none" ? "No checks are set up for this repository" : checksSummary(rows, { one: "check", many: "checks" }, Math.max(total ?? rows.length, rows.length)).replace(/\.$/, "");
  const review = task.review ?? null;
  return (
    <Card data-testid="verification" className="gap-0 py-0">
      <div className="flex items-start gap-4 p-5">
        <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", { passed: "bg-success-subtle text-success", failed: "bg-destructive-subtle text-destructive", attention: "bg-attention-subtle text-attention", none: "border border-dashed border-edge text-muted-foreground", plain: "bg-fill text-muted-foreground", running: "bg-primary-subtle text-primary" }[look])}>
          <Mark className={cn("size-5", running && "motion-safe:animate-spin")} />
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
            <Collapsible>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p data-testid="review-by" className="min-w-0 text-base">
                  <span className="font-semibold">{reviewerWords(review)}</span>
                  {task.reviewLine !== null && <span data-testid="review-outcome" className="text-muted-foreground">{` ${task.reviewLine}`}</span>}
                </p>
                <CollapsibleTrigger data-testid="review-detail" render={<Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" />}>
                  The full review
                </CollapsibleTrigger>
              </div>
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
              <CollapsibleContent>
                <ReviewRounds reviews={task.reviews} refinements={task.refinements} />
              </CollapsibleContent>
            </Collapsible>
            {task.status === "reviewing" && <p role="status" className="mt-1 text-meta text-muted-foreground">{`${agentName(task.reviewer.agent)} is reading the changes again.`}</p>}
          </Claim>
        ) : task.reviewer !== null && task.status === "reviewing" ? (
          <Claim kind="review">
            <p data-testid="review-by" className="text-base font-semibold">
              {reviewerWords(task.reviewer)}
            </p>
            <p role="status" className="text-meta text-muted-foreground">{`${agentName(task.reviewer.agent)} is reading the changes. ${REVIEW_LINE}`}</p>
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
  // Prose (by its extension) wraps to the screen's width; code keeps its lines whole and scrolls sideways inside its diff.
  const prose = /\.(md|txt)$/i.test(path);
  return (
    <>
      <pre data-testid="diff" data-prose={prose || undefined} tabIndex={0} role="group" aria-label={`Changes in ${path}`} data-ds-content-label="" data-ds-content="" className="overflow-x-auto border-t bg-sunken py-2">
        <code className={cn("grid", !prose && "min-w-max")}>
          {diffRows(state.diff).map((row, i) => {
            const Line = row.kind === "added" ? "ins" : row.kind === "removed" ? "del" : "span";
            return (
              <Line key={i} data-line={row.kind} className={cn("grid grid-cols-[3rem_1.5rem_minmax(0,1fr)] px-2 no-underline", row.kind === "added" && "bg-success-subtle text-success", row.kind === "removed" && "bg-destructive-subtle text-destructive", (row.kind === "hunk" || row.kind === "note") && "text-muted-foreground")}>
                <span className="pr-2 text-right tabular-nums select-none">{row.number ?? ""}</span>
                <span>{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span>
                <span data-text="" className={prose ? "break-words whitespace-pre-wrap" : "whitespace-pre"}>{row.text}</span>
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
export function ChangedFiles({ task, onSignedOut }: { task: TaskDetail; onSignedOut: () => void }) {
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

/** The agent's own last words as a quotation, with no mark of success: its claim, not a check. */
export function AgentSaid({ builder, events }: { builder: string; events: readonly StoredEvent[] }) {
  const said = events.findLast((event) => event.payload.type === "text")?.payload;
  if (said?.type !== "text") return null;
  return (
    <div data-testid="agent-said-card" className="rounded-xl border">
      <Claim kind="agent">
        <blockquote data-testid="agent-said" data-ds-content="" className="line-clamp-4 border-l-2 border-edge pl-3 text-base whitespace-pre-wrap">
          {said.text}
        </blockquote>
        <p className="mt-1 text-meta text-muted-foreground">{`${agentName(builder)}'s own words, not a check.`}</p>
      </Claim>
    </div>
  );
}
