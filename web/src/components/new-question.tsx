import { useContext, useId, useState } from "react";
import { ApiError, sendPeerMessage, type SentPeerMessage } from "../api/client.ts";
import { PeerCardsContext } from "../app/peer-cards.tsx";
import { MAX_MESSAGE } from "./peer-card.tsx";

/**
 * The owner's own question to the paired workbench, sent when they press Send (ADR 0004 decision 9: the owner's own
 * message needs no card). `parentId` names the message of a thread it follows; without one it starts a conversation.
 * What became of it is said under the button, in the server's words.
 */
export function NewQuestion({ pairingId, peer, parentId, onSent, onSignedOut }: { pairingId: string; peer: string; parentId?: string; onSent?: (sent: SentPeerMessage) => void; onSignedOut: () => void }) {
  const id = useId();
  const { refresh } = useContext(PeerCardsContext);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const send = (): void => {
    if (text.trim() === "") return;
    setBusy(true);
    setSaid(null);
    sendPeerMessage(pairingId, { kind: "question", text, ...(parentId === undefined ? {} : { parentId }) })
      .then(
        (sent) => {
          setText("");
          setSaid({ tone: sent.state === "not_sent_switched_off" ? "alert" : "status", text: sent.state === "not_sent_switched_off" ? "Not sent: switched off. Sending questions to this workbench is off, here or on its side." : `Your question: ${sent.words}.` });
          refresh();
          onSent?.(sent);
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) return onSignedOut();
          setSaid({ tone: "alert", text: err instanceof ApiError ? `It was not sent. ${err.message}` : "It was not sent: Botbench could not be reached." });
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="ds-stack ds-gap-sm"
      data-testid="new-question"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="ds-field">
        <label htmlFor={id} className="ds-field__label">
          {parentId === undefined ? `A new question for ${peer}` : `Ask ${peer} more`}
        </label>
        <textarea id={id} value={text} maxLength={MAX_MESSAGE} readOnly={busy} aria-describedby={`${id}-about`} onChange={(e) => setText(e.target.value)} className="ds-field__control ds-textarea" />
        <p id={`${id}-about`} className="ds-field__description">
          {`Only this text leaves this Mac, and only to ${peer}'s workbench, when you press Send. At most 8,000 characters.`}
        </p>
      </div>
      <div className="ds-cluster">
        <button type="submit" className="ds-button" aria-busy={busy || undefined} disabled={busy || text.trim() === ""}>
          {busy ? "Sending" : "Send"}
        </button>
      </div>
      {said !== null && (
        <p role={said.tone} data-testid="new-question-said">
          {said.text}
        </p>
      )}
    </form>
  );
}
