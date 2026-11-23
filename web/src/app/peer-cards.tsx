import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, getPeerCards, type PeerCard } from "../api/client.ts";
import { PeerChangesContext } from "./approvals.tsx";

/** The cards about a paired workbench's messages that wait for the owner, as every signed-in screen knows them. */
export interface PeerCards {
  /** Oldest first. Null until the first read has come back. */
  cards: PeerCard[] | null;
  problem: string | null;
  refresh(): void;
}

export const PeerCardsContext = createContext<PeerCards>({ cards: null, problem: null, refresh: () => {} });

/**
 * Keeps the waiting peer cards current for the screens below it: read at once, and again each time live updates say a
 * paired workbench's cards or messages may have changed (approvals.tsx counts those on its one connection).
 */
export function PeerCardsProvider({ onSignedOut, children }: { onSignedOut: () => void; children: ReactNode }) {
  const changes = useContext(PeerChangesContext);
  const [cards, setCards] = useState<PeerCard[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const reads = useRef(0);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    const read = ++reads.current;
    getPeerCards().then(
      (found) => {
        if (read !== reads.current) return;
        setCards(found);
        setProblem(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (read !== reads.current) return;
        setProblem(err instanceof ApiError ? `Messages from the paired workbench could not be read. ${err.message}` : "Messages from the paired workbench could not be read: Botbench could not be reached.");
      },
    );
  }, [changes, asked, onSignedOut]);

  const value = useMemo(() => ({ cards, problem, refresh: () => setAsked((n) => n + 1) }), [cards, problem]);
  return <PeerCardsContext.Provider value={value}>{children}</PeerCardsContext.Provider>;
}
