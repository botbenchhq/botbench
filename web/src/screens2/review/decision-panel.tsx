import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/ui/alert-dialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { acceptTask, ApiError, rejectTask, runChecksAgain, type TaskDetail } from "../../api/client.ts";
import { offered } from "./review-model.ts";

/*
 * The decision on a task that is ready for review, as the routine level of the approved decision surface: a neutral
 * raised card, what accepting will do, an optional note, and the buttons. Which buttons there are is the server's to
 * say (`offered`, from its state of the evidence): Accept, as the one filled button, while the checks are about the
 * commit it keeps; "Accept without verification", outlined, when no checks ran; Run checks again, outlined, when they
 * are out of date; and Reject always, behind its confirmation. The server refuses whatever the state does not allow.
 * `children` follow the buttons: the other way on from a decision (a note to the agent).
 */

type Busy = "accept" | "reject" | "checks" | null;

/**
 * The decision's own state and requests, kept by the task's screen so that the panel (in the pane at the right, or in
 * its sheet under 1024px) and the bar at the foot of a narrow window are one decision, not two.
 */
export function useDecision(task: TaskDetail | null, onDecided: () => void, onSignedOut: () => void) {
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [branch, setBranch] = useState<"keep" | "discard">("keep");
  const heading = useRef<HTMLHeadingElement>(null);
  const sent = useRef(false);
  const decision = task?.decision ?? null;
  const evidence = task?.evidenceState ?? null;
  const offer = offered(evidence);
  const left = task?.leftovers ?? [];

  // When the decision was sent from here, focus moves to the panel's heading as the buttons go.
  useEffect(() => {
    if (decision === null || !sent.current) return;
    sent.current = false;
    // Under 1024px the panel may be in its closed sheet: focus then goes to the screen's own heading, not to nowhere.
    (heading.current ?? document.querySelector<HTMLElement>("main h1"))?.focus();
  }, [decision !== null]);
  // Run checks again stays busy until the server's next word on the evidence arrives.
  useEffect(() => setBusy((now) => (now === "checks" ? null : now)), [evidence?.state, task?.status]);

  const failed = (what: string) => (err: unknown): void => {
    setBusy(null);
    sent.current = false;
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setProblem(`${what} ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
    // The task may have moved on: show what is so now.
    onDecided();
  };
  const given = (): string | null => (note.trim() === "" ? null : note.trim());
  const accept = (): void => {
    if (task === null || busy !== null || offer.accept === null) return;
    setBusy("accept");
    setProblem(null);
    sent.current = true;
    acceptTask(task.id, offer.accept === "unverified", given()).then(onDecided, failed("The task was not accepted."));
  };
  const reject = (): void => {
    if (task === null || busy !== null) return;
    setRejecting(false);
    setBusy("reject");
    setProblem(null);
    sent.current = true;
    // The owner confirmed exactly the files the dialog listed; the server refuses, and lists them again, if they changed since.
    rejectTask(task.id, branch, left, given()).then(onDecided, failed("The task was not rejected."));
  };
  const again = (): void => {
    if (task === null || busy !== null) return;
    setBusy("checks");
    setProblem(null);
    runChecksAgain(task.id).then(onDecided, failed("The checks were not started."));
  };
  return { busy, problem, note, setNote, rejecting, setRejecting, branch, setBranch, heading, offer, left, accept, reject, again };
}
export type Decision = ReturnType<typeof useDecision>;

/** The decision's buttons: Reject, Run checks again when the checks are out of date, and the Accept the evidence allows. */
function DecisionActions({ d, testId, oneRow = false }: { d: Decision; testId: string; oneRow?: boolean }) {
  const { busy, offer } = d;
  return (
    <div data-testid={testId} className="flex flex-wrap gap-2">
      <Button variant="outline" className="flex-1" aria-busy={busy === "reject" || undefined} disabled={busy === "accept" || busy === "checks"} onClick={() => busy === null && d.setRejecting(true)}>
        {busy === "reject" ? "Rejecting" : "Reject"}
      </Button>
      {offer.runAgain && (
        <Button variant="outline" className="flex-1" aria-busy={busy === "checks" || undefined} disabled={busy === "reject"} onClick={d.again}>
          {busy === "checks" ? "Starting the checks" : "Run checks again"}
        </Button>
      )}
      {offer.accept !== null && (
        // Without verification it is not the view's primary action, and is not drawn as one.
        <Button variant={offer.accept === "accept" ? "default" : "outline"} className={offer.accept === "accept" || oneRow ? "flex-[2]" : "basis-full"} aria-busy={busy === "accept" || undefined} disabled={busy === "reject"} onClick={d.accept}>
          {busy === "accept" ? "Accepting" : offer.accept === "unverified" ? "Accept without verification" : "Accept"}
        </Button>
      )}
    </div>
  );
}

/**
 * The decision at the foot of a narrow window (under 1024px), where the panel stands in a sheet: one line on what the
 * evidence allows, in the server's words when it allows no Accept, and the same buttons. `more` opens the panel; it is
 * all there is once the task is decided.
 */
export function DecisionBar({ task, d, more }: { task: TaskDetail; d: Decision; more: ReactNode }) {
  if (task.decision !== null) return <>{more}</>;
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p data-testid="foot-line" className="line-clamp-2 min-w-0 text-meta text-muted-foreground">
          {d.offer.accept === "accept" ? (task.pullRequest.choice === "pull_request" ? "Accept keeps the branch, then pushes it and opens a pull request." : "Accept keeps the branch. Nothing is pushed or merged.") : d.offer.accept === "unverified" ? "No checks ran on this work." : (task.evidenceState?.words ?? task.evidenceProblem ?? "Botbench could not read the state of this task's evidence.")}
        </p>
        {more}
      </div>
      {d.problem !== null && (
        <p role="alert" className="text-meta text-destructive">
          {d.problem}
        </p>
      )}
      <DecisionActions d={d} testId="foot-actions" oneRow />
    </>
  );
}

export function DecisionPanel({ task, d, children }: { task: TaskDetail; d: Decision; children?: ReactNode }) {
  const { problem, note, setNote, heading, offer } = d;
  const id = useId();
  const decision = task.decision;
  const evidence = task.evidenceState;
  const pullRequest = task.pullRequest.choice === "pull_request";
  return (
    <>
      <Card data-testid="decision" className="gap-4 p-5">
        <h2 ref={heading} id={`${id}-heading`} tabIndex={-1} className="text-heading font-semibold tracking-tight outline-none">
          {decision?.decidedBy === "mode" ? "Decision" : "Your decision"}
        </h2>
        {decision === null ? (
          <>
            {offer.accept !== null ? (
              <div className="flex flex-col gap-2">
                <p className="text-meta font-semibold text-muted-foreground">{offer.accept === "unverified" ? "Accepting without verification will" : "Accepting will"}</p>
                <ul data-testid="accepting-will" className="flex flex-col gap-1.5 text-base">
                  {[
                    { mark: Check, words: "Keep the branch on this Mac, for you to merge yourself" },
                    { mark: Check, words: "Remove the task's copy of the project" },
                    pullRequest ? { mark: Check, words: "Push the branch and open a pull request for it, as this run was set to" } : { mark: Minus, words: "Push or merge nothing" },
                  ].map(({ mark: Mark, words }) => (
                    <li key={words} className="flex gap-2">
                      <Mark aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" />
                      {words}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p data-testid="no-accept" className="rounded-lg bg-fill px-3 py-2 text-meta">
                {evidence === null ? (task.evidenceProblem ?? "Botbench could not read the state of this task's evidence.") : evidence.words}
              </p>
            )}
            <p className="text-meta text-muted-foreground">{offer.accept !== null ? "Reject removes the copy too, and asks whether to keep the branch." : "Reject removes the task's copy of the project, and asks whether to keep the branch."}</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-note`} className="text-meta font-semibold">
                Note (optional)
              </Label>
              <Input id={`${id}-note`} data-testid="decision-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} aria-describedby={`${id}-note-about`} />
              <p id={`${id}-note-about`} className="text-meta text-muted-foreground">
                A short reason, kept with your Accept or Reject and shown in Activity.
              </p>
            </div>
            {problem !== null && (
              <p role="alert" data-testid="decision-problem" className="rounded-lg border border-destructive/60 bg-destructive-subtle px-3 py-2 text-meta text-destructive">
                {problem}
              </p>
            )}
            <DecisionActions d={d} testId="decision-actions" />
            {children}
          </>
        ) : (
          <div data-testid="decision-result" className="flex flex-col gap-3 text-base">
            {/* An accept made without verification is said as that, and is not drawn as a success. */}
            <Badge variant="outline" className={decision.decision === "accept" && decision.checks !== "none" ? "border-transparent bg-success-subtle text-success" : "text-muted-foreground"}>
              {decision.decision === "accept" ? (decision.decidedBy === "mode" ? "Accepted without you" : decision.checks === "none" ? "Accepted without verification" : "Accepted") : "Rejected"}
            </Badge>
            {decision.reasons !== null && <p>{decision.reasons}</p>}
            {decision.note !== null && (
              <p>
                {"Your note: "}
                <span data-ds-content="">{decision.note}</span>
              </p>
            )}
            {decision.branch === "kept" ? (
              <p>
                {"Branch "}
                <code data-testid="decided-branch" data-ds-content="" className="break-all">
                  {decision.branchName}
                </code>
              </p>
            ) : (
              <p>The branch and the task's copy of the project are gone.</p>
            )}
          </div>
        )}
      </Card>

    </>
  );
}

/** Reject takes something away, so it asks first: an alert dialog whose first button, with the focus, changes nothing. Drawn once by the task's screen. */
export function RejectDialog({ d }: { d: Decision }) {
  const id = useId();
  const { rejecting, setRejecting, branch, setBranch, left, reject } = d;
  return (
    <>
      <AlertDialog open={rejecting} onOpenChange={setRejecting}>
        <AlertDialogContent data-testid="reject">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-heading font-semibold">Reject this task?</AlertDialogTitle>
            <AlertDialogDescription>{`Either way, the task's copy of the project is removed${left.length > 0 ? ", with the files listed here" : ""}. Nothing is merged or pushed.`}</AlertDialogDescription>
          </AlertDialogHeader>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-3 text-meta font-semibold">What becomes of the branch?</legend>
            <RadioGroup value={branch} onValueChange={(value) => setBranch(value === "discard" ? "discard" : "keep")} aria-label="What becomes of the branch?">
              {(
                [
                  { value: "keep", label: "Keep the branch", about: "The work stays in the repository on its branch, for you to merge or delete later." },
                  { value: "discard", label: "Delete the branch", about: "The work on it is gone for good." },
                ] as const
              ).map((choice) => (
                <div key={choice.value} className="flex min-h-(--control) items-start gap-3">
                  <RadioGroupItem value={choice.value} id={`${id}-${choice.value}`} aria-describedby={`${id}-${choice.value}-about`} className="mt-1" />
                  <div className="flex flex-col gap-0.5">
                    <Label htmlFor={`${id}-${choice.value}`} className="text-base leading-normal">
                      {choice.label}
                    </Label>
                    <p id={`${id}-${choice.value}-about`} className="text-meta text-muted-foreground">
                      {choice.about}
                    </p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          {left.length > 0 && (
            <div className="flex flex-col gap-1 text-meta">
              <p>These files were left by the checks and are not on the branch:</p>
              <ul data-testid="leftovers">
                {left.map((file) => (
                  <li key={file}>
                    <code data-ds-content="">{file}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={reject}>
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
