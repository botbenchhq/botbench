import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Approval as ApprovalView, type ApprovalFact, visibleText } from "../../vendor/design-system/react/approval.tsx";
import { answerApproval, answerQuestion, ApiError, grantStanding, type Approval } from "../api/client.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { ConfirmAction } from "./confirm.tsx";
import { counted } from "../app/format.ts";
import { approvalWords, directoryWords, placeWords } from "./tool-summary.ts";

/** The tray's last "open" a card has answered by taking the focus. Kept across screens, so one open moves the focus once. */
let focusedFor = 0;

/**
 * Text with the characters that cannot be seen, or that reorder what is read (direction overrides, zero-width
 * marks, control codes other than tab and newline), written out by code point, so the card reads as what would run.
 * The design system's own rule, which its Approval applies to the command, so the card and its facts read alike.
 */
export const visible = (text: string): string => visibleText(text);

/** A count as it is said: "once", "3 times". */
export const times = (n: number): string => (n === 1 ? "once" : counted(n, "time", "times"));


/** Which step of the work asks, in the words of the steps: Plan, Build, Review. Any other name is shown as it is. */
export function stepWord(role: string): string {
  return { planner: "Plan", implementer: "Build", reviewer: "Review" }[role] ?? role;
}

/**
 * The pending count, in words, on every signed-in screen. With something
 * waiting it is a link to the oldest request's task, where its card is. With
 * nothing waiting it is empty, and stays in the page as the live region that
 * announces the next one. When the approvals could not be read, it says so.
 * `here`: every request waiting is shown on this screen by its card, so the
 * tray is not drawn and only says, to a screen reader, that it is here.
 */
export function ApprovalTray({ here, peerCards = 0 }: { here: boolean; peerCards?: number }) {
  const { pending, problem, open } = useContext(ApprovalsContext);
  const oldest = pending?.[0];
  return (
    <div data-testid="approval-tray" aria-live="polite" aria-atomic="true" className="ds-pending-tray">
      {here ? (
        // The card on this screen shows the request: the tray would say it again, so only a screen reader hears it, once.
        <span className="ds-visually-hidden">{pending!.length === 1 ? "An approval is waiting on this screen." : `${pending!.length} approvals are waiting on this screen.`}</span>
      ) : oldest === undefined && peerCards > 0 ? (
        // No approval waits, but a card about the paired workbench's messages does: it leads Work's Needs you.
        <a href="#/work" className="ds-pending-tray__link" data-testid="tray-peer-cards">
          <span className="ds-pending-tray__count">{peerCards}</span>
          {peerCards === 1 ? " message with the paired workbench waits for you. Open it." : " messages with the paired workbench wait for you. Open them."}
        </a>
      ) : oldest === undefined ? (
        pending === null && problem !== null && <span className="ds-pending-tray__text">{problem}</span>
      ) : (
        <a href={oldest.chat ? "#/turn" : oldest.taskId === null ? `#/runs/${oldest.runId}` : `#/tasks/${oldest.taskId}`} onClick={open} className="ds-pending-tray__link">
          <span className="ds-pending-tray__count">{pending!.length}</span>
          {pending!.length === 1 ? " approval is waiting. Open it." : " approvals are waiting. Open the oldest."}
        </a>
      )}
    </div>
  );
}

/** Who asked, on a card of work given a paired workbench's message (ADR 0004 decision 10): the server's own line. */
function AskedBy({ approval }: { approval: Approval }) {
  const words = approval.askedBy?.words ?? null;
  return words === null ? null : (
    <p data-testid="approval-asked-by" data-ds-content="">
      {words}
    </p>
  );
}

/** One fact of a question: what it is, then its value. */
function Fact({ term, testId, theirs = false, children }: { term: string; testId: string; theirs?: boolean; children: string }) {
  return (
    <li className="ds-approval__fact">
      <span className="ds-approval__term">{term}</span>{" "}
      <span data-testid={testId} data-ds-content={theirs ? "" : undefined} className="ds-approval__value">
        {children}
      </span>
    </li>
  );
}

/** A fact's value as the vendored Approval takes it: with its test hook, and marked as somebody else's words when it is. */
function value(testId: string, text: string, theirs = false) {
  return (
    <span data-testid={testId} data-ds-content={theirs ? "" : undefined}>
      {text}
    </span>
  );
}

/**
 * One request waiting for the owner: what would run, where, and the agent's
 * reason when it gave one. `on` is the screen it is shown on: on a run's screen
 * it also names the task, or says that the planner asks. A task's screen shows one card
 * at a time, so Allow is that view's one primary action; Decline sits at the far
 * end of the same row, and a note for the agent can go with it from the
 * disclosure before them (the one Decline sends a note that was typed). `more` is how many further requests of the same task wait
 * behind this one. When the server says this command has been allowed often
 * enough, the card also offers standing permission: a secondary step that
 * states the grant's scope in a dialog and does nothing until it is confirmed.
 */
export function ApprovalCard(props: { approval: Approval; more: number; on: "task" | "run" | "chat"; onSignedOut: () => void }) {
  return props.approval.question !== null ? <QuestionCard {...props} question={props.approval.question} /> : <PermissionCard {...props} />;
}

/** The longest answer the owner may give, as for a note; the server refuses a longer one. */
const MAX_ANSWER = 2000;

/** The letter a choice is shown with: A, B, C, D. */
const letter = (i: number): string => String.fromCharCode(65 + i);

/**
 * Claude Code's question to the owner: the question, one button per choice (lettered, with the agent's line about it
 * under it), and Something else, which opens a field for the owner's own words. Every word but Botbench's own labels is
 * the agent's and is shown as plain text, never as markdown or HTML. A choice is one of several, so none is the view's
 * primary action; only sending the owner's own words is, once that field is open. While an answer is sent, the button
 * pressed is busy and keeps focus, and the others are disabled.
 */
function QuestionCard({ approval, question, more, on, onSignedOut }: { approval: Approval; question: NonNullable<Approval["question"]>; more: number; on: "task" | "run" | "chat"; onSignedOut: () => void }) {
  const { refresh, opened } = useContext(ApprovalsContext);
  const [own, setOwn] = useState<string | null>(null);
  /** The button whose answer is being sent, while it is: a choice's index, or "own" for the owner's own words. */
  const [sending, setSending] = useState<number | "own" | null>(null);
  // As on a request's card: one that takes the place of one just answered must be read before it can be answered.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), 700);
    return () => window.clearTimeout(timer);
  }, []);
  const [problem, setProblem] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const heading = useId();
  const ownField = useId();
  const base = useId();

  useEffect(() => {
    if (opened <= focusedFor) return;
    focusedFor = opened;
    card.current?.focus();
    card.current?.scrollIntoView({ block: "nearest" });
  }, [opened]);
  useEffect(() => {
    if (own !== null) field.current?.focus();
  }, [own !== null]);

  const send = (from: number | "own", answer: string): void => {
    if (sending !== null) return;
    setSending(from);
    setProblem(null);
    answerQuestion(approval.id, answer).then(
      // The card goes when the list no longer has the question.
      () => refresh(),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setSending(null);
        setProblem(err instanceof ApiError ? `Your answer was not saved. ${err.message}` : "Your answer was not sent: Botbench could not be reached.");
        refresh();
      },
    );
  };
  /** A button other than the one pressed is unavailable while an answer is sent, and every one is until the card has settled. */
  const off = (from: number | "own"): boolean => !settled || (sending !== null && sending !== from);

  return (
    <article ref={card} tabIndex={-1} data-testid="question-card" data-approval-id={approval.id} aria-labelledby={heading} className="ds-approval">
      <h2 id={heading} className="ds-approval__title">
        Claude Code has a question
      </h2>
      <p data-testid="question-whose">The question and its choices are Claude Code's own words. Your answer goes back to it as text, and allows nothing to run.</p>
      {question.header !== "" && (
        <p data-testid="question-header" data-ds-content="" className="ds-approval__term">
          {visible(question.header)}
        </p>
      )}
      <p data-testid="question-text" data-ds-content="">
        {visible(question.text)}
      </p>
      {(on === "run" || approval.outsideText) && (
        <ul className="ds-approval__facts">
          {on === "run" && approval.taskId === null && (
            <Fact term="Step" testId="approval-role">
              {stepWord(approval.role)}
            </Fact>
          )}
          {on === "run" && approval.taskId !== null && (
            <Fact term="Task" testId="approval-task" theirs>{`Task ${approval.taskId} · ${approval.taskTitle}`}</Fact>
          )}
        </ul>
      )}
      <AskedBy approval={approval} />
      {approval.outsideText && approval.askedBy?.by !== "peer" && <p data-testid="approval-outside">This question comes from a run that read a GitHub issue, which people outside this project wrote. Answer it as you would answer them.</p>}
      {approval.outsideText && approval.askedBy?.by === "peer" && <p data-testid="approval-outside">{`This question comes from work given a message from ${approval.askedBy.peerName === null ? "the paired workbench" : `${approval.askedBy.peerName}'s workbench`}, which another person wrote. Answer it as you would answer them.`}</p>}
      {approval.parkedAt !== null && <p data-testid="approval-parked">Asked before Botbench restarted. Claude Code is stopped; your answer starts it again where it left off, and counts only if it asks this question again.</p>}
      {more > 0 && <p>{more === 1 ? "1 more request of this task waits behind this one." : `${more} more requests of this task wait behind this one.`}</p>}
      {problem !== null && (
        <p role="alert" className="ds-approval__error">
          {problem}
        </p>
      )}
      <ul className="ds-stack ds-gap-sm" aria-label="Choices">
        {question.choices.map((choice, i) => (
          <li key={choice.label} className="ds-stack ds-gap-xs">
            <div className="ds-cluster">
              <button type="button" data-testid="question-choice" disabled={off(i)} aria-busy={sending === i || undefined} aria-describedby={choice.description === "" ? undefined : `${base}-${i}`} onClick={() => send(i, choice.label)} className="ds-button">
                {`${letter(i)}. `}
                <span data-ds-content="">{visible(choice.label)}</span>
              </button>
            </div>
            {choice.description !== "" && (
              <p id={`${base}-${i}`} data-ds-content="">
                {visible(choice.description)}
              </p>
            )}
          </li>
        ))}
      </ul>
      {own === null ? (
        <div className="ds-cluster">
          <button type="button" data-testid="question-other" disabled={off("own")} aria-expanded={false} onClick={() => setOwn("")} className="ds-button">
            Something else
          </button>
        </div>
      ) : (
        <form
          className="ds-stack ds-gap-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (own.trim() !== "") send("own", own);
          }}
        >
          <div className="ds-field">
            <label htmlFor={ownField} className="ds-field__label">
              Your answer
            </label>
            <input ref={field} id={ownField} type="text" name="answer" autoComplete="off" value={own} maxLength={MAX_ANSWER} onChange={(e) => setOwn(e.target.value)} className="ds-field__control" />
          </div>
          <div className="ds-cluster">
            <button type="submit" disabled={off("own") || (sending === null && own.trim() === "")} aria-busy={sending === "own" || undefined} className="ds-button ds-button--primary">
              {sending === "own" ? "Sending" : "Send answer"}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

/**
 * A request to run a command or use a tool, drawn by the design system's Approval: Allow first, the one Decline at the
 * far end, which sends the note when one was typed, and the pressed button busy and focused while the answer is sent.
 */
function PermissionCard({ approval, more, on, onSignedOut }: { approval: Approval; more: number; on: "task" | "run" | "chat"; onSignedOut: () => void }) {
  const { refresh, opened } = useContext(ApprovalsContext);
  const [note, setNote] = useState("");
  /** The answer being sent, while it is. */
  const [sending, setSending] = useState<"allow" | "decline" | "grant" | null>(null);
  // A card that takes the place of one just answered must be read before it can be answered: a second tap
  // meant for the first card does nothing. Its answers are drawn unavailable until then (below).
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), 700);
    return () => window.clearTimeout(timer);
  }, []);
  const [problem, setProblem] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  /** A tool that is not a shell command is said in words; what an allow lets run is one tap away. */
  const said = approvalWords(approval.tool, approval.command);

  useEffect(() => {
    if (opened <= focusedFor) return;
    focusedFor = opened;
    card.current?.focus();
    card.current?.scrollIntoView({ block: "nearest" });
  }, [opened]);

  // The vendored Approval draws its command block with no way to pass it attributes. Its test hook is set on it here,
  // and, when it holds what would run as the agent gave it, the mark that these are somebody else's words.
  useLayoutEffect(() => {
    const block = card.current?.querySelector(":scope > .ds-approval__command");
    if (block === null || block === undefined) return;
    block.setAttribute("data-testid", said.line === null ? "approval-command" : "approval-line");
    if (said.line === null) block.setAttribute("data-ds-content", "");
    else block.removeAttribute("data-ds-content");
  });
  // Nor can it disable both answers: until the card has settled, and while Always allow is sent, they are drawn
  // unavailable here, so a press is never silently dropped. The Approval's own disabled props are all false then.
  const answersOff = !settled || sending === "grant";
  useLayoutEffect(() => {
    if (!answersOff) return;
    const buttons = [...(card.current?.querySelectorAll(":scope > .ds-approval__actions > button") ?? [])];
    for (const button of buttons) button.setAttribute("disabled", "");
    return () => {
      for (const button of buttons) button.removeAttribute("disabled");
    };
  }, [answersOff]);

  const answer = (decision: "allow" | "decline", typed: string): void => {
    // Until the card has settled, and while an answer is sent, a press does nothing.
    if (!settled || sending !== null) return;
    setSending(decision);
    setProblem(null);
    answerApproval(approval.id, decision, typed.trim() === "" ? undefined : typed).then(
      // The card goes when the list no longer has the request.
      () => refresh(),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setSending(null);
        setProblem(err instanceof ApiError ? `Your answer was not saved. ${err.message}` : "Your answer was not sent: Botbench could not be reached. Nothing was allowed.");
        refresh();
      },
    );
  };

  const offer = approval.standingOffer;
  const grant = (): void => {
    setSending("grant");
    setProblem(null);
    grantStanding(approval.id).then(
      () => refresh(),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setSending(null);
        setProblem(err instanceof ApiError ? `Always allow was not set, and nothing was allowed. ${err.message}` : "Always allow was not set: Botbench could not be reached. Nothing was allowed.");
        refresh();
      },
    );
  };

  const waiting = sending !== null || !settled;
  const place = placeWords(approval);
  const of = approval.chat ? "chat" : "task";
  const facts: ApprovalFact[] = [
    ...(approval.asksBecause === null ? [] : [{ term: "Why it asks", value: value("approval-why", approval.asksBecause) }]),
    // Which step asks matters only for a planner's request on its run's screen; a task's requests are all its builder's.
    ...(on === "run" && approval.taskId === null ? [{ term: "Step", value: value("approval-role", stepWord(approval.role)) }] : []),
    // The task's own screen already says which task this is; the run's screen names it, as its first line cut at a word.
    ...(on === "run" && approval.taskId !== null ? [{ term: "Task", value: value("approval-task", `Task ${approval.taskId} · ${approval.taskTitle}`, true) }] : []),
  ];
  // In a chat the card is an item of the transcript, beside the composer's Send: Allow has secondary emphasis there, as in a list.
  // data-settled says when a press counts, for the tests.

  return (
    <ApprovalView
      ref={card}
      tabIndex={-1}
      data-testid="approval-card"
      data-approval-id={approval.id}
      data-settled={settled ? "" : undefined}
      title={approval.tool === "Bash" ? "Claude Code asks to run a command" : `Claude Code asks to use ${approval.tool}`}
      command={said.line ?? approval.command}
      {...(place === null ? {} : { folder: value("approval-directory", visible(place.words)) })}
      terms={{ ...(place === null ? {} : { folder: place.term }), reason: "Claude Code's reason" }}
      facts={facts}
      {...(approval.reason === null ? {} : { reason: value("approval-reason", visible(approval.reason), true) })}
      {...(said.line === null
        ? {}
        : {
            details: {
              summary: "Technical details",
              content: (
                <pre data-testid="approval-command" data-ds-content="" className="ds-approval__command">
                  {visible(said.raw)}
                </pre>
              ),
            },
          })}
      note={{ summary: "Add a note for Claude Code", label: "What Claude Code should do instead", description: "Decline sends it with your answer. Allow does not.", value: note, onChange: setNote, maxLength: MAX_ANSWER }}
      error={problem}
      sending={sending === "grant" ? null : sending}
      primary={on !== "chat"}
      onAllow={() => answer("allow", "")}
      onDecline={(typed) => answer("decline", typed)}
    >
      <AskedBy approval={approval} />
      {approval.outsideText && approval.askedBy?.by !== "peer" && <p data-testid="approval-outside">This request comes from a run that read a GitHub issue, which people outside this project wrote. Check the command for anything the issue might have led to.</p>}
      {approval.outsideText && approval.askedBy?.by === "peer" && <p data-testid="approval-outside">{`This request comes from work given a message from ${approval.askedBy.peerName === null ? "the paired workbench" : `${approval.askedBy.peerName}'s workbench`}, which another person wrote. Check the command for anything the message might have led to.`}</p>}
      {approval.parkedAt !== null && <p data-testid="approval-parked">Asked before Botbench restarted. Claude Code is stopped; your answer starts it again where it left off, and counts only if it asks for exactly this again.</p>}
      {more > 0 && <p>{more === 1 ? `1 more request of this ${of} waits behind this one.` : `${more} more requests of this ${of} wait behind this one.`}</p>}
      {offer !== undefined && (
        <div data-testid="standing-offer" className="ds-stack ds-gap-sm">
          <p>{`You have allowed this command ${times(offer.approvals)}. Always allow would cover this exact command, in the ${stepWord(offer.role)} step, from this folder, in this repository. You confirm it first.`}</p>
          <div className="ds-cluster">
            <ConfirmAction
              label="Always allow…"
              title={
                <>
                  {"Always allow "}
                  <code data-ds-content="">{visible(offer.command)}</code>
                  {" in this project?"}
                </>
              }
              confirmLabel="Always allow"
              cancelLabel="Cancel"
              disabled={waiting}
              testId="standing-confirm"
              onConfirm={grant}
            >
              <p>
                From now on Botbench runs exactly this command without asking you, each time the same step asks for it from this folder in a task of this repository. A different argument still asks, and dangerous commands always ask. If the command runs a script or a test, it runs whatever those files hold at the time, with your account's rights. This request is allowed too. You can take it back on the Permissions screen.
              </p>
              <dl className="ds-key-value">
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Command</dt>
                  <dd data-testid="standing-command" data-ds-content="" className="ds-key-value__value ds-key-value__value--mono">
                    {visible(offer.command)}
                  </dd>
                </div>
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Repository</dt>
                  <dd data-testid="standing-repo" data-ds-content="" className="ds-key-value__value ds-key-value__value--mono">
                    {visible(offer.repo)}
                  </dd>
                </div>
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Folder</dt>
                  <dd data-testid="standing-directory" className="ds-key-value__value">
                    {directoryWords(offer.cwd)}
                  </dd>
                </div>
                <div className="ds-key-value__item">
                  <dt className="ds-key-value__label">Step</dt>
                  <dd data-testid="standing-role" className="ds-key-value__value">
                    {stepWord(offer.role)}
                  </dd>
                </div>
              </dl>
            </ConfirmAction>
          </div>
        </div>
      )}
    </ApprovalView>
  );
}
