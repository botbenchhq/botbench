import { useContext } from "react";
import type { PeerCard } from "../../api/client.ts";
import { ApprovalsContext } from "../../app/approvals.tsx";
import { number, plural } from "../../app/format.ts";
import { PeerCardsContext } from "../../app/peer-cards.tsx";

/**
 * The line that says a message with the paired workbench waits for the owner, in a screen's bar: it leads to Work,
 * where every such card stands. It is not drawn while an approval waits, which comes first and has the shell's own
 * line, nor for the cards the screen itself shows (`shown`).
 */
export function PeerCardsWaiting({ shown = () => false }: { shown?: (card: PeerCard) => boolean }) {
  const { cards } = useContext(PeerCardsContext);
  const { pending } = useContext(ApprovalsContext);
  const waiting = (cards ?? []).filter((card) => !shown(card)).length;
  if (waiting === 0 || (pending?.length ?? 0) > 0) return null;
  return (
    <a href="#/work" data-testid="tray-peer-cards" className="ml-auto inline-flex min-h-(--control-small) items-center gap-1 rounded-sm bg-attention-subtle px-2 py-1 text-meta font-medium text-attention">
      <span className="font-semibold">{number(waiting)}</span>
      {plural(waiting, " message with the paired workbench waits for you. Open it.", " messages with the paired workbench wait for you. Open them.")}
    </a>
  );
}
