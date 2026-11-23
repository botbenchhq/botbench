import { useContext, useEffect, useState } from "react";
import { ApiError, getPeerFriction, getPeerMessages, getPeerOverview, type Pairing, type PeerMessage, type ThreadFriction } from "../api/client.ts";
import { PeerChangesContext } from "../app/approvals.tsx";
import { PeerCardsContext } from "../app/peer-cards.tsx";
import { frictionWords, threadsOf } from "../app/paired-words.ts";
import { visible } from "../components/approval-card.tsx";
import { Alert, Frame, Page, PageHeader } from "../components/header.tsx";
import { NewQuestion } from "../components/new-question.tsx";
import { PeerCardView } from "../components/peer-card.tsx";

const KIND: Record<"question" | "answer", string> = { question: "Question", answer: "Answer" };

/**
 * One conversation with the paired workbench (Peers P5): its messages oldest first, each marked as yours, the other
 * workbench's, or Claude Code's draft that waits for your Send, with what became of it; the cards of the conversation
 * that wait for you; your next question; and what the conversation cost you. Plain and small: everything the other
 * workbench wrote is plain text, never markdown, HTML or a link.
 */
export function ThreadScreen({ pairingId, contextId, onSignedOut }: { pairingId: string; contextId: string; onSignedOut: () => void }) {
  const changes = useContext(PeerChangesContext);
  const { cards } = useContext(PeerCardsContext);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [messages, setMessages] = useState<PeerMessage[] | null>(null);
  const [friction, setFriction] = useState<ThreadFriction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    // A newer read replaces this one: an answer that comes back late is dropped, so a state never goes backwards.
    let stale = false;
    Promise.all([getPeerOverview(), getPeerMessages(pairingId), getPeerFriction()]).then(
      ([overview, found, record]) => {
        if (stale) return;
        setPairing(overview.pairings.find((p) => p.id === pairingId) ?? null);
        setMessages(found);
        setFriction(record.find((p) => p.pairingId === pairingId)?.threadRecords.find((t) => t.contextId === contextId) ?? null);
        setProblem(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (stale) return;
        setProblem(err instanceof ApiError ? `The conversation could not be read. ${err.message}` : "The conversation could not be read: Botbench could not be reached.");
      },
    );
    return () => {
      stale = true;
    };
  }, [pairingId, contextId, changes, onSignedOut]);

  const thread = messages === null ? null : (threadsOf(messages, cards ?? [], pairingId).find((t) => t.contextId === contextId) ?? null);
  const waiting = (cards ?? []).filter((c) => c.pairingId === pairingId && c.contextId === contextId);
  const name = pairing?.peer.name ?? null;
  const last = messages?.filter((m) => m.contextId === contextId).at(-1) ?? null;
  const cost = friction === null ? null : frictionWords(friction);

  return (
    <Frame current={null} back={{ href: "#/settings/paired", label: "Paired workbench" }}>
      <Page>
        <PageHeader title={name === null ? "Conversation" : `Conversation with ${name}`} theirs={name !== null}>
          {pairing !== null && (
            <p className="ds-page-header__description">{pairing.state === "ended" ? "The pairing has ended: nothing more is sent or taken." : "Each message leaves this Mac only when you press Send."}</p>
          )}
        </PageHeader>
        {problem !== null && (
          <Alert tone="error" role="alert">
            {problem}
          </Alert>
        )}
        {messages === null && problem === null && (
          <p role="status" className="ds-spinner">
            Reading the conversation.
          </p>
        )}
        {messages !== null && thread === null && <p>There is no conversation by that address with this workbench.</p>}
        {thread !== null && pairing !== null && (
          <dl className="ds-key-value">
            <div className="ds-key-value__item">
              <dt className="ds-key-value__label">Repository</dt>
              <dd data-ds-content="" className="ds-key-value__value ds-key-value__value--mono">
                {pairing.repository}
              </dd>
            </div>
          </dl>
        )}
        {thread !== null && (
          <div className="ds-stack ds-gap-lg">
            <ol className="ds-stack ds-gap-sm" aria-label="Messages, oldest first" data-testid="thread">
              {thread.rows.map((row) => (
                <li key={row.key} data-testid="thread-message" data-who={row.who} className={row.who === "you" ? "ds-message ds-message--user" : "ds-message"}>
                  <span className="ds-message__label" data-ds-content={row.who === "peer" ? "" : undefined}>
                    {row.who === "you" ? "You" : row.who === "draft" ? "A draft for you to send" : name === null ? "The other workbench" : `${name}'s workbench`}
                  </span>
                  <p data-ds-content="" className="ds-message__body">
                    {visible(row.text)}
                  </p>
                  <p data-testid="thread-state" data-ds-content="" className="ds-message__state">{`${KIND[row.kind]} · ${row.state}`}</p>
                </li>
              ))}
            </ol>
            {waiting.length > 0 && (
              <section className="ds-stack ds-gap-sm" aria-label="Waiting for you">
                {waiting.map((card) => (
                  <PeerCardView key={`${card.direction} ${card.messageId}`} card={card} primary={waiting.length === 1} onSignedOut={onSignedOut} />
                ))}
              </section>
            )}
            {pairing?.state === "in_force" && name !== null && last !== null && waiting.length === 0 && <NewQuestion pairingId={pairingId} peer={name} parentId={last.messageId} onSignedOut={onSignedOut} />}
            {cost !== null && (
              <div data-testid="thread-friction" className="ds-stack ds-gap-xs">
                <p>{`${cost.answered} ${cost.waited} ${cost.asDrafted}`}</p>
                <p>{friction!.reachedAnswer ? "This conversation reached an answer." : "This conversation has not reached an answer yet."}</p>
              </div>
            )}
          </div>
        )}
      </Page>
    </Frame>
  );
}
