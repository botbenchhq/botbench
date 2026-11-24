import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, Lock, TriangleAlert } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/ui/lib/utils";
import type { Approval, PullRequestTarget } from "../../api/client.ts";
import { counted, plural } from "../../app/format.ts";
import { approvalLevel, queueWords, type DecisionLevel } from "../../app/new-work.ts";
import { useApprovalAnswer } from "../../app/use-approval-answer.ts";
import { stepWord, times, visible } from "../../components/approval-card.tsx";
import { approvalWords, directoryWords, placeWords } from "../../components/tool-summary.ts";

/*
 * The decision surface: one component for every decision the owner is asked for, louder only as the consequence grows
 * (the approved "Five levels of decision").
 *
 *   routine      a neutral raised card: a task's review (screens2/review/decision-panel.tsx draws its own today, and can adopt `DecisionSurface`).
 *   approval     the same card with a small attention signal: an agent waits on a request. `ApprovalDecision`.
 *   risk         an attention edge and tint, and the consequence spelled out before the button: something leaves this
 *                Mac. `ApprovalDecision` for a fetch or a search of the web; `PullRequestDecision` for a pull request.
 *   destructive  a dialog with an error edge and a "Cannot be undone" band, the safe button first and focused. `DestructiveDialog`.
 *   refused      no approve action: what was refused, the rule, what the agent did next, and two links. `RefusedNotice`.
 *
 * Nothing here is answered by a single key: every answer is a button that is pressed. The requests and their answers
 * are the real ones (app/use-approval-answer.ts, the same client calls as components/approval-card.tsx).
 */

const FRAME: Record<DecisionLevel, string> = {
  routine: "border bg-card",
  approval: "border bg-card",
  risk: "border border-attention/60 bg-attention-subtle",
  destructive: "border border-destructive/70 bg-card",
  refused: "border bg-transparent",
};

/** The line above the title: what kind of decision this is, as a small signal with its mark. Amber is this mark and these words; the risk level alone adds its edge and a faint tint, as the approved board draws it. */
function Signal({ level, children }: { level: DecisionLevel; children: ReactNode }) {
  return (
    <p data-testid="decision-signal" className={cn("flex min-w-0 items-center gap-2 text-meta font-semibold", level === "routine" ? "text-muted-foreground" : level === "approval" || level === "risk" ? "text-attention" : "text-destructive")}>
      {level === "approval" && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention" />}
      {level === "risk" && <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />}
      {level === "destructive" && <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />}
      {level === "refused" && <Lock aria-hidden="true" className="size-4 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** What would run, or what is decided on, as it is: somebody else's text, in the code typeface, never cut. */
export function DecisionWhat({ children, testId, ours = false }: { children: string; testId?: string; ours?: boolean }) {
  return (
    <pre data-testid={testId} data-ds-content={ours ? undefined : ""} className="max-h-48 overflow-auto rounded-lg bg-sunken px-3 py-2.5 font-mono text-meta break-words whitespace-pre-wrap">
      {children}
    </pre>
  );
}

/**
 * The frame every level shares: the signal, the queue position with a way to the next, the title, then the body and
 * the actions the level gives it. `position` is this request's place among those waiting, when there are several.
 */
export function DecisionSurface({ level, signal, title, position, children, className, ...rest }: { level: DecisionLevel; signal: ReactNode; title: ReactNode; position?: { at: number; of: number; onNext: () => void } | undefined; children: ReactNode; className?: string } & Omit<React.ComponentProps<"section">, "title">) {
  const heading = useId();
  const queue = position === undefined ? null : queueWords(position.at, position.of);
  return (
    <section aria-labelledby={heading} data-level={level} className={cn("flex min-w-0 flex-col gap-3 rounded-xl p-4 *:shrink-0 md:p-5", FRAME[level], className)} {...rest}>
      <div className="flex items-center justify-between gap-3">
        <Signal level={level}>{signal}</Signal>
        {queue !== null && (
          <div className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
            <span data-testid="decision-queue">{queue}</span>
            <Button variant="ghost" size="icon" aria-label="Next request" className="size-(--control)" onClick={position!.onNext}>
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
      <h2 id={heading} tabIndex={-1} className="text-heading font-semibold tracking-tight outline-none">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A problem with the answer: what was not saved, and that nothing was allowed. */
function Problem({ children }: { children: string | null }) {
  return children === null ? null : (
    <p role="alert" data-testid="decision-problem" className="rounded-lg border border-destructive/60 bg-destructive-subtle px-3 py-2 text-meta text-destructive">
      {children}
    </p>
  );
}

/** A disclosure that is a real button: it opens by touch, by Enter and by Space, and says whether it is open. */
function Disclosure({ summary, testId, children }: { summary: string; testId?: string; children: ReactNode }) {
  return (
    <Collapsible data-testid={testId} className="border-t">
      <CollapsibleTrigger className="group flex min-h-(--control) w-full items-center gap-2 text-left text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** One named part of a disclosure: its name, then what it says. */
function Part({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <span className="text-meta font-semibold text-muted-foreground">{name}</span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

const MAX_ANSWER = 2000;

/** The lines a request from outside carries, whoever draws it: who asked, that outside text led to it, that it waited through a restart. */
function Provenance({ approval, what }: { approval: Approval; what: "request" | "question" }) {
  const peer = approval.askedBy?.by === "peer";
  const from = peer ? `work given a message from ${approval.askedBy.peerName === null ? "the paired workbench" : `${approval.askedBy.peerName}'s workbench`}, which another person wrote` : "a run that read a GitHub issue, which people outside this project wrote";
  const then = what === "question" ? "Answer it as you would answer them." : `Check the command for anything the ${peer ? "message" : "issue"} might have led to.`;
  return (
    <>
      {(approval.askedBy?.words ?? null) !== null && (
        <p data-testid="approval-asked-by" data-ds-content="" className="text-sm">
          {approval.askedBy.words}
        </p>
      )}
      {approval.outsideText && <p data-testid="approval-outside" className="text-sm">{`This ${what} comes from ${from}. ${then}`}</p>}
      {approval.parkedAt !== null && <p data-testid="approval-parked" className="text-sm">{`Asked before Botbench restarted. Claude Code is stopped; your answer starts it again where it left off, and counts only if it asks ${what === "question" ? "this question" : "for exactly this"} again.`}</p>}
    </>
  );
}

/**
 * One request that waits for the owner, at its level: what will run and where, Decline and Allow, its place in the
 * queue. A request that leaves this Mac (a fetch or a search of the web) is drawn as elevated risk, with what that means
 * before the buttons. `on` is the screen it is shown on, as on the card it replaces: a run's screen also names the task.
 * A question of Claude Code's is the same surface with its choices in place of Allow and Decline.
 */
export function ApprovalDecision({ approval, position, on, onSignedOut, className }: { approval: Approval; position?: { at: number; of: number; onNext: () => void }; on: "task" | "run" | "chat"; onSignedOut: () => void; className?: string }) {
  return approval.question !== null ? <QuestionDecision approval={approval} question={approval.question} position={position} on={on} onSignedOut={onSignedOut} className={className} /> : <PermissionDecision approval={approval} position={position} on={on} onSignedOut={onSignedOut} className={className} />;
}

type DecisionProps = { approval: Approval; position: { at: number; of: number; onNext: () => void } | undefined; on: "task" | "run" | "chat"; onSignedOut: () => void; className: string | undefined };

function PermissionDecision({ approval, position, on, onSignedOut, className }: DecisionProps) {
  const { sending, settled, problem, answer, grant } = useApprovalAnswer(approval, onSignedOut);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const id = useId();
  const level = approvalLevel(approval);
  const said = approvalWords(approval.tool, approval.command);
  const place = placeWords(approval);
  const offer = approval.standingOffer;
  const off = !settled || sending !== null;
  return (
    <DecisionSurface
      level={level}
      signal={level === "risk" ? "Leaves this Mac" : approval.parkedAt !== null ? "Claude Code is stopped" : "Claude Code is paused"}
      title={approval.tool === "Bash" ? "Allow this command?" : `Allow Claude Code to use ${approval.tool}?`}
      position={position}
      data-testid="approval-card"
      data-approval-id={approval.id}
      data-settled={settled ? "" : undefined}
      className={className}
    >
      {/* A tool that is not a shell command is said in words; what an allow lets run is one press away. */}
      <DecisionWhat testId={said.line === null ? "approval-command" : "approval-line"} ours={said.line !== null}>
        {said.line ?? visible(approval.command)}
      </DecisionWhat>
      <dl className="flex flex-col gap-2 text-sm">
        {place !== null && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">{place.term}</dt>
            <dd data-testid="approval-directory" className="min-w-0 break-words">
              {visible(place.words)}
            </dd>
          </div>
        )}
        {approval.asksBecause !== null && (
          <div className="flex flex-col gap-0.5">
            <dt className="text-meta font-semibold text-muted-foreground">Why it asks</dt>
            <dd data-testid="approval-why">{approval.asksBecause}</dd>
          </div>
        )}
        {on === "run" && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">{approval.taskId === null ? "Step" : "Task"}</dt>
            {approval.taskId === null ? <dd data-testid="approval-role">{stepWord(approval.role)}</dd> : <dd data-testid="approval-task" data-ds-content="" className="min-w-0 break-words">{`Task ${approval.taskId} · ${approval.taskTitle}`}</dd>}
          </div>
        )}
        {approval.reason !== null && (
          <div className="flex flex-col gap-0.5">
            <dt className="text-meta font-semibold text-muted-foreground">Claude Code's reason</dt>
            <dd data-testid="approval-reason" data-ds-content="" className="min-w-0 break-words">
              {visible(approval.reason)}
            </dd>
          </div>
        )}
      </dl>
      {/* The consequence, before the buttons: an allow here sends something off this Mac, and that cannot be taken back. */}
      {level === "risk" ? (
        <p data-testid="decision-consequence" className="flex gap-2 text-sm">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
          <span>
            <strong className="font-semibold">Botbench cannot take it back.</strong> {approval.tool === "WebSearch" ? "Allow sends this search to the web once." : "Allow sends this request to the address above once."} What comes back is read by Claude Code.
          </span>
        </p>
      ) : (
        // A request asked before a restart is answered for when it is asked again: its own line below says so.
        approval.parkedAt === null && <p className="text-sm text-muted-foreground">Allow lets it run once. The next request asks again.</p>
      )}
      <Provenance approval={approval} what="request" />
      <Problem>{problem}</Problem>
      <div data-testid="decision-actions" className="flex gap-2">
        <Button variant="outline" className="flex-1" disabled={off && sending !== "decline"} aria-busy={sending === "decline" || undefined} onClick={() => answer("decline", note)}>
          {sending === "decline" ? "Declining" : "Decline"}
        </Button>
        {/* In a chat the composer's Send is the view's one filled button while nothing waits; while a request waits, Allow is. */}
        <Button className="flex-[2]" disabled={off && sending !== "allow"} aria-busy={sending === "allow" || undefined} onClick={() => answer("allow", "")}>
          {sending === "allow" ? "Allowing" : "Allow"}
        </Button>
      </div>
      {said.line !== null && (
        <Disclosure summary="Technical details">
          <DecisionWhat testId="approval-command">{visible(said.raw)}</DecisionWhat>
        </Disclosure>
      )}
      {offer !== undefined && (
        <Disclosure summary="Always allow this command" testId="standing-offer">
          <Part name="What it authorises">{`You have allowed this command ${times(offer.approvals)}. Always allow would cover this exact command, in the ${stepWord(offer.role)} step, from this folder, in this repository. You confirm it first.`}</Part>
          <Part name="Scope">
            <StandingScope offer={offer} />
          </Part>
          <Part name="How long">It lasts until you take it back on the Permissions screen.</Part>
          <div>
            <Button variant="outline" aria-haspopup="dialog" disabled={off} onClick={() => setConfirming(true)}>
              {sending === "grant" ? "Setting it" : "Always allow…"}
            </Button>
          </div>
        </Disclosure>
      )}
      <Disclosure summary="Add a note for Claude Code">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-note`} className="text-meta font-semibold">
            What Claude Code should do instead
          </Label>
          <Textarea id={`${id}-note`} rows={2} maxLength={MAX_ANSWER} value={note} onChange={(event) => setNote(event.target.value)} aria-describedby={`${id}-note-about`} className="text-base" />
          <p id={`${id}-note-about`} className="text-meta text-muted-foreground">
            Decline sends it with your answer. Allow does not.
          </p>
        </div>
      </Disclosure>
      {offer !== undefined && (
        // The grant is taken in two steps: the dialog states its scope and that it lasts, and its first button, with the focus, changes nothing.
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent data-testid="standing-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-heading font-semibold">
                {"Always allow "}
                <code data-ds-content="" className="break-all">
                  {visible(offer.command)}
                </code>
                {" in this project?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                From now on Botbench runs exactly this command without asking you, each time the same step asks for it from this folder in a task of this repository. A different argument still asks, and dangerous commands always ask. If the command runs a script or a test, it runs whatever those files hold at the time, with your account's rights. This request is allowed too. You can take it back on the Permissions screen.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <StandingScope offer={offer} />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="outline"
                onClick={() => {
                  // The dialog goes as the grant is sent: what came of it is said on the surface, not behind the dialog.
                  setConfirming(false);
                  grant();
                }}
              >
                Always allow
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </DecisionSurface>
  );
}

/** The scope a standing permission would have, as the server offers it: the exact command, the repository, the folder and the step. */
function StandingScope({ offer }: { offer: NonNullable<Approval["standingOffer"]> }) {
  const rows = [
    { name: "Command", testId: "standing-command", value: visible(offer.command), theirs: true },
    { name: "Repository", testId: "standing-repo", value: visible(offer.repo), theirs: true },
    { name: "Folder", testId: "standing-directory", value: directoryWords(offer.cwd), theirs: false },
    { name: "Step", testId: "standing-role", value: stepWord(offer.role), theirs: false },
  ];
  return (
    <dl className="flex flex-col gap-1 text-sm">
      {rows.map((row) => (
        <div key={row.name} className="flex gap-2">
          <dt className="w-24 shrink-0 text-muted-foreground">{row.name}</dt>
          <dd data-testid={row.testId} data-ds-content={row.theirs ? "" : undefined} className={cn("min-w-0 break-all", row.theirs && "font-mono text-meta")}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The letter a choice is shown with: A, B, C, D. It names the choice; no key answers. */
const letter = (i: number): string => String.fromCharCode(65 + i);

/** Claude Code's question: every word but the labels is the agent's, shown as plain text. A choice is one of several, so none is filled. */
function QuestionDecision({ approval, question, position, on, onSignedOut, className }: DecisionProps & { question: NonNullable<Approval["question"]> }) {
  const { sending, settled, problem, reply } = useApprovalAnswer(approval, onSignedOut);
  const [own, setOwn] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (own !== null) field.current?.focus();
  }, [own !== null]);
  const off = (from: number | "own"): boolean => !settled || (sending !== null && sending !== from);
  return (
    <DecisionSurface level="approval" signal={approval.parkedAt !== null ? "Claude Code is stopped" : "Claude Code is paused"} title="Claude Code has a question" position={position} data-testid="question-card" data-approval-id={approval.id} className={className}>
      <p data-testid="question-whose" className="text-sm text-muted-foreground">
        The question and its choices are Claude Code's own words. Your answer goes back to it as text, and allows nothing to run.
      </p>
      {question.header !== "" && (
        <p data-testid="question-header" data-ds-content="" className="text-meta font-semibold text-muted-foreground">
          {visible(question.header)}
        </p>
      )}
      <p data-testid="question-text" data-ds-content="" className="text-base">
        {visible(question.text)}
      </p>
      {on === "run" && <p className="text-sm">{approval.taskId === null ? <span data-testid="approval-role">{stepWord(approval.role)}</span> : <span data-testid="approval-task" data-ds-content="">{`Task ${approval.taskId} · ${approval.taskTitle}`}</span>}</p>}
      <Provenance approval={approval} what="question" />
      <Problem>{problem}</Problem>
      <ul aria-label="Choices" className="flex flex-col gap-2">
        {question.choices.map((choice, i) => (
          <li key={choice.label} className="flex flex-col gap-1">
            <Button variant="outline" data-testid="question-choice" disabled={off(i)} aria-busy={sending === i || undefined} aria-describedby={choice.description === "" ? undefined : `${id}-${i}`} onClick={() => reply(i, choice.label)} className="h-auto min-h-(--control) justify-start py-2 text-left whitespace-normal">
              {`${letter(i)}. `}
              <span data-ds-content="">{visible(choice.label)}</span>
            </Button>
            {choice.description !== "" && (
              <p id={`${id}-${i}`} data-ds-content="" className="text-meta text-muted-foreground">
                {visible(choice.description)}
              </p>
            )}
          </li>
        ))}
      </ul>
      {own === null ? (
        <div>
          <Button variant="outline" data-testid="question-other" disabled={off("own")} aria-expanded={false} onClick={() => setOwn("")}>
            Something else
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (own.trim() !== "") reply("own", own);
          }}
        >
          <Label htmlFor={`${id}-own`} className="text-meta font-semibold">
            Your answer
          </Label>
          <Input ref={field} id={`${id}-own`} name="answer" autoComplete="off" value={own} maxLength={MAX_ANSWER} onChange={(event) => setOwn(event.target.value)} />
          <div>
            <Button type="submit" disabled={off("own") || (sending === null && own.trim() === "")} aria-busy={sending === "own" || undefined}>
              {sending === "own" ? "Sending" : "Send answer"}
            </Button>
          </div>
        </form>
      )}
    </DecisionSurface>
  );
}

/**
 * Opening a pull request, as elevated risk: the branch, the remote and its address, and what cannot be taken back,
 * before the button. The words are the ones the confirmation always had (components/pull-request.tsx); `onConfirm` is
 * the same request (`openPullRequest`). Not yet on a screen: the task's screen adopts it when it is rebuilt, and
 * until then no test draws it.
 */
export function PullRequestDecision({ target, busy, problem, onConfirm, onCancel }: { target: PullRequestTarget; busy: boolean; problem: string | null; onConfirm: () => void; onCancel: () => void }) {
  return (
    <DecisionSurface level="risk" signal="Leaves this Mac" title="Open a pull request?" data-testid="open-pull-request">
      <DecisionWhat>{`branch ${target.branch}\nremote ${target.remote}`}</DecisionWhat>
      <p className="text-sm">
        {"Botbench pushes the branch "}
        <code data-ds-content="">{target.branch}</code>
        {" to the remote "}
        <code data-ds-content="">{target.remote}</code>
        {" ("}
        <code data-ds-content="" className="break-all">
          {target.address}
        </code>
        {`) and opens a pull request into ${target.base ?? "the repository's default branch"}, with your own git and gh.`}
      </p>
      <p data-testid="decision-consequence" className="flex gap-2 text-sm">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
        <span>
          <strong className="font-semibold">Botbench cannot take it back.</strong> Only this branch is sent, at the commit you accepted. Botbench never merges, never pushes by force, and never pushes to the default branch.
        </span>
      </p>
      <Problem>{problem}</Problem>
      <div data-testid="decision-actions" className="flex gap-2">
        <Button variant="outline" className="flex-1" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button className="flex-[2]" aria-busy={busy || undefined} onClick={() => busy || onConfirm()}>
          {busy ? "Opening" : "Push and open"}
        </Button>
      </div>
    </DecisionSurface>
  );
}

/**
 * A decision that removes work for good: an alert dialog with an error edge and a band that says, in words and with a
 * mark, that it cannot be undone. The safe button comes first and holds the focus; Escape changes nothing. `what` is
 * what goes (a branch, files), as it is; `children` says what removing it means. The caller's own words and request:
 * Discard (components/discard.tsx), and Reject with "Delete the branch".
 */
export function DestructiveDialog({ open, onOpenChange, title, what, keepLabel, confirmLabel, onConfirm, testId, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; what?: string; keepLabel: string; confirmLabel: string; onConfirm: () => void; testId: string; children: ReactNode }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId} data-level="destructive" className="gap-0 overflow-hidden border border-destructive/70 p-0 ring-0">
        <p data-testid="decision-signal" className="flex items-center gap-2 border-b border-destructive/70 bg-destructive-subtle px-5 py-3 text-meta font-semibold text-destructive">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          Cannot be undone
        </p>
        <div className="flex flex-col gap-3 p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-heading font-semibold">{title}</AlertDialogTitle>
          </AlertDialogHeader>
          {what !== undefined && <DecisionWhat>{what}</DecisionWhat>}
          <AlertDialogDescription render={<div />} className="flex flex-col gap-2 text-sm text-foreground">
            {children}
          </AlertDialogDescription>
          <div data-testid="decision-actions" className="flex flex-wrap gap-2 pt-1">
            <AlertDialogCancel autoFocus>{keepLabel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirm}>
              {confirmLabel}
            </AlertDialogAction>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A request the safety rules refused: it did not run, and nothing here can run it. What was refused, the rule that
 * refused it in the server's words, what the agent did next when that is known, and two ways on: the rule on the
 * Permissions screen, and a note to the agent. There is no approve action, and none is offered by another name.
 */
export function RefusedNotice({ refused, rule, next, more = 0, onNote }: { refused: string; rule: string; next?: string | null; more?: number; onNote?: () => void }) {
  return (
    <DecisionSurface level="refused" signal="Refused, not run" title={more > 0 ? `${counted(more + 1, "command was", "commands were")} refused` : "A command was refused"} data-testid="refused-notice">
      <DecisionWhat testId="refused-command">{visible(refused)}</DecisionWhat>
      <p className="text-sm">It did not run, and no answer here can run it.</p>
      <p data-testid="refused-rule" className="text-sm text-muted-foreground">
        {rule}
      </p>
      {next != null && (
        <p data-testid="refused-next" className="text-sm text-muted-foreground">
          {next}
        </p>
      )}
      {more > 0 && <p className="text-sm text-muted-foreground">{`${counted(more, "more refused command", "more refused commands")} ${plural(more, "is", "are")} listed with the task.`}</p>}
      <div data-testid="decision-actions" className="flex flex-wrap gap-2">
        {onNote !== undefined && (
          <Button variant="outline" onClick={onNote}>
            Send a note
          </Button>
        )}
        <Button variant="outline" render={<a href="#/trust" />}>
          See the rule
        </Button>
      </div>
    </DecisionSurface>
  );
}
