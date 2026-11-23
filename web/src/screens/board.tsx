import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { PeerCardsContext } from "../app/peer-cards.tsx";
import { PeerCardView } from "../components/peer-card.tsx";
import { ApiError, cancelRun, getBoard, getDriver, openEventStream, setRowHidden, type BoardGroup, type BoardGroupName, type BoardItem, type DriverState } from "../api/client.ts";
import { checksWords } from "../components/evidence.tsx";
import { Alert, Frame, NewLink, Page, PageHeader } from "../components/header.tsx";
import { runFacts, runLook, runWord } from "../components/run-status.ts";
import { StatusBadge } from "../components/status.tsx";
import { statusLook, statusWord } from "../components/task-status.ts";
import { folderName } from "../app/composer.ts";
import { agentName } from "../app/chat.ts";
import { cancelStatement, moreName, rowMenu, type RowAction } from "../app/row-menu.ts";
import { OtherWorkbenches } from "../components/other-workbenches.tsx";
import { ConfirmDialog } from "../components/confirm.tsx";
import { copyWords } from "../components/decision.tsx";
import { MenuRow } from "../components/row-menu.tsx";
import { RenameChatDialog } from "../components/rename-chat.tsx";
import { Proposals } from "../components/proposals.tsx";

type Groups = BoardGroup[];

/** Each group's name on the selector, and what its list says when it holds nothing. */
const GROUP: Record<BoardGroupName, { label: string; none: string }> = {
  "needs-you": { label: "Needs you", none: "Nothing needs you." },
  running: { label: "Running", none: "Nothing is running." },
  finished: { label: "Finished", none: "Nothing has finished yet." },
  chats: { label: "Chats", none: "No chats yet. A chat you send from Chat is listed here." },
};

/** Where a row leads: a run's or a task's screen, or Chat with that chat on it. */
const hrefOf = (item: BoardItem): string => (item.kind === "run" ? `#/runs/${item.id}` : item.kind === "task" ? `#/tasks/${item.id}` : `#/chats/${item.id}`);

/** One row's content: a planned run, a task started on its own, or a chat, in the design system's run-status row. */
function RowContent({ item }: { item: BoardItem }) {
  if (item.kind === "chat") {
    return (
      <span className="ds-run-status">
        <span data-ds-content="" className="ds-run-status__title">
          {item.title}
        </span>
        <span className="ds-run-status__facts">{`Chat · ${item.agents.map(agentName).join(", ")}`}</span>
      </span>
    );
  }
  const [look, word, facts] = item.kind === "run" ? [runLook(item), runWord(item), runFacts(item)] : [statusLook(item), statusWord(item), `Task ${item.id}${item.checks === null ? "" : ` · ${checksWords(item.checks)}`} · ${folderName(item.repo)}`];
  return (
    <span className="ds-run-status">
      <span data-ds-content="" className="ds-run-status__title">
        {item.title}
      </span>
      <span className="ds-run-status__station">
        <StatusBadge look={look}>{word}</StatusBadge>
      </span>
      <span className="ds-run-status__facts">{facts}</span>
    </span>
  );
}

/** What a menu item asked for that needs a dialog: Cancel's confirmation, or Rename's name. */
type Asking = { kind: "cancel"; item: Extract<BoardItem, { kind: "run" }> } | { kind: "rename"; item: Extract<BoardItem, { kind: "chat" }> } | null;

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
          <h2 className="ds-empty-state__title">No work yet</h2>
          <p className="ds-empty-state__body">A task you start from Chat, and a run with its plan of tasks, is listed here. Botbench builds each task in a separate copy of the project and shows you what it did, for you to accept or reject.</p>
          {driver === "failed" && <p className="ds-empty-state__body">Botbench could not check Claude Code just now. New run says so if it cannot be used.</p>}
          <div className="ds-empty-state__action">
            <NewLink href="#/turn?start=run">New run</NewLink>
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
 * Work, the runs board (unit 16): runs and the tasks started on their own, by what needs you, what is running and what
 * finished, and the chats. One group is shown at a time, chosen with the selector, which counts each group; at first it
 * is the first group that holds anything. Each row ends in its More menu (components/row-menu.tsx). Rows the owner hid
 * are left out and counted, and Show hidden lists them instead. The list is read again whenever live updates come up
 * and each time a run or a task reaches a state or an approval is asked for or answered.
 */
export function BoardScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [groups, setGroups] = useState<Groups | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [viewingHidden, setViewingHidden] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [chosen, setChosen] = useState<BoardGroupName | null>(null);
  const [driver, setDriver] = useState<DriverState | "failed" | null>(null);
  /** What the last menu action did, or why it did not. */
  const [said, setSaid] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const reads = useRef(0);
  const name = useId();
  // Cards about the paired workbench's messages wait for the owner too: they lead the Needs you group.
  const { cards: peerCardsRead, problem: peerProblem } = useContext(PeerCardsContext);
  const peerCards = peerCardsRead ?? [];
  const cardsWaiting = viewingHidden ? 0 : peerCards.length;

  const load = useCallback((): void => {
    const read = ++reads.current;
    getBoard(viewingHidden).then(
      (next) => {
        if (read !== reads.current) return;
        setGroups(next.groups);
        setHiddenCount(next.hidden);
        setFailed(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (read !== reads.current) return;
        setFailed(err instanceof ApiError ? `The runs could not be read. ${err.message}` : "The runs could not be read: Botbench could not be reached.");
      },
    );
  }, [onSignedOut, viewingHidden]);

  /** Counts the live updates that may change the issues to start, so that section reads them again. */
  const [watchRefresh, setWatchRefresh] = useState(0);
  useEffect(() => {
    load();
    const again = (): void => setWatchRefresh((n) => n + 1);
    return openEventStream(0, { onEvent: () => {}, onConnection: (connected) => connected && (load(), again()), onSignedOut, onRun: () => (load(), again()), onTask: load, onApproval: load, onWatch: again });
  }, [load, onSignedOut]);

  const failedWith = (what: string) => (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) return onSignedOut();
    setSaid({ tone: "error", text: `${what} ${err instanceof ApiError ? err.message : "Botbench could not be reached."}` });
  };
  const act = (item: BoardItem, action: RowAction): void => {
    setSaid(null);
    if (action === "open") window.location.hash = hrefOf(item);
    else if (action === "discard") window.location.hash = `#/tasks/${item.id}?discard`;
    else if (action === "cancel" && item.kind === "run") setAsking({ kind: "cancel", item });
    else if (action === "rename" && item.kind === "chat") setAsking({ kind: "rename", item });
    else if (action === "copy-branch" && item.kind !== "chat" && item.branch !== null) {
      const branch = item.branch;
      void copyWords(branch, `The branch name was not copied: this browser refused. It is ${branch}.`).then((text) => setSaid({ tone: text === "Copied." ? "status" : "error", text: text === "Copied." ? `Copied the branch name ${branch}.` : text }));
    } else if (action === "open-pull-request" && item.kind !== "chat" && item.pullRequest !== null) window.open(item.pullRequest.url, "_blank", "noopener,noreferrer");
    else if (action === "hide" || action === "show") {
      const hide = action === "hide";
      setRowHidden(item.kind, item.id, hide).then(() => {
        setSaid({ tone: "status", text: hide ? `Hidden from the list: ${item.kind === "chat" ? "the chat" : `${item.kind} ${item.id}`}. Nothing was deleted; Show hidden lists it.` : `Back in the list: ${item.kind === "chat" ? "the chat" : `${item.kind} ${item.id}`}.` });
        load();
      }, failedWith(hide ? "It was not hidden." : "It was not shown again."));
    }
  };
  const cancelConfirmed = (runId: number) => cancelRun(runId).then(load, failedWith("The run was not cancelled."));

  const switchView = (hidden: boolean): void => {
    setSaid(null);
    setGroups(null);
    setChosen(null);
    setViewingHidden(hidden);
  };

  const empty = groups !== null && groups.every((group) => group.total === 0) && hiddenCount === 0 && !viewingHidden && cardsWaiting === 0;
  const totalOf = (group: BoardGroup): number => group.total + (group.name === "needs-you" ? cardsWaiting : 0);
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
    // Chosen once the peer cards are read too, so cards that wait are where Work opens (the tray links here for them).
    if (chosen === null && groups !== null && peerCardsRead !== null && !groups.every((group) => totalOf(group) === 0)) setChosen(groups.find((group) => totalOf(group) > 0)!.name);
  }, [chosen, groups, cardsWaiting, peerCardsRead]);
  const shown = chosen ?? groups?.find((group) => totalOf(group) > 0)?.name ?? "needs-you";
  const current = groups?.find((group) => group.name === shown);

  return (
    <Frame current="work">
      <Page>
        <PageHeader title="Work" action={groups !== null && !empty ? <NewLink href="#/turn?start=run">New run</NewLink> : undefined} />
        {failed !== null && (
          <Alert tone="error" role="alert">
            {failed}
          </Alert>
        )}
        {peerProblem !== null && (
          <Alert tone="error" role="alert">
            {peerProblem}
          </Alert>
        )}
        <Proposals refresh={watchRefresh} onSignedOut={onSignedOut} />
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
                    <span className="ds-segmented-control__label">{`${GROUP[group.name].label} (${totalOf(group)})`}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {viewingHidden && <p data-testid="hidden-view">{`Rows hidden from the list (${hiddenCount}). Hiding deletes nothing: each row's More menu can show it in the list again.`}</p>}
            {shown === "needs-you" && cardsWaiting > 0 && (
              <ul className="ds-stack ds-gap-sm" aria-label="Messages with the paired workbench" data-testid="peer-cards">
                {peerCards.map((card) => (
                  <li key={`${card.direction} ${card.pairingId} ${card.messageId}`}>
                    <PeerCardView card={card} onSignedOut={onSignedOut} />
                  </li>
                ))}
              </ul>
            )}
            <div data-testid="board-group">
              {shown === "needs-you" && cardsWaiting > 0 && (current === undefined || current.items.length === 0) ? null : current === undefined || current.items.length === 0 ? (
                <p>{viewingHidden ? `Nothing in ${GROUP[shown].label} is hidden.` : GROUP[shown].none}</p>
              ) : (
                <div className="ds-stack ds-gap-sm">
                  <ds-menu>
                    <ul aria-label={GROUP[shown].label} className="ds-list">
                      {current.items.map((item) => (
                        <MenuRow key={`${item.kind} ${item.id}`} href={hrefOf(item)} name={moreName(item)} nameHasContent={item.kind === "chat"} items={rowMenu(item, viewingHidden)} onAction={(action) => act(item, action)}>
                          <RowContent item={item} />
                        </MenuRow>
                      ))}
                    </ul>
                  </ds-menu>
                  {current.total > current.items.length && <p>{`These are the newest ${current.items.length} of ${current.total}.`}</p>}
                </div>
              )}
            </div>
            {said !== null &&
              (said.tone === "error" ? (
                <Alert tone="error" role="alert">
                  {said.text}
                </Alert>
              ) : (
                <p role="status" data-testid="row-said">
                  {said.text}
                </p>
              ))}
            {viewingHidden ? (
              <div>
                <button type="button" onClick={() => switchView(false)} className="ds-button ds-button--quiet ds-button--small">
                  Back to the list
                </button>
              </div>
            ) : (
              hiddenCount > 0 && (
                <div>
                  <button type="button" onClick={() => switchView(true)} className="ds-button ds-button--quiet ds-button--small">
                    {`Show hidden (${hiddenCount})`}
                  </button>
                </div>
              )
            )}
            {!viewingHidden && <OtherWorkbenches onSignedOut={onSignedOut} />}
          </div>
        )}
        {asking?.kind === "cancel" && (
          <ConfirmDialog
            title="Cancel this run?"
            confirmLabel="Cancel run"
            cancelLabel="Keep run"
            disabled={false}
            losing
            testId="cancel-run"
            onClose={(confirmed) => {
              setAsking(null);
              if (confirmed) void cancelConfirmed(asking.item.id);
            }}
          >
            <p>{cancelStatement(asking.item.status, asking.item.taskCount)}</p>
          </ConfirmDialog>
        )}
        {asking?.kind === "rename" && (
          <RenameChatDialog
            chat={asking.item}
            onSignedOut={onSignedOut}
            onClose={(renamed) => {
              setAsking(null);
              if (renamed !== null) {
                setSaid({ tone: "status", text: renamed.named ? "The chat was renamed." : "The chat is named by its first message again." });
                load();
              }
            }}
          />
        )}
      </Page>
    </Frame>
  );
}
