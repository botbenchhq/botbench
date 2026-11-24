import { useContext, useEffect, useState } from "react";
import { answerApproval, answerQuestion, ApiError, grantStanding, type Approval } from "../api/client.ts";
import { ApprovalsContext } from "./approvals.tsx";

/** What is being sent for a request, while it is: an answer, the standing permission, or a question's answer (a choice's index, or the owner's own words). */
export type Sending = "allow" | "decline" | "grant" | number | "own" | null;

/**
 * Answering one waiting request, as its card always did (components/approval-card.tsx): Allow, Decline with the note
 * typed, Always allow, and a question's answer. A request that takes the place of one just answered must be read before
 * it can be answered: until it has settled a press does nothing, so a second tap meant for the first allows nothing. The
 * request goes from the screen when the list no longer has it; a failure says what was not saved, and that nothing was allowed.
 */
export function useApprovalAnswer(approval: Approval, onSignedOut: () => void) {
  const { refresh } = useContext(ApprovalsContext);
  const [sending, setSending] = useState<Sending>(null);
  const [settled, setSettled] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), 700);
    return () => window.clearTimeout(timer);
  }, []);

  const failed = (saved: string, sent: string) => (err: unknown): void => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setSending(null);
    setProblem(err instanceof ApiError ? `${saved} ${err.message}` : sent);
    refresh();
  };
  const begin = (what: Exclude<Sending, null>): boolean => {
    if (!settled || sending !== null) return false;
    setSending(what);
    setProblem(null);
    return true;
  };
  return {
    sending,
    settled,
    problem,
    answer(decision: "allow" | "decline", note: string): void {
      if (begin(decision)) answerApproval(approval.id, decision, note.trim() === "" ? undefined : note).then(refresh, failed("Your answer was not saved.", "Your answer was not sent: Botbench could not be reached. Nothing was allowed."));
    },
    grant(): void {
      if (begin("grant")) grantStanding(approval.id).then(refresh, failed("Always allow was not set, and nothing was allowed.", "Always allow was not set: Botbench could not be reached. Nothing was allowed."));
    },
    reply(from: number | "own", answer: string): void {
      if (begin(from)) answerQuestion(approval.id, answer).then(refresh, failed("Your answer was not saved.", "Your answer was not sent: Botbench could not be reached."));
    },
  };
}
