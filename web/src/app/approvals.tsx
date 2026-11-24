import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, listPendingApprovals, openEventStream, type Approval } from "../api/client.ts";

/** What every signed-in screen knows about approvals waiting for the owner. */
export interface PendingApprovals {
  /** Oldest first. Null until the first read has come back. */
  pending: Approval[] | null;
  /** Why the approvals could not be read, when they could not. */
  problem: string | null;
  /** Read them again now. */
  refresh(): void;
  /** Counts the times the tray was used to open a card, so the card can take the focus each time. */
  opened: number;
  open(): void;
}

export const ApprovalsContext = createContext<PendingApprovals>({ pending: null, problem: null, refresh: () => {}, opened: 0, open: () => {} });

/**
 * Keeps the pending approvals current for the screens below it: read when the
 * event stream comes up and again each time the stream says an approval was
 * asked for or answered, so a card appears and goes without a reload.
 */
export function ApprovalsProvider({ onSignedOut, children }: { onSignedOut: () => void; children: ReactNode }) {
  const [pending, setPending] = useState<Approval[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState(0);
  /** Counts reads, so an answer that arrives after a newer one was asked for is dropped. */
  const reads = useRef(0);

  const refresh = useCallback((): void => {
    const read = ++reads.current;
    listPendingApprovals().then(
      (list) => {
        if (read !== reads.current) return;
        setPending(list);
        setProblem(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (read !== reads.current) return;
        setProblem(err instanceof ApiError ? `Approvals could not be read. ${err.message}` : "Approvals could not be read: Botbench could not be reached.");
      },
    );
  }, [onSignedOut]);

  // Counts what this same connection says changed a run or a task, for the column of chats and work: one stream a tab
  // serves both, so a wide screen opens no connection of its own (a browser holds only a few to one address).
  const [workChanges, setWorkChanges] = useState(0);
  // The same for a paired workbench: its cards, messages and pairing are read again when this moves.
  const [peerChanges, setPeerChanges] = useState(0);
  // Whether that connection is up. True until it is known to be down: nothing is said while the first one opens.
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    refresh();
    const changed = (): void => setWorkChanges((n) => n + 1);
    const peers = (): void => setPeerChanges((n) => n + 1);
    return openEventStream(0, {
      onEvent: () => {},
      onConnection: (up) => {
        setConnected(up);
        if (!up) return;
        refresh();
        changed();
        peers();
      },
      onPeers: peers,
      onSignedOut,
      onApproval: () => {
        refresh();
        changed();
      },
      onRun: changed,
      onTask: changed,
    });
  }, [refresh, onSignedOut]);

  const open = useCallback(() => setOpened((n) => n + 1), []);
  const value = useMemo(() => ({ pending, problem, refresh, opened, open }), [pending, problem, refresh, opened, open]);
  return (
    <ApprovalsContext.Provider value={value}>
      <WorkChangesContext.Provider value={workChanges}>
        <PeerChangesContext.Provider value={peerChanges}>
          <ConnectionContext.Provider value={connected}>{children}</ConnectionContext.Provider>
        </PeerChangesContext.Provider>
      </WorkChangesContext.Provider>
    </ApprovalsContext.Provider>
  );
}

/** How many times live updates said a run or a task changed, or came back up: read the runs and tasks again when it moves. */
export const WorkChangesContext = createContext(0);

/** How many times live updates said a paired workbench's cards, messages or pairing may have changed, or came back up. */
export const PeerChangesContext = createContext(0);

/** Whether live updates are connected, as the one connection every signed-in screen shares reports it (the shell's line under its bar). */
export const ConnectionContext = createContext(true);
