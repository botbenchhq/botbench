import { useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, Circle, CirclePause, Clock, Copy, Ellipsis, ExternalLink, ListChecks, MessageSquare, Minus, Plus, Search, SquareCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/ui/alert-dialog";
import { Button, buttonVariants } from "@/ui/button";
import { Card } from "@/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Skeleton } from "@/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/table";
import { cn } from "@/ui/lib/utils";
import { ApiError, cancelRun, getWork, openEventStream, renameChat, setRowHidden, type WorkItem, type WorkKind, type WorkPage, type WorkState } from "../../api/client.ts";
import { WorkChangesContext } from "../../app/approvals.tsx";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { cancelStatement, moreName, rowMenu, type RowAction } from "../../app/row-menu.ts";
import { copyWords } from "../../components/decision.tsx";
import { checksWords } from "../../components/evidence.tsx";
import { runFacts } from "../../components/run-status.ts";
import { waitingForWords } from "../../components/task-status.ts";
import { OtherWorkbenches } from "../../components/other-workbenches.tsx";
import { Proposals } from "../../components/proposals.tsx";
import { NextShell } from "../../shell/shell.tsx";
import { DestructiveDialog } from "../decision/decision-surface.tsx";
import { hrefOf } from "../home/home-model.ts";
import { aboutLine, agentWord, changed, changedShort, kindWord, KINDS, noneLine, olderLine, repoWord, shownLine, STATES, stateWord } from "./work-model.ts";

/*
 * Work, the full inventory (the approved board V2Work): every run, every task started on its own and every chat,
 * newest change first, in one dense table with each row's real state. The search, the two filters, the counts on them
 * and the paging are the server's (/api/work): this screen sends what was chosen and shows what comes back. Each row
 * ends in its More menu, built from what is real for the row now (app/row-menu.ts), as on the list this replaces.
 */

/** How many rows a page holds; the server's own default. */
const PAGE = 50;
/** The most rows one request is sent (src/api/work.ts). */
const MOST = 200;

/** The mark beside a row's state. The word says the state; the mark and its tone only repeat it. Amber is for what waits on the owner. */
function look(item: WorkItem): { icon: LucideIcon; tone: string; strong: boolean } {
  if (item.place === "needs-you") return { icon: item.cause === "approval" ? CirclePause : item.cause === "plan" ? ListChecks : item.cause === "failure" ? TriangleAlert : SquareCheck, tone: "text-attention", strong: true };
  if (item.place === "in-progress") return { icon: Circle, tone: "text-primary", strong: true };
  if (item.place === "waiting") return { icon: Clock, tone: "text-muted-foreground", strong: false };
  if (item.place === "completed") return { icon: Check, tone: "text-success", strong: false };
  if (item.place === "failed") return { icon: TriangleAlert, tone: "text-destructive", strong: true };
  return { icon: item.place === "chat" ? MessageSquare : Minus, tone: "text-muted-foreground", strong: false };
}

/**
 * What a row adds under its title, when there is something to add, as the list this replaces said it: for a task, what
 * its checks found, the task it waits for, and that Botbench took it up again after a restart; for a run, how far its
 * tasks are. Null otherwise.
 */
function rowFacts(item: WorkItem): string | null {
  if (item.kind === "chat") return null;
  // A run's line starts with its number and ends with its repository, which have columns of their own here.
  if (item.kind === "run") return runFacts(item).split(" \u00b7 ").slice(1, -1).join(" \u00b7 ") || null;
  const parts = [...(item.checks === null ? [] : [checksWords(item.checks)]), ...(waitingForWords(item) === null ? [] : [waitingForWords(item)!]), ...(item.restartLine === null ? [] : [item.restartLine])];
  return parts.length === 0 ? null : parts.join(" \u00b7 ");
}

/** One filter: its choices side by side, each with how many rows it would show, the chosen one marked as pressed. */
function Choice<T extends string>({ name, choices, counts, value, onChange }: { name: string; choices: readonly { value: T; label: string }[]; counts: Record<T, number> | null; value: T; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={name} className="flex max-w-full overflow-x-auto rounded-lg bg-fill p-0.5">
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-pressed={choice.value === value}
          onClick={() => onChange(choice.value)}
          className={cn("flex h-(--control) shrink-0 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset", choice.value === value && "bg-background font-semibold text-foreground")}
        >
          {choice.label}
          {counts !== null && <span className="text-meta font-normal text-muted-foreground tabular-nums">{counts[choice.value]}</span>}
        </button>
      ))}
    </div>
  );
}

/** What a menu item asked for that needs a dialog: Cancel's confirmation, or Rename's name. */
type Asking = { kind: "cancel"; item: Extract<WorkItem, { kind: "run" }> } | { kind: "rename"; item: Extract<WorkItem, { kind: "chat" }> } | null;

/** The longest name a chat can be given; the server holds the same limit (src/engine/chats.ts). */
const MAX_TITLE = 80;

/** Rename a chat: a name of the owner's own in place of the chat's first message; an empty one gives it back. Only the name is stored. */
function RenameChat({ chat, onDone, onSignedOut }: { chat: Extract<WorkItem, { kind: "chat" }>; onDone: (renamed: { named: boolean } | null) => void; onSignedOut: () => void }) {
  const [value, setValue] = useState(chat.named ? chat.title : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    renameChat(chat.id, value).then(onDone, (err: unknown) => {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setProblem(`The chat was not renamed. ${err instanceof ApiError ? err.message : "Botbench could not be reached."}`);
    });
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && onDone(null)}>
      <AlertDialogContent data-testid="rename-chat">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-heading font-semibold">Rename the chat</AlertDialogTitle>
            <AlertDialogDescription id={`${id}-about`}>{`Up to ${MAX_TITLE} characters. Leave it empty to name the chat by its first message again. The messages stay as they are.`}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-name`}>Chat name</Label>
            <Input id={`${id}-name`} name="title" autoComplete="off" autoFocus maxLength={MAX_TITLE} value={value} onChange={(event) => setValue(event.target.value)} aria-invalid={problem !== null || undefined} aria-describedby={problem === null ? `${id}-about` : `${id}-about ${id}-error`} />
            {problem !== null && (
              <p id={`${id}-error`} role="alert" className="text-meta text-destructive">
                {problem}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving" : "Save name"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A row's More menu: what is real for the row now, the item that takes something away last, below a divider. */
function RowMenu({ item, hiddenView, onAction }: { item: WorkItem; hiddenView: boolean; onAction: (action: RowAction) => void }) {
  const items = rowMenu(item, hiddenView);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className="size-(--control) px-0 text-muted-foreground" />}>
        <Ellipsis aria-hidden="true" />
        <span data-ds-content="" className="sr-only">
          {moreName(item)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        {items.map((entry) => (
          <div key={entry.action}>
            {entry.danger && <DropdownMenuSeparator />}
            <DropdownMenuItem variant={entry.danger ? "destructive" : "default"} onClick={() => onAction(entry.action)} className="min-h-(--control) gap-2 px-3">
              {entry.icon === "copy" ? <Copy aria-hidden="true" /> : entry.icon === "external-link" ? <ExternalLink aria-hidden="true" /> : null}
              {entry.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function WorkScreen({ state: opened, onSignedOut }: { state: WorkState | null; onSignedOut: () => void }) {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<WorkKind>("all");
  const [state, setState] = useState<WorkState>(opened ?? "any");
  const [hiddenView, setHiddenView] = useState(false);
  /** The newest answer, for the counts, and every row read so far: the first page and each older one asked for. */
  const [page, setPage] = useState<WorkPage | null>(null);
  const [rows, setRows] = useState<WorkItem[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  /** What the last menu action did, or why it did not. */
  const [said, setSaid] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [now, setNow] = useState(() => Date.now());
  const [watchRefresh, setWatchRefresh] = useState(0);
  const changes = useContext(WorkChangesContext);
  const reads = useRef(0);
  const shown = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  // The search is sent once the typing pauses, so a word is one request, not one for each letter.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(typed.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const failedWith = useCallback(
    (what: string) => (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      setSaid({ tone: "error", text: `${what} ${err instanceof ApiError ? err.message : "Botbench could not be reached."}` });
    },
    [onSignedOut],
  );

  /** Read the list from its newest row, as many rows as are on the screen now, so a live update never drops the older rows the owner asked for. */
  const load = useCallback((): void => {
    const read = ++reads.current;
    getWork({ q, kind, state, hidden: hiddenView, limit: Math.min(MOST, Math.max(PAGE, shown.current)) }).then(
      (found) => {
        if (read !== reads.current) return;
        setPage(found);
        setRows(found.items);
        shown.current = found.items.length;
        setFailed(null);
        setNow(Date.now());
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (read !== reads.current) return;
        setFailed(err instanceof ApiError ? `Work could not be read. ${err.message}` : "Work could not be read: Botbench could not be reached.");
      },
    );
  }, [q, kind, state, hiddenView, onSignedOut]);
  // A new search or filter starts from the first page again.
  useEffect(() => {
    shown.current = 0;
  }, [q, kind, state, hiddenView]);
  useEffect(load, [load, changes]);

  // The issues proposed as runs are read again when the watch says so: that news is on live updates, as a run's is.
  useEffect(() => {
    const again = (): void => setWatchRefresh((n) => n + 1);
    return openEventStream(0, { onEvent: () => {}, onConnection: (connected) => connected && again(), onSignedOut, onRun: again, onWatch: again });
  }, [onSignedOut]);

  const showOlder = (): void => {
    if (page?.next == null || older) return;
    setOlder(true);
    const read = ++reads.current;
    getWork({ q, kind, state, hidden: hiddenView, cursor: page.next }).then(
      (found) => {
        setOlder(false);
        if (read !== reads.current) return;
        setPage(found);
        setRows((have) => {
          shown.current = have.length + found.items.length;
          return [...have, ...found.items];
        });
      },
      (err: unknown) => {
        setOlder(false);
        failedWith("The older rows could not be read.")(err);
      },
    );
  };

  // The heading is drawn at once, before the list is read, so it takes focus on arrival as any screen's does.
  useEffect(() => {
    document.title = tabTitle("Work");
    arrive(heading.current);
  }, []);

  const act = (item: WorkItem, action: RowAction): void => {
    setSaid(null);
    const name = item.kind === "chat" ? "the chat" : `${item.kind} ${item.id}`;
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
        setSaid({ tone: "status", text: hide ? `Hidden from the list: ${name}. Nothing was deleted; Show hidden lists it.` : `Back in the list: ${name}.` });
        load();
      }, failedWith(hide ? "It was not hidden." : "It was not shown again."));
    }
  };

  const filtered = q !== "" || kind !== "all" || state !== "any";
  const switchView = (hidden: boolean): void => {
    setSaid(null);
    setPage(null);
    setRows([]);
    setHiddenView(hidden);
  };

  return (
    <NextShell open={null} current="Work" bar={<span className="text-sm font-semibold">Work</span>}>
      <main className="@container mx-auto w-full max-w-[76rem] px-4 pt-6 pb-16 md:px-8">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 ref={heading} tabIndex={-1} className="text-title font-semibold tracking-tight outline-none">
            Work
          </h1>
          {page !== null && (
            <p data-testid="work-about" className="min-w-0 flex-1 text-meta text-muted-foreground @max-2xl:order-last @max-2xl:basis-full">
              {aboutLine(page.all, hiddenView)}
            </p>
          )}
          {/* A run starts in the composer, as it always did from here. */}
          <a href="#/turn?start=run" className={cn(buttonVariants({ variant: "outline" }), "ml-auto")}>
            <Plus aria-hidden="true" />
            New run
          </a>
        </div>
        {!hiddenView && (
          <div className="mt-4 empty:hidden">
            <Proposals refresh={watchRefresh} onSignedOut={onSignedOut} />
          </div>
        )}
        <div className="mt-4 flex flex-col gap-3 @4xl:flex-row @4xl:items-center">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Search titles" placeholder="Search titles" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} className="pl-9" />
          </div>
          <Choice name="Kind" choices={KINDS} counts={page?.counts.kind ?? null} value={kind} onChange={setKind} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Choice name="State" choices={STATES} counts={page?.counts.state ?? null} value={state} onChange={setState} />
          {page !== null && (
            <p data-testid="work-shown" aria-live="polite" className="text-meta text-muted-foreground tabular-nums">
              {shownLine(rows.length, page.total)}
            </p>
          )}
        </div>
        {failed !== null && (
          <p role="alert" className="mt-4 text-base text-destructive">
            {failed}
          </p>
        )}
        {page === null ? (
          failed === null && (
            <div role="status" aria-label="Reading Work" className="mt-4">
              <Skeleton className="h-64 w-full" />
            </div>
          )
        ) : rows.length === 0 ? (
          <p data-testid="work-none" className="mt-6 text-base text-muted-foreground">
            {noneLine(page, filtered, hiddenView)}
          </p>
        ) : (
          <Card className="mt-4 gap-0 overflow-hidden py-0">
            {/*
              The title is the column that takes what is left, and it keeps at least 45% of the table from 42rem up. The
              others are fixed and give way for it: under 56rem the kind is said under the title and the state has the
              room of two lines; the agent has a column from 69rem and the repository from 85rem, where the title still
              has its share beside them (the screen is 72rem at its widest today, so the repository waits for a wider one).
            */}
            <Table data-testid="work-table" className="table-fixed text-sm">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-11 px-4 text-meta font-semibold text-muted-foreground @2xl:w-40 @4xl:w-52">
                    <span className="@max-2xl:sr-only">State</span>
                  </TableHead>
                  <TableHead className="px-2 text-meta font-semibold text-muted-foreground">Title</TableHead>
                  <TableHead className="w-24 px-2 text-meta font-semibold text-muted-foreground @max-4xl:hidden">Kind</TableHead>
                  <TableHead className="w-28 px-2 text-meta font-semibold text-muted-foreground @max-[69rem]:hidden">Agent</TableHead>
                  <TableHead className="w-36 px-2 text-meta font-semibold text-muted-foreground @max-[85rem]:hidden">Repository</TableHead>
                  <TableHead className="w-32 px-2 text-right text-meta font-semibold text-muted-foreground @max-lg:hidden">Last change</TableHead>
                  <TableHead className="w-14 px-2">
                    <span className="sr-only">More</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => {
                  const { icon: Icon, tone, strong } = look(item);
                  const word = stateWord(item);
                  const facts = rowFacts(item);
                  return (
                    <TableRow key={`${item.kind} ${item.id}`} data-testid="work-row">
                      <TableCell className="px-4 py-1 whitespace-normal">
                        <span className={cn("flex items-center gap-2.5", strong ? "font-semibold text-foreground" : "text-muted-foreground")}>
                          <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />
                          <span data-testid="work-state" className="min-w-0 leading-tight @max-2xl:sr-only">
                            {word}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="px-2 py-1 whitespace-normal">
                        <a href={hrefOf(item)} className="flex min-h-(--control) flex-col justify-center rounded-sm">
                          <span data-ds-content="" title={item.title} className="truncate text-foreground">
                            {item.title}
                          </span>
                          {/* Where the screen is narrow the columns that do not fit are one line under the title. */}
                          <span data-ds-content="" className="truncate text-meta text-muted-foreground @2xl:hidden">
                            {[word, ...(kindWord(item) === word ? [] : [kindWord(item)]), changed(item.updatedAt, now)].join(" \u00b7 ")}
                          </span>
                          {/* Between the phone's width and 56rem the kind has no column: it is said here. */}
                          <span data-testid="work-kind-line" className="truncate text-meta text-muted-foreground @max-2xl:hidden @4xl:hidden">
                            {kindWord(item)}
                          </span>
                          {facts !== null && (
                            <span data-testid="work-facts" title={facts} className="truncate text-meta text-muted-foreground">
                              {facts}
                            </span>
                          )}
                        </a>
                      </TableCell>
                      <TableCell className="truncate px-2 py-1 text-muted-foreground @max-4xl:hidden">{kindWord(item)}</TableCell>
                      <TableCell title={agentWord(item)} className="truncate px-2 py-1 text-muted-foreground @max-[69rem]:hidden">
                        {agentWord(item)}
                      </TableCell>
                      <TableCell data-ds-content="" title={repoWord(item)} className="truncate px-2 py-1 text-muted-foreground @max-[85rem]:hidden">
                        {repoWord(item)}
                      </TableCell>
                      <TableCell title={changed(item.updatedAt, now)} className="truncate px-2 py-1 text-right text-muted-foreground tabular-nums @max-lg:hidden">
                        <time dateTime={item.updatedAt}>{changedShort(item.updatedAt, now)}</time>
                      </TableCell>
                      <TableCell className="px-2 py-1 text-right">
                        <RowMenu item={item} hiddenView={hiddenView} onAction={(action) => act(item, action)} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}
        {page?.older != null && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <Button variant="outline" onClick={showOlder} disabled={older}>
              {older ? "Reading" : "Show older"}
            </Button>
            <span data-testid="work-older" className="text-meta text-muted-foreground">
              {olderLine(page.older)}
            </span>
          </div>
        )}
        {said !== null && (
          <p role={said.tone === "error" ? "alert" : "status"} data-testid="row-said" className={cn("mt-4 text-base", said.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
            {said.text}
          </p>
        )}
        {page !== null && (hiddenView || page.hidden > 0) && (
          <div className="mt-4">
            <Button variant="ghost" onClick={() => switchView(!hiddenView)} className="-ml-4 text-muted-foreground">
              {hiddenView ? "Back to the list" : `Show hidden (${page.hidden})`}
            </Button>
          </div>
        )}
        {!hiddenView && (
          <div className="mt-8 empty:hidden">
            <OtherWorkbenches onSignedOut={onSignedOut} />
          </div>
        )}
        <DestructiveDialog
          open={asking?.kind === "cancel"}
          onOpenChange={(open) => !open && setAsking(null)}
          title="Cancel this run?"
          keepLabel="Keep run"
          confirmLabel="Cancel run"
          testId="cancel-run"
          onConfirm={() => {
            if (asking?.kind !== "cancel") return;
            const id = asking.item.id;
            setAsking(null);
            cancelRun(id).then(load, failedWith("The run was not cancelled."));
          }}
        >
          <p>{asking?.kind === "cancel" ? cancelStatement(asking.item.status, asking.item.taskCount) : ""}</p>
        </DestructiveDialog>
        {asking?.kind === "rename" && (
          <RenameChat
            chat={asking.item}
            onSignedOut={onSignedOut}
            onDone={(renamed) => {
              setAsking(null);
              if (renamed === null) return;
              setSaid({ tone: "status", text: renamed.named ? "The chat was renamed." : "The chat is named by its first message again." });
              load();
            }}
          />
        )}
      </main>
    </NextShell>
  );
}
