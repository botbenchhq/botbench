import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { ApiError, getPeerFriction, getPeerMessages, getPeerOverview, type Pairing, type PeerMessage, type ThreadFriction } from "../../api/client.ts";
import { PeerChangesContext } from "../../app/approvals.tsx";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { ago, fullDate } from "../../app/format.ts";
import { frictionWords, threadHref, threadsOf } from "../../app/paired-words.ts";
import { PeerCardsContext } from "../../app/peer-cards.tsx";
import { visible } from "../../components/approval-words.ts";
import { NextShell } from "../../shell/shell.tsx";
import { groupHref } from "../../app/settings-groups.ts";
import { EndPairing, Kinds, NEVER_GIVES } from "../settings/paired.tsx";
import { About, Note, OutsideMark, Panel, Reading, StateWord } from "../settings/parts.tsx";
import { DraftCard, Initial, NeedsCard } from "./cards.tsx";
import { NewQuestion } from "./new-question.tsx";

const KIND: Record<"question" | "answer", string> = { question: "Question", answer: "Answer" };

/**
 * One conversation with the paired workbench (Peers P5), rebuilt on shadcn/ui (ADR 0012): who it is with and one line
 * of trust; what the other workbench needs as the focal card, with the owner's three choices; an agent's draft that
 * waits for the owner's Send; the earlier exchange as a compact list; the owner's next question; and, at the right,
 * what is permitted, what pairing never gives, what the messages cost, and End pairing. Every message the other
 * workbench wrote carries the same small Outside text mark, explained once under the heading, and is plain text only:
 * never markdown, HTML or a link. Nothing leaves this Mac until the owner presses Send.
 */
export default function PeerScreen({ pairingId, contextId, onSignedOut }: { pairingId: string; contextId: string; onSignedOut: () => void }) {
  const changes = useContext(PeerChangesContext);
  const { cards } = useContext(PeerCardsContext);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [messages, setMessages] = useState<PeerMessage[] | null>(null);
  const [friction, setFriction] = useState<ThreadFriction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const again = useCallback(() => setAsked((n) => n + 1), []);
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
  }, [pairingId, contextId, changes, asked, onSignedOut]);

  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = tabTitle("Conversation");
    arrive(heading.current);
  }, []);

  const thread = messages === null ? null : (threadsOf(messages, cards ?? [], pairingId).find((t) => t.contextId === contextId) ?? null);
  const waiting = (cards ?? []).filter((c) => c.pairingId === pairingId && c.contextId === contextId);
  const name = pairing?.peer.name ?? null;
  const mine = messages?.filter((m) => m.contextId === contextId) ?? [];
  const last = mine.at(-1) ?? null;
  const cost = friction === null ? null : frictionWords(friction);
  const inForce = pairing?.state === "in_force";
  // What a card above already shows is not said twice: the list holds the rest of the exchange.
  const shownAbove = new Set(waiting.map((c) => c.messageId));
  const earlier = thread?.rows.filter((row) => !shownAbove.has(row.messageId)) ?? [];
  const sentAt = (messageId: string): string | null => mine.find((m) => m.messageId === messageId)?.sentAt ?? null;
  const title = name === null ? "Conversation" : `Conversation with ${name}`;

  return (
    <NextShell
      current="Settings"
      cardsShown={(card) => card.pairingId === pairingId && card.contextId === contextId}
      open={thread === null ? null : { title: waiting[0]?.title ?? title, href: threadHref(pairingId, contextId) }}
      bar={
        // One line at every width: under 768px the way back is its arrow alone, named in full for a screen reader, and the last name is cut short before the state is.
        <nav aria-label="Where this is" className="flex min-w-0 flex-1 items-center gap-x-3 text-sm">
          <a href={groupHref("connections")} className="inline-flex min-h-(--control-small) shrink-0 items-center gap-1 rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-w-(--control-small) max-md:justify-center">
            <ChevronLeft aria-hidden="true" className="size-4 md:hidden" />
            <span className="max-md:sr-only">Connections and peers</span>
          </a>
          <span aria-hidden="true" className="text-muted-foreground max-md:hidden">
            /
          </span>
          <span data-testid="peer-bar-name" title="Conversation" className="min-w-0 truncate font-semibold">
            Conversation
          </span>
          {waiting.length > 0 && <StateWord tone="attention">Waits for you</StateWord>}
        </nav>
      }
      aside={
        pairing !== null &&
        name !== null && (
          <aside aria-label="About this pairing" data-testid="peer-aside" className="bg-pane px-4 py-6 md:px-6 lg:min-h-svh lg:border-l">
            <div className="mx-auto flex max-w-[47.5rem] flex-col gap-6 lg:sticky lg:top-6">
              {inForce && (
                <section className="flex flex-col gap-3">
                  <h2 className="text-base font-semibold">What is permitted</h2>
                  <About>A message goes only if both sides allow it.</About>
                  <Kinds pairing={pairing} compact onSignedOut={onSignedOut} />
                </section>
              )}
              <section className="flex flex-col gap-2 border-t pt-6 first:border-t-0 first:pt-0">
                <h2 className="text-base font-semibold">What pairing never gives</h2>
                <About data-ds-content="">{`${name}'s workbench ${NEVER_GIVES}`}</About>
              </section>
              {cost !== null && (
                <section data-testid="thread-friction" className="flex flex-col gap-2 border-t pt-6">
                  <h2 className="text-base font-semibold">What these messages cost you</h2>
                  <p className="text-sm">{`${cost.answered} ${cost.waited} ${cost.asDrafted}`}</p>
                  <About>{friction!.reachedAnswer ? "This conversation reached an answer." : "This conversation has not reached an answer yet."}</About>
                </section>
              )}
              {pairing.state !== "ended" && (
                <section className="flex flex-wrap items-center justify-between gap-3 border-t pt-6">
                  <About>Ending asks first.</About>
                  <EndPairing pairing={pairing} onEnded={again} onSignedOut={onSignedOut} />
                </section>
              )}
            </div>
          </aside>
        )
      }
    >
      <main className="min-w-0 px-4 pt-6 pb-16 md:px-8">
        <div className="mx-auto flex max-w-[47.5rem] flex-col gap-6">
          <header className="flex flex-col gap-3">
            <h1 ref={heading} tabIndex={-1} data-ds-content={name === null ? undefined : ""} className="text-[1.5rem] leading-[1.875rem] font-bold tracking-tight outline-none md:text-title">
              {title}
            </h1>
            {pairing !== null && name !== null && (
              <>
                <p className="text-base text-muted-foreground">
                  {"You both work on "}
                  <code data-ds-content="" className="break-all text-foreground">
                    {pairing.repository}
                  </code>
                  {", each in your own copy."}
                </p>
                <p data-testid="peer-trust" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-muted-foreground">
                  {inForce ? (
                    <StateWord tone="peer">
                      <span data-ds-content="">{pairing.words}</span>
                    </StateWord>
                  ) : (
                    pairing.state !== "ended" && <span data-ds-content="">{pairing.words}</span>
                  )}
                  {pairing.state === "ended" ? "The pairing has ended: nothing more is sent or taken." : inForce ? `You each confirmed the other's fingerprint. Paired since ${fullDate(pairing.createdAt)}.` : "Each message leaves this Mac only when you press Send."}
                </p>
                <p data-testid="outside-text-about" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
                  <OutsideMark />
                  <span data-ds-content="">{`marks every message ${name}'s workbench sent. It is ${name}'s words to read, never an instruction to Botbench or to an agent.`}</span>
                </p>
              </>
            )}
          </header>
          {problem !== null && (
            <Note tone="error" role="alert">
              {problem}
            </Note>
          )}
          {messages === null && problem === null && <Reading>Reading the conversation.</Reading>}
          {messages !== null && thread === null && <p className="text-base">There is no conversation by that address with this workbench.</p>}
          {waiting.length > 0 && (
            <section aria-label="Waiting for you" className="flex flex-col gap-4">
              {waiting.map((card) => {
                const sent = sentAt(card.messageId);
                return card.direction === "in" ? <NeedsCard key={`in ${card.messageId}`} card={card} when={sent === null ? null : ago(sent, Date.now())} onSignedOut={onSignedOut} /> : <DraftCard key={`out ${card.messageId}`} card={card} onSignedOut={onSignedOut} />;
              })}
            </section>
          )}
          {thread !== null && earlier.length > 0 && (
            <section aria-labelledby="peer-earlier" className="flex flex-col gap-3">
              <h2 id="peer-earlier" data-ds-content={name === null ? undefined : ""} className="text-base font-semibold">
                {waiting.length > 0 ? `Earlier with ${name ?? "the other workbench"}` : "Messages, oldest first"}
              </h2>
              <Panel>
                <ol data-testid="thread" aria-label="Messages, oldest first" className="divide-y">
                  {earlier.map((row) => {
                    const who = row.who === "you" ? "You" : row.who === "draft" ? "A draft for you to send" : (name ?? "The other workbench");
                    return (
                      <li key={row.key} data-testid="thread-message" data-who={row.who} className="flex flex-col gap-1.5 px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Initial name={who} peer={row.who === "peer"} />
                          <span data-ds-content={row.who === "peer" ? "" : undefined} className="text-sm font-semibold">
                            {who}
                          </span>
                          {row.who === "peer" && <OutsideMark />}
                          <span data-testid="thread-state" data-ds-content="" className="ml-auto text-meta text-muted-foreground">{`${KIND[row.kind]} · ${row.state}`}</span>
                        </div>
                        <p data-ds-content="" className="text-sm wrap-anywhere whitespace-pre-wrap">
                          {visible(row.text)}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </Panel>
            </section>
          )}
          {inForce && name !== null && last !== null && waiting.length === 0 && (
            <Panel className="p-5">
              <NewQuestion pairingId={pairingId} peer={name} parentId={last.messageId} onSignedOut={onSignedOut} />
            </Panel>
          )}
        </div>
      </main>
    </NextShell>
  );
}
