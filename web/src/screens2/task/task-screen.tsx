import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Circle, CircleDot, Copy } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Separator } from "@/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/ui/lib/utils";
import { ApiError, getTask, getTranscript, openEventStream, type StoredEvent, type TaskDetail } from "../../api/client.ts";
import { ApprovalsContext } from "../../app/approvals.tsx";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { agentName } from "../../app/chat.ts";
import { folderName } from "../../app/composer.ts";
import { duration } from "../../app/format.ts";
import { sessionAgent, sessionsLine, shownAttempts } from "../../app/handoff-words.ts";
import { PeerCardsContext } from "../../app/peer-cards.tsx";
import { overlapLines } from "../../app/peers.ts";
import { MODE_NAMES, modeSentence } from "../../app/run-words.ts";
import { ApprovalQueue } from "../decision/decision-surface.tsx";
import { copyWords } from "../../components/decision.tsx";
import { CommandRounds, MachineChecksNote, latestRound, reviewerWords } from "../../components/evidence.tsx";
import { modelName, useModelList } from "../../components/model-picker.tsx";
import { usePeersOf } from "../../components/other-workbenches.tsx";
import { OutsideText } from "../../components/outside-text.tsx";
import { DraftPeerCard } from "../../components/peer-card.tsx";
import { fileMarksLine, statusSentence, statusWord, taskTitle, waitingWords } from "../../components/task-status.ts";
import { mergeEvents } from "../../components/transcript.tsx";
import { readStory } from "../../components/transcript-story.ts";
import { oldestCommand, runningCommands, runningWords } from "../../../../src/engine/command-limit.ts";
import { DecisionBar, DecisionPanel, RejectDialog, useDecision } from "../review/decision-panel.tsx";
import { activityLine } from "../review/review-model.ts";
import { AgentSaid, ChangedFiles, Claim, Verification } from "../review/review-parts.tsx";
import { InspectorButton, NextShell } from "../../shell/shell.tsx";
import { TaskMore, taskName } from "./legacy.tsx";
import { Narrative, Running } from "./narrative.tsx";
import { DiscardDialog, Kept, RecoveryCard, ResumeButton, ResumeNote, useDiscard, useResume } from "./recovery.tsx";
import { MainUpdate, MoveControl, NoteBox, Problem, StopControl, useStop } from "./steer.tsx";
import { filesTouched, reasonParts, stages, viewOf } from "./task-model.ts";

/*
 * A task's screen, rebuilt on shadcn/ui and Tailwind 4 (ADR 0012): the one screen at a task's address, in whatever
 * state the task is. A task that is ready for review, or decided, is its review (board V2Review, with the states of
 * its evidence as the server reports them). One that is on its way is its activity as a narrative, with a note for its
 * agent and Stop (V2Executing). One that ended with nothing to review is its recovery, Resume first (V2Failed). A
 * request that waits for the owner's answer comes first in any of them, on the approval card every screen shares.
 * Everything shown is read through the API client, and every control is one the server offers for the task as it is.
 */

const short = (commit: string): string => commit.slice(0, 7);
const TAB = "h-(--control) flex-none px-0 text-sm group-data-horizontal/tabs:after:bottom-[-1px] group-data-[variant=line]/tabs-list:after:bg-primary";

/** The colours of a state's badge: amber only for what waits on the owner, red for a failure, blue for work under way. */
function stateTone(task: TaskDetail): string {
  if (task.status === "awaiting_decision" || (task.status === "building" && task.waitingOnApproval)) return "border-transparent bg-attention-subtle text-attention";
  if (task.status === "failed") return "border-transparent bg-destructive-subtle text-destructive";
  if (task.status === "building" || task.status === "verifying" || task.status === "reviewing") return "border-transparent bg-primary-subtle text-primary";
  return "text-muted-foreground";
}

/** The facts of the task, at the foot of its pane. */
function Facts({ task, model }: { task: TaskDetail; model: string | null }) {
  const rows = [
    { name: "Mode", value: MODE_NAMES[task.mode], theirs: false },
    { name: "Agent", value: agentName(task.builder), theirs: false },
    ...(model === null ? [] : [{ name: "Model", value: model, theirs: false }]),
    { name: "Reviewer", value: task.reviewer === null ? "None" : reviewerWords(task.review ?? task.reviewer), theirs: false },
    { name: "Repository", value: folderName(task.repo), theirs: true, whole: task.repo },
  ];
  return (
    <section aria-label="This task">
      <h2 className="mb-1 text-meta font-semibold text-muted-foreground">This task</h2>
      <dl data-testid="task-facts" className="flex flex-col text-sm">
        {rows.map((row, i) => (
          <div key={row.name}>
            {i > 0 && <Separator />}
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">{row.name}</dt>
              <dd data-ds-content={row.theirs ? "" : undefined} title={"whole" in row ? row.whole : undefined} className="min-w-0 text-right break-words">
                {row.value}
              </dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The stages of a task on its way, the one it is at marked, with the server's sentence about where it stands. */
function Progress({ task }: { task: TaskDetail }) {
  return (
    <section aria-label="Progress" data-testid="progress">
      <h2 className="mb-2 text-meta font-semibold text-muted-foreground">Progress</h2>
      <ol className="flex flex-col">
        {stages(task).map((stage, i, all) => {
          const Mark = stage.state === "done" ? Check : stage.state === "now" ? CircleDot : Circle;
          return (
            <li key={stage.name} data-state={stage.state} className="flex gap-3">
              <span className="flex flex-col items-center">
                <Mark aria-hidden="true" className={cn("size-5 shrink-0", stage.state === "now" ? "text-primary" : "text-muted-foreground")} />
                {i < all.length - 1 && <span aria-hidden="true" className="my-1 w-px flex-1 bg-border" />}
              </span>
              <span className={cn("flex min-w-0 flex-col pb-4 text-sm", stage.state === "now" ? "font-semibold" : "text-muted-foreground")}>
                {stage.name}
                <span className="sr-only">{stage.state === "done" ? ", done" : stage.state === "now" ? ", now" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** `discard`: the owner chose Discard from the task's menu on Work, so its confirmation opens once the task is read. */
export default function TaskScreen({ id, discard = false, onSignedOut }: { id: number; discard?: boolean; onSignedOut: () => void }) {
  // The address goes back to the task's own, so a reload or Back does not ask again.
  useEffect(() => {
    if (discard) window.history.replaceState(null, "", `#/tasks/${id}`);
  }, [discard, id]);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [tab, setTab] = useState("review");
  const reads = useRef(0);
  const missing = useRef(false);
  const models = useModelList(onSignedOut);

  /** Read the task as it stands, and its stored transcript. Only the newest read may set what the screen shows. */
  const load = useCallback((): void => {
    if (missing.current) return;
    const read = ++reads.current;
    const failed = (what: string) => (err: unknown): void => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      if (read !== reads.current) return;
      setProblem(err instanceof ApiError ? `${what} could not be read. ${err.message}` : `${what} could not be read: Botbench could not be reached.`);
    };
    getTask(id).then(
      (next) => {
        if (read !== reads.current) return;
        setTask(next);
        setProblem(null);
        // Stored events only ever add up, so a transcript is folded in whichever read fetched it. After a move to
        // another agent, the session each move left is read too, so the activity shows both agents.
        for (const attempt of shownAttempts(next)) getTranscript(attempt).then((transcript) => setEvents((have) => mergeEvents(have, transcript.events)), failed("The activity"));
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          missing.current = true;
          return setProblem(`There is no task ${id}.`);
        }
        failed("The task")(err);
      },
    );
  }, [id, onSignedOut]);

  // The stream is followed from now on. The task and its stored transcript are read each time the stream comes up and
  // each time the task reaches a new state, so nothing that happened in between is missed.
  useEffect(() => {
    load();
    return openEventStream(0, {
      onEvent: (event) => setEvents((have) => mergeEvents(have, [event])),
      onConnection: (isConnected) => {
        if (isConnected) load();
      },
      onSignedOut,
      onTask: (announcement) => announcement.taskId === id && load(),
    });
  }, [id, load, onSignedOut]);

  // This task's requests that wait for an answer, oldest first. One card at a time: the oldest.
  const { pending } = useContext(ApprovalsContext);
  const peerCards = useContext(PeerCardsContext).cards;
  const waiting = useMemo(() => (pending ?? []).filter((approval) => approval.taskId === id), [pending, id]);
  const asking = waiting[0];
  // The task starts and stops waiting as its requests come and go, so it is read again when they do.
  useEffect(() => load(), [load, asking?.id]);
  const drafts = (peerCards ?? []).filter((card) => card.direction === "out" && card.taskId === id);

  const heading = useRef<HTMLHeadingElement>(null);
  const activity = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.title = tabTitle(`Task ${id}`);
  }, [id]);
  // The heading is there from the first paint (the task's number until it is read), so an arrival is taken at once.
  useEffect(() => arrive(heading.current), []);

  const attemptId = task?.attemptId ?? null;
  const shownIds = useMemo(() => (task === null ? [] : shownAttempts(task)).join(","), [task]);
  const shown = useMemo(() => {
    const ids = new Set(shownIds.split(",").filter((part) => part !== "").map(Number));
    return events.filter((event) => ids.has(event.attemptId));
  }, [events, shownIds]);
  // The session the task names now: what is said of the agent at work is read from it alone.
  const current = useMemo(() => shown.filter((event) => event.attemptId === attemptId), [shown, attemptId]);

  // Between the end of the agent's reply and Botbench's commit the task is still at work, but its agent is not. With
  // the owner's note sent as the next message, the reply still to end is the note's.
  const lastSent = current.findLastIndex((event) => event.type === "user_prompt");
  const turnOn = task?.status === "building" && !task.resuming && attemptId !== null && !current.slice(Math.max(lastSent, 0)).some((event) => event.type === "turn_ended");
  // The command the agent is running now, which may print nothing for minutes: the line says which, and for how long.
  const command = turnOn ? oldestCommand(runningCommands(current)) : null;
  const since = turnOn ? (current[Math.max(lastSent, 0)]?.ts ?? null) : null;

  const d = useDecision(task, load, onSignedOut);
  const s = useStop(task, load, onSignedOut);
  const r = useResume(task, load, onSignedOut);
  const x = useDiscard(task, discard, load, onSignedOut);
  const [noting, setNoting] = useState(false);
  const draft = useState("");
  // At review time: another workbench's open pull request that changes the same files, from the short-lived view of the remote.
  const peers = usePeersOf(task?.status === "awaiting_decision" ? task.repo : "", onSignedOut);
  const overlaps = task?.status === "awaiting_decision" && task.files !== null ? overlapLines(peers, task.files.map((file) => file.path)) : [];

  const view = task === null ? null : viewOf(task);
  // A task that reaches its review, or leaves it, starts on that view's first tab.
  useEffect(() => setTab(view === "review" ? "review" : "activity"), [view]);
  const inspect = (): void => {
    setTab("activity");
    requestAnimationFrame(() => {
      activity.current?.scrollIntoView({ block: "start" });
      activity.current?.focus();
    });
  };

  const title = taskTitle(id, task?.prompt ?? null);
  const steps = activityLine(shown).steps;
  const who = (attempt: number): string | null => (task === null ? null : sessionAgent(task, attempt));
  const model = task === null || task.requestedModel === null ? null : modelName(models, task.requestedModel);
  const sessions = task === null ? null : sessionsLine(task.builder, task.earlierAttempts, task.handoffs.length > 0);
  const touched = useMemo(() => (task === null ? [] : filesTouched(current, readStory(current, true), task.id)), [current, task?.id]);
  const checkRows = task === null ? [] : task.evidence.filter((row) => row.kind === "check");
  const checkRounds = task === null ? 0 : task.commandLists.filter((list) => list.kind === "check").length;

  const narrative = task !== null && (
    <div ref={activity} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      {sessions !== null && (
        <p data-testid="earlier-sessions" className="text-meta text-muted-foreground">
          {sessions}
        </p>
      )}
      {task.handoffs.map((handoff) => (
        <p key={handoff.at} data-testid="handoff-line" role="note" className="text-meta text-muted-foreground">
          {handoff.line}
        </p>
      ))}
      {shown.length === 0 && attemptId === null ? (
        <ol className="flex flex-col">
          <li className="max-w-[85%] self-end rounded-xl bg-fill px-4 py-3 text-base">
            <span className="sr-only">You: </span>
            <span data-testid="task-prompt" data-ds-content="" className="break-words whitespace-pre-wrap">
              {task.prompt}
            </span>
          </li>
        </ol>
      ) : (
        <Narrative events={shown} live={turnOn} who={who} builder={task.builder}>
          {task.status === "waiting_for_limit" && (
            <li data-testid="usage-limit-wait" role="status" className="text-meta text-muted-foreground">
              {waitingWords(task.retryAt)}
            </li>
          )}
          {turnOn && asking === undefined && (
            <li data-testid="working" className="flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
              <CircleDot aria-hidden="true" className="size-3.5 text-primary motion-safe:animate-pulse" />
              <span role="status">{command !== null ? runningWords(agentName(task.builder), command, Date.now(), (ms) => duration(ms, "short").words).line : `${agentName(task.builder)} is working.`}</span>
              {command !== null && <RunningFor agent={agentName(task.builder)} command={command} />}
            </li>
          )}
        </Narrative>
      )}
    </div>
  );

  const checks = task !== null && (
    <>
      <Verification task={task} />
      {task.checkFixLine !== null && (
        <p data-testid="check-fix-outcome" role="status" className="text-meta text-muted-foreground">
          {task.checkFixLine}
        </p>
      )}
      <MachineChecksNote rows={latestRound(checkRows)} />
      {(checkRounds > 1 || task.rerunRounds.length > 0) && (
        <details data-testid="check-rounds" className="ds-disclosure">
          <summary className="ds-disclosure__summary">Every round of checks</summary>
          <div className="ds-disclosure__content">
            <CommandRounds testId="checks" lists={task.commandLists} rows={checkRows} what={{ one: "check", many: "checks" }} failedFirst again={task.rerunRounds} />
          </div>
        </details>
      )}
    </>
  );

  const reason = task === null || task.reason === null ? null : reasonParts(task.reason);
  let body: ReactNode = null;
  let aside: ReactNode = null;
  let foot: ReactNode;
  if (task !== null && view === "review") {
    const note = task.status === "awaiting_decision" && (
      <>
        <Button variant="link" size="sm" data-testid="note-instead" className="self-center" aria-expanded={noting || task.waitingNote !== null} onClick={() => setNoting(!noting)}>
          {`Send ${agentName(task.builder)} a note instead`}
        </Button>
        {(noting || task.waitingNote !== null) && <NoteBox task={task} card={false} draft={draft} onChanged={load} onSignedOut={onSignedOut} />}
      </>
    );
    body = (
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="gap-6">
        <TabsList variant="line" className="w-full justify-start gap-6 border-b p-0 group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="review" className={TAB}>
            Review
          </TabsTrigger>
          <TabsTrigger value="activity" className={TAB}>
            Activity
            <span className="text-muted-foreground tabular-nums">{steps}</span>
          </TabsTrigger>
          <TabsTrigger value="files" className={TAB}>
            Files
            <span className="text-muted-foreground tabular-nums">{task.files?.length ?? 0}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="review" className="flex flex-col gap-4">
          {checks}
          {task.files !== null && fileMarksLine(task.files) !== null && (
            <p data-testid="file-marks" className="text-meta text-attention">
              {fileMarksLine(task.files)}
            </p>
          )}
          <ChangedFiles task={task} onSignedOut={onSignedOut} />
          <MainUpdate task={task} onChanged={load} onSignedOut={onSignedOut} />
          {overlaps.map((line) => (
            <p key={line} data-testid="peer-overlap" className="text-meta text-muted-foreground">
              {line}
            </p>
          ))}
          <AgentSaid builder={task.builder} events={shown} />
          {/* Without the decision panel there would be no way to a note on a narrow screen: the note's own states are said here too. */}
          {task.status !== "awaiting_decision" && <NoteBox task={task} draft={draft} onChanged={load} onSignedOut={onSignedOut} />}
        </TabsContent>
        <TabsContent value="activity" className="flex flex-col gap-4">
          {narrative}
        </TabsContent>
        <TabsContent value="files" className="flex flex-col gap-4">
          <ChangedFiles task={task} onSignedOut={onSignedOut} />
        </TabsContent>
      </Tabs>
    );
    aside = (
      <>
        <DecisionPanel task={task} d={d}>
          {note}
        </DecisionPanel>
        <Facts task={task} model={model} />
      </>
    );
    foot = (
      <DecisionBar task={task} d={d} more={<InspectorButton quiet={task.decision === null}>{task.decision === null ? "More" : "The decision"}</InspectorButton>} />
    );
  } else if (task !== null && view === "recovery") {
    body = (
      <>
        <Card data-testid="what-happened" className="gap-0 py-0">
          <div className="flex flex-col gap-1 p-5">
            <h2 className="text-base font-semibold">
              <span data-testid="task-reason">{reason?.what ?? { failed: "This task failed, and no reason was recorded.", interrupted: "This task was stopped before it finished.", cancelled: "Its run was cancelled.", drafted: "It changed no file and drafted a message for another workbench." }[task.status as "failed" | "interrupted" | "cancelled" | "drafted"]}</span>
            </h2>
            <p className="text-base text-muted-foreground">
              {task.remains?.discardedAt != null ? "What it left was discarded." : task.resumeNote !== null ? "Nothing is lost: what it left is kept, and it can be resumed from where it stopped." : task.remains !== null && (task.remains.copy || task.remains.branch) ? "There is nothing to review. What it left is kept until you discard it." : "There is nothing to review."}
            </p>
          </div>
          {reason?.said != null && (
            <div className="border-t">
              <Claim kind="agent">
                <blockquote data-testid="agent-said" data-ds-content="" className="line-clamp-6 border-l-2 border-edge pl-3 text-base whitespace-pre-wrap">
                  {reason.said}
                </blockquote>
                <p className="mt-1 text-meta text-muted-foreground">{`${agentName(task.builder)}'s last message: its own words, not a check.`}</p>
              </Claim>
            </div>
          )}
        </Card>
        {reason?.said == null && <AgentSaid builder={task.builder} events={shown} />}
        {task.files !== null && task.files.length > 0 && <ChangedFiles task={task} onSignedOut={onSignedOut} />}
        {checkRows.length > 0 && checks}
        <section aria-label={`What ${agentName(task.builder)} did`} className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{`What ${agentName(task.builder)} did`}</h2>
          {narrative}
        </section>
        {checkRows.length === 0 && task.review === null && (
          <div data-testid="not-verified" className="rounded-xl border border-dashed border-edge">
            <Claim kind="unverified">
              <p className="text-base">No checks ran on this work, and no reviewer read it.</p>
              <p className="text-meta text-muted-foreground">{`Botbench runs this repository's checks only on work it has committed for review. A command above is ${agentName(task.builder)}'s own, not a check.`}</p>
            </Claim>
          </div>
        )}
        <NoteBox task={task} draft={draft} onChanged={load} onSignedOut={onSignedOut} />
      </>
    );
    aside = (
      <>
        <RecoveryCard task={task} r={r} onInspect={inspect} />
        <Kept task={task} steps={steps} x={x} />
        <Facts task={task} model={model} />
      </>
    );
    foot = (
      <>
        {r.problem !== null && <Problem>{r.problem}</Problem>}
        {r.offered && task.resumeTakesNote && <ResumeNote task={task} r={r} rows={1} />}
        <div className="flex gap-2">
          {r.offered && <ResumeButton r={r} className="flex-[2]" />}
          <InspectorButton className="flex-1">{!r.offered && task.remains !== null && (task.remains.copy || task.remains.branch) ? "What is kept" : "Details"}</InspectorButton>
        </div>
      </>
    );
  } else if (task !== null) {
    body = (
      <>
        {(task.status === "verifying" || task.status === "reviewing" || (checkRows.length > 0 && task.status !== "queued")) && checks}
        {task.status === "building" && task.reviewer !== null && !task.onNoteRound && task.reviews.length > task.refinements.length && (
          <p role="status" data-testid="fixes-working" className="text-meta text-muted-foreground">{`${agentName(task.builder)} is working on fixes: round ${task.reviews.length} of up to ${task.maxRefineRounds}.`}</p>
        )}
        {narrative}
        {asking === undefined && turnOn && <p className="text-meta text-muted-foreground">Nothing needs you right now.</p>}
        <NoteBox task={task} draft={draft} onChanged={load} onSignedOut={onSignedOut} />
        <MainUpdate task={task} onChanged={load} onSignedOut={onSignedOut} />
      </>
    );
    aside = (
      <>
        <Progress task={task} />
        {touched.length > 0 && (
          <section aria-label="Files touched so far" data-testid="files-touched">
            <h2 className="mb-1 text-meta font-semibold text-muted-foreground">Files touched so far</h2>
            <ul className="flex flex-col text-sm">
              {touched.map((file, i) => (
                <li key={file.path}>
                  {i > 0 && <Separator />}
                  <div className="flex justify-between gap-4 py-2.5">
                    <code data-ds-content="" className="min-w-0 break-all text-foreground">
                      {file.path}
                    </code>
                    <span className="text-meta text-muted-foreground">{file.did}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-meta text-muted-foreground">{`From ${agentName(task.builder)}'s own edits. Not committed yet: Botbench commits when ${agentName(task.builder)} finishes.`}</p>
          </section>
        )}
        {(task.moveTo.length > 0 || s.offered || s.problem !== null) && (
          <section aria-label="Steer" className="flex flex-col gap-3">
            <h2 className="text-meta font-semibold text-muted-foreground">Steer</h2>
            <MoveControl task={task} onMoved={load} onSignedOut={onSignedOut} />
            <StopControl task={task} s={s} />
          </section>
        )}
        <Facts task={task} model={model} />
      </>
    );
    foot = (
      <>
        {s.problem !== null && <Problem testId="stop-refused-foot">{s.problem}</Problem>}
        <div className="flex items-center gap-2">
        {s.offered && (
          <Button variant="outline" aria-busy={s.busy || undefined} onClick={s.stop}>
            {s.busy ? "Stopping" : "Stop"}
          </Button>
        )}
        <InspectorButton className="flex-1">Details</InspectorButton>
        </div>
      </>
    );
  }

  return (
    <NextShell
      open={task === null ? null : { title, href: `#/tasks/${id}` }}
      asideLabel={view === "review" ? "Decision" : view === "recovery" ? "Recovery" : "Details"}
      bar={
        <nav aria-label="Where this is" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <a href="#/work" className="inline-flex min-h-(--control-small) items-center text-muted-foreground hover:text-foreground">
            Work
          </a>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          {task === null ? (
            <span className="font-semibold">{`Task ${id}`}</span>
          ) : (
            <>
              <span data-testid="task-name" className="min-w-0 truncate font-semibold">
                {`Task ${id} · `}
                <span data-ds-content="">{taskName(task).slice(`Task ${id} · `.length)}</span>
              </span>
              <Badge data-testid="task-state" variant="outline" className={stateTone(task)}>
                {statusWord(task)}
              </Badge>
            </>
          )}
        </nav>
      }
      aside={
        task !== null && (
          <aside aria-label={view === "review" ? "Decision" : view === "recovery" ? "Recovery" : "Details"} className="bg-pane px-4 py-6 md:px-6 lg:min-h-svh lg:border-l">
            <div className="mx-auto flex max-w-[47.5rem] flex-col gap-6 lg:sticky lg:top-6">{aside}</div>
          </aside>
        )
      }
      foot={task === null ? undefined : foot}
    >
      <main className="min-w-0 px-4 pt-4 pb-12 md:px-6 min-[1440px]:px-8">
        <div className="mx-auto flex max-w-[47.5rem] flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h1 ref={heading} tabIndex={-1} data-ds-content={task === null ? undefined : ""} className="text-[1.5rem] leading-[1.875rem] font-bold tracking-tight text-balance outline-none md:text-title">
              {title}
            </h1>
            {task !== null && (
              <>
                <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground">
                  <span>{agentName(task.builder)}</span>
                  {/* A branch that is gone is not named: discarded with what a stopped task left, or deleted by a Reject. */}
                  {task.branch !== null && task.remains?.discardedAt == null && task.decision?.branch !== "deleted" && (
                    <span className="inline-flex flex-wrap items-center gap-x-1.5">
                      {"Branch "}
                      <code data-testid="branch" data-ds-content="" className="break-all text-foreground">
                        {task.branch}
                      </code>
                      <CopyBranch branch={task.branch} />
                    </span>
                  )}
                  {task.headCommit !== null && view === "review" && (
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
                  {since !== null && <Running since={since} />}
                </p>
                {/* On the recovery view the card below says the same reason, apart from the agent's own words: the sentence stays for a screen reader's status. */}
                <p data-testid="task-status" role="status" className={view === "recovery" ? "sr-only" : "text-base text-muted-foreground"}>
                  {statusSentence(task)}
                </p>
                {task.ofPlan !== null && (
                  <p data-testid="task-mode" className="text-meta text-muted-foreground">
                    {modeSentence(task.mode, task.issueHosts)}
                  </p>
                )}
                {task.restartLine !== null && (
                  <p data-testid="task-restart" className="text-meta text-muted-foreground">
                    {task.restartLine}
                  </p>
                )}
              </>
            )}
          </header>
          {/* A request that waits for the owner comes first after the title: nothing else on the screen is as urgent. */}
          {task !== null && <ApprovalQueue waiting={waiting} on="task" onSignedOut={onSignedOut} />}
          {task !== null && drafts.map((card) => <DraftPeerCard key={card.messageId} card={card} primary={asking === undefined && task.status === "drafted" && drafts.length === 1} onSignedOut={onSignedOut} />)}
          {task !== null && task.outsideText && <OutsideText issue={task.issue} given={task.givenMessage} what="task" />}
          {problem !== null && <Problem>{problem}</Problem>}
          {task === null
            ? problem === null && (
                <p role="status" className="text-base text-muted-foreground">
                  Reading the task.
                </p>
              )
            : body}
          {task !== null && task.filesProblem !== null && view !== "review" && <Problem>{task.filesProblem}</Problem>}
          {task !== null && <TaskMore task={task} current={current} models={models} onChanged={load} onSignedOut={onSignedOut} />}
        </div>
      </main>
      <RejectDialog d={d} />
      {task !== null && <DiscardDialog task={task} x={x} />}
    </NextShell>
  );
}

/** The button that copies the task's branch name, beside it, and whether it was copied, in words. */
function CopyBranch({ branch }: { branch: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <>
      <Button variant="ghost" size="icon" className="size-(--control-small) text-muted-foreground" aria-label="Copy branch name" onClick={() => void copyWords(branch).then(setCopied)}>
        <Copy aria-hidden="true" />
      </Button>
      <span data-testid="branch-copy-state" role="status">
        {copied}
      </span>
    </>
  );
}

/** How long a command has run, ticking each second, against its own time limit (engine/command-limit.ts). */
function RunningFor({ agent, command }: { agent: string; command: NonNullable<ReturnType<typeof oldestCommand>> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span data-testid="running-for">{` ${runningWords(agent, command, now, (ms) => duration(ms, "short").words).time}`}</span>;
}
