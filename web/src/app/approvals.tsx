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

  useEffect(() => {
    refresh();
    return openEventStream(0, { onEvent: () => {}, onConnection: (connected) => connected && refresh(), onSignedOut, onApproval: refresh });
  }, [refresh, onSignedOut]);

  const open = useCallback(() => setOpened((n) => n + 1), []);
  const value = useMemo(() => ({ pending, problem, refresh, opened, open }), [pending, problem, refresh, opened, open]);
  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}
