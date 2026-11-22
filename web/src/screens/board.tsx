import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, getBoard, getDriver, openEventStream, type BoardGroup, type BoardGroupName, type BoardItem, type DriverState } from "../api/client.ts";
import { checksWords } from "../components/evidence.tsx";
import { Alert, Frame, NewLink, Page, PageHeader } from "../components/header.tsx";
import { runFacts, runLook, runWord } from "../components/run-status.ts";
import { StatusBadge } from "../components/status.tsx";
import { statusLook, statusWord } from "../components/task-status.ts";

type Groups = BoardGroup[];

/** Each group's name on the selector, and what its list says when it holds nothing. */
const GROUP: Record<BoardGroupName, { label: string; none: string }> = {
  "needs-you": { label: "Needs you", none: "Nothing needs you." },
  running: { label: "Running", none: "Nothing is running." },
  finished: { label: "Finished", none: "Nothing has finished yet." },
};

/** One row: a planned run, or a task started on its own, in the design system's run-status row. */
function Row({ item }: { item: BoardItem }) {
  const [href, look, word, facts] =
    item.kind === "run"
      ? [`#/runs/${item.id}`, runLook(item), runWord(item), runFacts(item)]
      : [`#/tasks/${item.id}`, statusLook(item), statusWord(item), `Task ${item.id}${item.checks === null ? "" : ` · ${checksWords(item.checks)}`} · ${item.repo}`];
  return (
    <li className="ds-list__row">
      <a href={href} className="ds-list__link">
        <span className="ds-run-status">
          <span data-ds-content="" className="ds-run-status__title">
            {item.title}
          </span>
          <span className="ds-run-status__station">
            <StatusBadge look={look}>{word}</StatusBadge>
          </span>
          <span className="ds-run-status__facts">{facts}</span>
        </span>
      </a>
    </li>
  );
}

/**
 * What a board with no runs and no tasks says: how a first run goes, and its one action. When Claude Code cannot be
 * used, a run could not start, so the state says why and leads to Settings instead.
 */
function FirstRun({ driver }: { driver: DriverState | "failed" | null }) {
  if (driver === null) {
    return (
      <p role="status" className="ds-spinner">
        Checking Claude Code.
      </p>
    );
  }
  const usable = driver === "failed" || driver.problem === null;
  return (
    <div data-testid="board-empty" className="ds-empty-state">
      {usable ? (
        <>
          <h2 className="ds-empty-state__title">No runs yet</h2>
          <p className="ds-empty-state__body">A run makes a list of tasks from a prompt or a spec file, for you to edit and approve. Botbench then builds each task in a separate copy of the project and shows you what it did, for you to accept or reject.</p>
          {driver === "failed" && <p className="ds-empty-state__body">Botbench could not check Claude Code just now. New run says so if it cannot be used.</p>}
          <div className="ds-empty-state__action">
            <NewLink href="#/runs/new">New run</NewLink>
          </div>
        </>
      ) : (
        <>
          <h2 className="ds-empty-state__title">Claude Code cannot be used yet</h2>
          <p className="ds-empty-state__body">
            <span data-ds-content="">{driver.problem}</span>
            {" A run needs it. Settings shows what Claude Code reports."}
          </p>
          <div className="ds-empty-state__action">
            <a href="#/settings" className="ds-button ds-button--primary">
              Open settings
            </a>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The runs board (unit 16): what needs you, what is running, what finished. One group is shown at a time, chosen with
 * the selector, which counts each group; at first it is the first group that holds anything. It is read again whenever
 * live updates come up and each time a run or a task reaches a state or an approval is asked for or answered.
 */
export function BoardScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [groups, setGroups] = useState<Groups | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [chosen, setChosen] = useState<BoardGroupName | null>(null);
  const [driver, setDriver] = useState<DriverState | "failed" | null>(null);
  const reads = useRef(0);
  const name = useId();

  const load = useCallback((): void => {
    const read = ++reads.current;
    getBoard().then(
      (next) => {
        if (read !== reads.current) return;
        setGroups(next);
        setFailed(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (read !== reads.current) return;
        setFailed(err instanceof ApiError ? `The runs could not be read. ${err.message}` : "The runs could not be read: Botbench could not be reached.");
      },
    );
  }, [onSignedOut]);

  useEffect(() => {
    load();
    return openEventStream(0, { onEvent: () => {}, onConnection: (connected) => connected && load(), onSignedOut, onRun: load, onTask: load, onApproval: load });
  }, [load, onSignedOut]);

  const empty = groups !== null && groups.every((group) => group.total === 0);
  // Only an empty board needs to know whether a run could start; the check asks the CLI, so it is not made on every update.
  useEffect(() => {
    if (!empty || driver !== null) return;
    getDriver().then(setDriver, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setDriver("failed");
    });
  }, [empty, driver, onSignedOut]);

  // The group shown at first is the first that holds anything, chosen once: a live update never moves the list under the owner's thumb.
  useEffect(() => {
    if (chosen === null && groups !== null && !groups.every((group) => group.total === 0)) setChosen(groups.find((group) => group.total > 0)!.name);
  }, [chosen, groups]);
  const shown = chosen ?? groups?.find((group) => group.total > 0)?.name ?? "needs-you";
  const current = groups?.find((group) => group.name === shown);

  return (
    <Frame current="runs">
      <Page>
        <PageHeader title="Runs" action={groups !== null && !empty ? <NewLink href="#/runs/new">New run</NewLink> : undefined}>
          <p className="ds-page-header__description">What needs you first, then what is running, then what has finished. A task you start on its own is here too.</p>
        </PageHeader>
        {failed !== null && (
          <Alert tone="error" role="alert">
            {failed}
          </Alert>
        )}
        {groups === null ? (
          failed === null && (
            <p role="status" className="ds-spinner">
              Reading runs.
            </p>
          )
        ) : empty ? (
          <FirstRun driver={driver} />
        ) : (
          <div className="ds-stack ds-gap-lg">
            <fieldset className="ds-segmented-control">
              <legend className="ds-segmented-control__legend ds-visually-hidden">Show</legend>
              <div className="ds-segmented-control__options">
                {groups.map((group) => (
                  <label key={group.name} className="ds-segmented-control__option">
                    <input className="ds-segmented-control__input" type="radio" name={name} value={group.name} checked={group.name === shown} onChange={() => setChosen(group.name)} />
                    <span className="ds-segmented-control__label">{`${GROUP[group.name].label} (${group.total})`}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div data-testid="board-group">
              {current === undefined || current.items.length === 0 ? (
                <p>{GROUP[shown].none}</p>
              ) : (
                <div className="ds-stack ds-gap-sm">
                  <ul aria-label={GROUP[shown].label} className="ds-list">
                    {current.items.map((item) => (
                      <Row key={`${item.kind} ${item.id}`} item={item} />
                    ))}
                  </ul>
                  {current.total > current.items.length && <p>{`These are the newest ${current.items.length} of ${current.total}.`}</p>}
                </div>
              )}
            </div>
          </div>
        )}
      </Page>
    </Frame>
  );
}
