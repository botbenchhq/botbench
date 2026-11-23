import { useContext, useEffect, useId, useRef, useState } from "react";
import { answerPeerCard, ApiError, dismissPeerCard, dontSendPeerDraft, givePeerCard, seePeerCard, sendPeerDraft, type PeerCard } from "../api/client.ts";
import { BusyButton } from "../../vendor/design-system/react/busy-button.tsx";
import { PeerCardsContext } from "../app/peer-cards.tsx";
import { threadHref } from "../app/paired-words.ts";
import { visible } from "./approval-card.tsx";
import { LOOKS } from "./looks.ts";
import { RepoChoice } from "./repo-choice.tsx";
import { StatusBadge } from "./status.tsx";

/** The longest message Botbench sends to a paired workbench; the server refuses a longer one. */
export const MAX_MESSAGE = 8000;

/** Cards already reported as drawn by this tab, so each is reported once. */
const reported = new Set<string>();

/**
 * Tell the server, once, that a signed-in device drew this card: the friction record's "shown" (src/peers/cards.ts).
 * A report that fails is said in the browser's console and changes nothing on the screen.
 */
function useSeen(card: PeerCard): void {
  useEffect(() => {
    const key = `${card.pairingId} ${card.direction} ${card.messageId}`;
    if (reported.has(key)) return;
    reported.add(key);
    seePeerCard(card.pairingId, card.direction, card.messageId).catch((err: unknown) => {
      reported.delete(key);
      console.error(`Botbench could not record that this card was shown: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [card.pairingId, card.direction, card.messageId]);
}

/**
 * The text of a message from the other workbench, or of one about to go to it, as one row of the design system's
 * transcript: labelled with whose it is, plain text only (never markdown, HTML or a link), its line breaks kept and its
 * invisible characters written out.
 */
export function PeerText({ label, text, testId }: { label: string; text: string; testId: string }) {
  return (
    <ul className="ds-stack ds-gap-sm" aria-label={label}>
      <li className="ds-message">
        <span className="ds-message__label" data-ds-content="">
          {label}
        </span>
        <p data-testid={testId} data-ds-content="" className="ds-message__body">
          {visible(text)}
        </p>
      </li>
    </ul>
  );
}

/** What a failed press says: the server's own words, or that it could not be reached. */
const failure = (what: string, err: unknown): string => (err instanceof ApiError ? `${what} ${err.message}` : `${what} Botbench could not be reached.`);

/**
 * A card for a message the paired workbench sent (ADR 0004 decision 8): who sent it and about which repository, the
 * Outside text badge and Botbench's line about it, the text as plain text, and the owner's three choices. Answer it
 * yourself opens a field and sends the owner's own reply on Send; Give it to Claude Code starts a task in the owner's
 * copy of the repository, marked as having read outside text; Dismiss closes it. None of the three is primary, and an
 * open field's Send is primary only when `primary`: the card is not one of a list on a view that has its own.
 */
export function IncomingPeerCard({ card, primary, onSignedOut }: { card: PeerCard; primary: boolean; onSignedOut: () => void }) {
  useSeen(card);
  const { refresh } = useContext(PeerCardsContext);
  const [open, setOpen] = useState<"answer" | "give" | null>(null);
  const [text, setText] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [hosts, setHosts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useId();
  const field = useId();
  const field2 = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open === "answer") input.current?.focus();
  }, [open]);
  const name = card.peer.name;
  const reply = card.kind === "question" ? "Your answer" : "Your next question";

  // One action at a time, and each has its own view (the three buttons, the answer, the task): its button is the busy one.
  const act = (what: string, run: () => Promise<unknown>, after?: (value: unknown) => void): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    run().then(
      (value) => {
        refresh();
        after?.(value);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setBusy(false);
        setProblem(failure(what, err));
        refresh();
      },
    );
  };

  return (
    <article data-testid="peer-card" data-message-id={card.messageId} aria-labelledby={heading} className="ds-approval">
      <h2 id={heading} data-ds-content="" className="ds-approval__title">
        {card.title}
      </h2>
      <p>
        <StatusBadge look={LOOKS.outsideText}>Outside text</StatusBadge>
      </p>
      <p data-testid="peer-card-line">{card.line}</p>
      <PeerText label={`${name}'s workbench`} text={card.text} testId="peer-card-text" />
      <p data-testid="peer-card-fingerprint">
        {"Fingerprint of the workbench that signed it: "}
        <span data-ds-content="">{card.peer.fingerprint}</span>
      </p>
      {problem !== null && (
        <p role="alert" className="ds-approval__error">
          {problem}
        </p>
      )}
      {open === null && (
        <div className="ds-cluster ds-gap-sm">
          <button type="button" className="ds-button" disabled={busy} onClick={() => setOpen("answer")}>
            Answer it yourself
          </button>
          <button type="button" className="ds-button" disabled={busy} onClick={() => setOpen("give")}>
            Give it to Claude Code
          </button>
          <BusyButton busy={busy} busyLabel="Dismissing" onClick={() => act("It was not dismissed.", () => dismissPeerCard(card.pairingId, card.messageId))}>
            Dismiss
          </BusyButton>
        </div>
      )}
      {open === "answer" && (
        <form
          className="ds-stack ds-gap-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() !== "") act("It was not sent.", () => answerPeerCard(card.pairingId, card.messageId, text));
          }}
        >
          <div className="ds-field">
            <label htmlFor={field} className="ds-field__label">
              {reply}
            </label>
            <p id={`${field}-about`} className="ds-field__description">
              {`Only this text leaves this Mac, and only to ${name}'s workbench, when you press Send.`}
            </p>
            <textarea ref={input} id={field} value={text} maxLength={MAX_MESSAGE} readOnly={busy} aria-describedby={`${field}-about`} onChange={(e) => setText(e.target.value)} className="ds-field__control ds-textarea" />
          </div>
          <div className="ds-cluster ds-gap-sm">
            <BusyButton type="submit" variant={primary ? "primary" : "secondary"} busy={busy} busyLabel="Sending" disabled={text.trim() === ""}>
              Send
            </BusyButton>
            <button type="button" disabled={busy} onClick={() => setOpen(null)} className="ds-button">
              Cancel
            </button>
          </div>
        </form>
      )}
      {open === "give" && (
        <form
          className="ds-stack ds-gap-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (repo !== null) act("No task was started.", () => givePeerCard(card.pairingId, card.messageId, repo, hosts), (started) => (window.location.hash = `#/tasks/${(started as { taskId: number }).taskId}`));
          }}
        >
          <p>{`Botbench starts a task for Claude Code in your copy of the repository, with ${name}'s message in it as outside text: no command is allowed for it in advance or always, it runs in Manual mode, and nothing is sent to ${name}'s workbench unless you press Send on a draft.`}</p>
          <RepoChoice label="Your copy of the repository" value={repo} onChange={setRepo} onSignedOut={onSignedOut} />
          <div className="ds-checkbox">
            <input id={field2} type="checkbox" className="ds-checkbox__input" checked={hosts} aria-describedby={`${field2}-about`} onChange={(e) => setHosts(e.target.checked)} />
            <label htmlFor={field2} className="ds-checkbox__label">
              Allow this repository's network hosts for this task
            </label>
            <p id={`${field2}-about`} className="ds-checkbox__description">
              Off, its commands reach no network host.
            </p>
          </div>
          <div className="ds-cluster ds-gap-sm">
            <BusyButton type="submit" variant={primary ? "primary" : "secondary"} busy={busy} busyLabel="Starting" disabled={repo === null}>
              Start the task
            </BusyButton>
            <button type="button" disabled={busy} onClick={() => setOpen(null)} className="ds-button">
              Cancel
            </button>
          </div>
        </form>
      )}
      <a className="ds-link" href={threadHref(card.pairingId, card.contextId)}>
        Open the conversation
      </a>
    </article>
  );
}

/**
 * A card for an agent's draft to the paired workbench (ADR 0004 decision 9): "Send this to bob?", the line that says
 * what it is and who drafted it, who asked when the work was given a message, the full text exactly as it will be sent,
 * and the sentence about what leaves. Send sends it, or the owner's edit of it, which the server allows; Don't send
 * sends nothing. `primary`: Send is the view's one primary action (a screen that shows this one card).
 */
export function DraftPeerCard({ card, primary, onSignedOut }: { card: PeerCard; primary: boolean; onSignedOut: () => void }) {
  useSeen(card);
  const { refresh } = useContext(PeerCardsContext);
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "dont" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useId();
  const field = useId();

  const act = (what: "send" | "dont"): void => {
    if (busy !== null) return;
    setBusy(what);
    setProblem(null);
    (what === "send" ? sendPeerDraft(card.pairingId, card.messageId, edited === null || edited === card.text ? undefined : edited) : dontSendPeerDraft(card.pairingId, card.messageId)).then(
      () => refresh(),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setBusy(null);
        setProblem(failure(what === "send" ? "It was not sent." : "The draft is still waiting.", err));
        refresh();
      },
    );
  };

  return (
    <article data-testid="draft-card" data-message-id={card.messageId} aria-labelledby={heading} className="ds-approval">
      <h2 id={heading} data-ds-content="" className="ds-approval__title">
        {card.title}
      </h2>
      <p data-testid="draft-card-line">{card.line}</p>
      {card.askedBy !== null && (
        <p data-testid="draft-asked-by" data-ds-content="">
          {card.askedBy}
        </p>
      )}
      {edited === null ? (
        <PeerText label="The text to send" text={card.text} testId="draft-card-text" />
      ) : (
        <div className="ds-field">
          <label htmlFor={field} className="ds-field__label">
            The text to send
          </label>
          <textarea id={field} value={edited} maxLength={MAX_MESSAGE} readOnly={busy !== null} onChange={(e) => setEdited(e.target.value)} className="ds-field__control ds-textarea" />
        </div>
      )}
      <p data-testid="draft-card-note">{card.note}</p>
      {problem !== null && (
        <p role="alert" className="ds-approval__error">
          {problem}
        </p>
      )}
      <div className="ds-approval__actions">
        <BusyButton variant={primary ? "primary" : "secondary"} busy={busy === "send"} busyLabel="Sending" disabled={busy === "dont" || (edited !== null && edited.trim() === "")} onClick={() => act("send")}>
          Send
        </BusyButton>
        {edited === null && (
          <button type="button" disabled={busy !== null} onClick={() => setEdited(card.text)} className="ds-button">
            Edit
          </button>
        )}
        <BusyButton busy={busy === "dont"} busyLabel="Not sending" disabled={busy === "send"} onClick={() => act("dont")}>
          {"Don't send"}
        </BusyButton>
      </div>
      <a className="ds-link" href={threadHref(card.pairingId, card.contextId)}>
        Open the conversation
      </a>
    </article>
  );
}

/** A peer card of either direction. */
export function PeerCardView({ card, primary = false, onSignedOut }: { card: PeerCard; primary?: boolean; onSignedOut: () => void }) {
  return card.direction === "in" ? <IncomingPeerCard card={card} primary={primary} onSignedOut={onSignedOut} /> : <DraftPeerCard card={card} primary={primary} onSignedOut={onSignedOut} />;
}
