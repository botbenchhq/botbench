/**
 * What the header's approvals tray shows: the tray row, linking to the oldest request; only its live line, when every
 * request waiting is already shown on this screen (its card is there, and the tray would say it a second time); or
 * nothing. `showing` holds the ids of the requests this screen shows.
 */
export function trayShows({ pending, showing, problem }: { pending: readonly { id: number }[] | null; showing: readonly number[]; problem: string | null }): "tray" | "here" | "nothing" {
  if (pending === null) return problem === null ? "nothing" : "tray";
  if (pending.length === 0) return "nothing";
  return pending.every((approval) => showing.includes(approval.id)) ? "here" : "tray";
}
