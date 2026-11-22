import type { RunDetail } from "../api/client.ts";
import { stations } from "./run-status.ts";

/** The design system's run timeline for one run: its stations in order, the one it is at marked, each state in words. */
export function RunTimeline({ run, id }: { run: Pick<RunDetail, "status" | "attemptId" | "waitingOnApproval" | "tasks">; id: number }) {
  const shown = stations(run);
  if (shown === null) return null;
  return (
    <ol aria-label={`Steps of run ${id}`} className="ds-run-timeline">
      {shown.stations.map((station, at) => (
        <li key={station.name} data-state={station.state} aria-current={at === shown.current ? "step" : undefined} className="ds-run-timeline__station">
          <span className="ds-run-timeline__name">{station.name}</span>
          <span className="ds-run-timeline__status">{station.words}</span>
        </li>
      ))}
    </ol>
  );
}
