import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { House, Layers, Menu, MessageSquare, Moon, PanelBottomOpen, Plus, Settings, Sun } from "lucide-react";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/ui/lib/utils";
import { getAgents, getHomeCount, getWorkbench, type PeerCard } from "../api/client.ts";
import { chooseAppearance, useAppearance } from "../app/appearance.ts";
import { ApprovalsContext, ConnectionContext, PeerChangesContext, WorkChangesContext } from "../app/approvals.tsx";
import { counted, number, plural } from "../app/format.ts";
import { PeerCardsContext } from "../app/peer-cards.tsx";
import { groupHref } from "../app/settings-groups.ts";
import { trayShows } from "../components/approval-tray.ts";
import { Mark } from "../brand/mark.tsx";
import { useNextRoot } from "./use-next-root.ts";

/** The screens, in the navigation's order, by the names they have everywhere else (docs/product/voice.md). `short` is the word in the bar at the foot of a phone, where five must fit. */
const SCREENS = [
  { label: "Home", short: "Home", href: "#/", icon: House },
  { label: "Work", short: "Work", href: "#/work", icon: Layers },
  { label: "Chat", short: "Chat", href: "#/turn", icon: MessageSquare },
  { label: "New chat or task", short: "New", href: "#/new", icon: Plus },
  { label: "Settings", short: "Settings", href: "#/settings", icon: Settings },
] as const;

type ScreenName = (typeof SCREENS)[number]["label"];

/** Whether the window matches `query`, followed as it changes. */
function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    () => window.matchMedia(query).matches,
  );
}

/** Whether the address is on `href`'s screen: Home at the bare address, a chat under Chat, a start of new work under New chat or task. */
function onScreen(hash: string, href: string): boolean {
  if (href === "#/") return hash === "" || hash === "#" || hash === "#/" || hash === "#/home";
  if (href === "#/turn") return hash === "#/turn" || hash.startsWith("#/chats/");
  if (href === "#/new") return hash === "#/new" || hash.startsWith("#/turn?");
  return hash === href || hash.startsWith(`${href}/`) || hash.startsWith(`${href}?`);
}

function useHash(): string {
  return useSyncExternalStore(
    (changed) => {
      window.addEventListener("hashchange", changed);
      return () => window.removeEventListener("hashchange", changed);
    },
    () => window.location.hash,
  );
}

/** The screen's pane at the right, while it stands in a sheet (under 1024px): how its own buttons open it. */
const Inspector = createContext<{ inSheet: boolean; open: () => void; close: () => void }>({ inSheet: false, open: () => {}, close: () => {} });

/** For a control inside the screen's pane that sends the reader to the main column: whether the pane is a sheet now, and how to close it first. */
export const useInspector = (): { inSheet: boolean; close: () => void } => useContext(Inspector);

/**
 * A button that opens the screen's pane where it stands in a sheet, under 1024px; nothing from 1024px, where the pane
 * is in view. For a screen's own foot (`foot`), beside its main action.
 */
export function InspectorButton({ children, className, quiet = false }: { children: ReactNode; className?: string; quiet?: boolean }) {
  const inspector = useContext(Inspector);
  if (!inspector.inSheet) return null;
  return (
    <Button variant={quiet ? "ghost" : "outline"} size={quiet ? "sm" : "default"} className={className} onClick={inspector.open}>
      <PanelBottomOpen aria-hidden="true" />
      {children}
    </Button>
  );
}

/** The screens, as links. `rail`: icons alone, each named on hover and focus, from 1024 to 1279px. `bar`: the bar at the foot under 768px. */
function Screens({ look, shown, needsYou, onFollow }: { look: "list" | "rail" | "bar"; shown: ScreenName | undefined; needsYou: number | null; onFollow: () => void }) {
  const hash = useHash();
  return (
    <nav aria-label="Screens">
      <ul className={look === "bar" ? "flex" : "flex flex-col gap-0.5"}>
        {SCREENS.map((screen) => {
          const current = shown === undefined ? onScreen(hash, screen.href) : screen.label === shown;
          const count = screen.label === "Home" && needsYou !== null && needsYou > 0 ? needsYou : null;
          const link = (
            <a
              href={screen.href}
              // A link to the screen already shown changes no address: the menu it was followed from is closed here.
              onClick={onFollow}
              aria-current={current ? "page" : undefined}
              // The rail has no words and the bar a short one: the link is named in full for a screen reader either way.
              aria-label={look === "rail" || (look === "bar" && screen.short !== screen.label) ? (count === null ? screen.label : `${screen.label}, ${count} waiting for you`) : undefined}
              className={cn(
                "flex items-center text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:text-foreground",
                look === "bar" ? "min-h-14 flex-col justify-center gap-1 text-xs aria-[current=page]:font-semibold aria-[current=page]:text-primary" : "min-h-9 gap-3 rounded-lg px-3 hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent pointer-coarse:min-h-11",
                look === "rail" && "size-10 justify-center px-0 pointer-coarse:size-11",
              )}
            >
              <span className="relative flex shrink-0">
                <screen.icon aria-hidden="true" className="size-4" />
                {/* Where the navigation has no room for the number: a dot on the icon, the number in the link's name. */}
                {count !== null && look !== "list" && <span aria-hidden="true" className="absolute -top-1 -right-1 size-2 rounded-full bg-attention" />}
              </span>
              {look !== "rail" && <span>{look === "bar" ? screen.short : screen.label}</span>}
              {/* What waits for the owner, counted by the server: a small amber number, never a band. */}
              {count !== null && look === "list" && (
                <span data-testid="home-count" className="ml-auto text-xs font-semibold text-attention tabular-nums">
                  {count}
                  <span className="sr-only"> waiting for you</span>
                </span>
              )}
              {count !== null && look === "bar" && <span className="sr-only">{`, ${count} waiting for you`}</span>}
            </a>
          );
          return (
            <li key={screen.href} className={look === "bar" ? "flex-1" : undefined}>
              {look === "rail" ? (
                <Tooltip>
                  <TooltipTrigger render={link} />
                  <TooltipContent side="right">{screen.label}</TooltipContent>
                </Tooltip>
              ) : (
                link
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The foot of the navigation: this workbench by its name, how many of its agents can work now, and the appearance
 * switch. The name and the agents are read from Botbench; while they are not read, or cannot be, only the switch is
 * shown (the screen itself says when Botbench cannot be reached).
 */
function Workbench({ rail }: { rail: boolean }) {
  const [name, setName] = useState<string | null>(null);
  const [agents, setAgents] = useState<number | null>(null);
  const { drawn } = useAppearance();
  useEffect(() => {
    let gone = false;
    getWorkbench().then((workbench) => !gone && setName(workbench.name), () => {});
    getAgents().then((list) => !gone && setAgents(list.filter((agent) => agent.problem === null).length), () => {});
    return () => void (gone = true);
  }, []);
  const to = drawn === "dark" ? "light" : "dark";
  return (
    <div data-testid="workbench" className={cn("flex items-center gap-3 border-t p-3", rail && "flex-col")}>
      {name !== null && (
        <a href={groupHref("identity")} aria-label={rail ? `Workbench ${name}` : undefined} className={cn("flex min-h-(--control) min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50", rail && "flex-none")}>
          <span aria-hidden="true" data-ds-content="" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary uppercase">
            {name.slice(0, 1)}
          </span>
          {!rail && (
            <span className="flex min-w-0 flex-col">
              <span data-ds-content="" title={name} className="truncate text-sm font-semibold">
                {name}
              </span>
              {agents !== null && <span className="text-xs text-muted-foreground">{`${counted(agents, "agent", "agents")} available`}</span>}
            </span>
          )}
        </a>
      )}
      <Button variant="ghost" size="icon" className={cn("size-(--control) text-muted-foreground", name === null && !rail && "ml-auto")} aria-label={`Switch to the ${to} appearance`} onClick={() => chooseAppearance(to)}>
        {drawn === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </Button>
    </div>
  );
}

/** The work the screen shows, named in the navigation under Open. */
function OpenWork({ open, rail }: { open: { title: string; href: string }; rail: boolean }) {
  const link = (
    <a href={open.href} aria-current="page" aria-label={rail ? open.title : undefined} title={rail ? undefined : open.title} className={cn("flex min-h-9 items-start gap-3 rounded-lg bg-sidebar-accent px-3 py-2 text-sm font-semibold pointer-coarse:min-h-11 pointer-coarse:py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50", rail && "size-10 items-center justify-center p-0 pointer-coarse:size-11 pointer-coarse:py-0")}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full bg-attention", !rail && "mt-1.5")} />
      {!rail && (
        <span data-ds-content="" className="line-clamp-2 min-w-0">
          {open.title}
        </span>
      )}
    </a>
  );
  return (
    <div className="flex flex-col gap-1">
      {!rail && <p className="px-3 text-meta font-semibold text-muted-foreground">Open</p>}
      {rail ? (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipContent side="right" data-ds-content="">
            {open.title}
          </TooltipContent>
        </Tooltip>
      ) : (
        link
      )}
    </div>
  );
}

/**
 * What waits for the owner's answer, said on every screen: the approvals and questions of every task, run planner and
 * chat, counted, as a link to Home, whose Needs you lists each one. With none of those, the messages with the paired
 * workbench that wait, which stand on Home too. `here`: every request waiting is shown on this screen already, so only
 * a screen reader hears that it is. Empty, it stays in the page as the live region that announces the next one. When
 * the approvals could not be read, it says so. `row`: drawn as a line of its own under the bar (under 768px), where the
 * bar has no room for a sentence.
 */
function Waiting({ showing, cardsShown, home, row }: { showing: readonly number[]; cardsShown: ((card: PeerCard) => boolean) | undefined; home: boolean; row: boolean }) {
  const { pending, problem } = useContext(ApprovalsContext);
  const peerCards = (useContext(PeerCardsContext).cards ?? []).filter((card) => cardsShown?.(card) !== true).length;
  const shows = trayShows({ pending, showing: home ? (pending ?? []).map((approval) => approval.id) : showing, problem });
  const count = pending?.length ?? 0;
  const link = "inline-flex items-center gap-1 rounded-md border border-attention/50 bg-attention-subtle px-2 text-xs font-medium text-attention outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
  const size = row ? "min-h-11 w-full rounded-none border-x-0 border-t-0 px-4" : "min-h-(--control-small) pointer-coarse:min-h-11";
  return (
    // With nothing to show but a screen reader's sentence, it takes no room in the bar.
    <div data-testid="approval-tray" aria-live="polite" aria-atomic="true" className={shows === "here" ? "sr-only" : row ? "empty:hidden" : "shrink-0 empty:hidden"}>
      {shows === "here" ? (
        <span className="sr-only">{plural(count, "An approval is waiting on this screen.", `${number(count)} approvals are waiting on this screen.`)}</span>
      ) : shows === "tray" && count > 0 ? (
        <a href="#/" data-testid="needs-input" className={cn(link, size)}>
          <span className="font-semibold tabular-nums">{number(count)}</span>
          {plural(count, " approval is waiting. Open it.", " approvals are waiting. Open them.")}
        </a>
      ) : shows === "tray" ? (
        <span className={cn("inline-flex items-center text-xs text-muted-foreground", row && "min-h-11 px-4")}>{problem}</span>
      ) : peerCards > 0 && !home ? (
        <a href="#/" data-testid="tray-peer-cards" className={cn(link, size)}>
          <span className="font-semibold tabular-nums">{number(peerCards)}</span>
          {plural(peerCards, " message with the paired workbench waits for you. Open it.", " messages with the paired workbench wait for you. Open them.")}
        </a>
      ) : null}
    </div>
  );
}

/**
 * How many things need the owner, as the server counts them (/api/home/count), for Home's mark in the navigation. Read
 * again whenever live updates say a run, a task, an approval or a paired workbench's message changed. Null until it is
 * known, and when it cannot be read: no mark is drawn then, never a wrong one.
 */
function useNeedsYou(): number | null {
  const work = useContext(WorkChangesContext);
  const peers = useContext(PeerChangesContext);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    getHomeCount().then(
      (found) => current && setCount(found.needsYou),
      () => current && setCount(null),
    );
    return () => void (current = false);
  }, [work, peers]);
  return count;
}

/**
 * The frame of every screen (ADR 0012), in the four layouts of the approved design (board V2Widths):
 *
 *   1280px and wider   three panes: the navigation with its labels (264px), the screen, the screen's own pane (`aside`).
 *   1024 to 1279px     two panes and a rail: the navigation as icons, each named on hover and focus; `aside` still in view.
 *   768 to 1023px      one pane: the navigation behind the menu button in the bar; `aside` in a sheet, opened from the foot.
 *   under 768px        one pane: the navigation as a bar at the foot; `aside` in a sheet, opened from the foot.
 *
 * `current` is the screen of the navigation that is shown, when the address alone does not say it. `open` is the work
 * the screen shows, named in the navigation under Open. `side` is a screen's own navigation (Settings' six groups):
 * from 1024px it stands in the navigation's pane, at its full width, in place of the screens; under that the screens
 * are where they always are. `bar` is the screen's own line at the top: where it is, and its state. `aside` is its
 * pane at the right, named `asideLabel` where it is a sheet; a screen without one has the whole width. `foot` is what
 * stays in reach at the foot of the window under 1024px: the screen's main action, and an <InspectorButton> for the
 * rest; a screen that gives an `aside` and no `foot` gets that button alone.
 *
 * A request that waits for the owner's answer is never hidden by a screen: the bar counts every one that is not on
 * this screen (`showing` holds the ids of those that are; a task's and a run's own are found by `open`) and links to
 * Home, where each is listed; with none, the paired workbench's messages that wait, but for those the screen shows
 * (`cardsShown`). Under the bar, while live updates are down, a line says so.
 *
 * Base UI is told to write no <style> element (`disableStyleElements`): Botbench's content security policy refuses
 * one, and the two components that would write one (the scroll area, and a select aligned to its trigger) are not used.
 */
export function NextShell({ open, bar, aside, current, side, showing, cardsShown, asideLabel = "Details", foot, children }: { open: { title: string; href: string } | null; bar: ReactNode; aside?: ReactNode; current?: ScreenName; side?: ReactNode; showing?: readonly number[]; cardsShown?: (card: PeerCard) => boolean; asideLabel?: string; foot?: ReactNode; children: ReactNode }) {
  useNextRoot();
  const needsYou = useNeedsYou();
  const { pending } = useContext(ApprovalsContext);
  const connected = useContext(ConnectionContext);
  const twoPanes = useMedia("(min-width: 1024px)");
  const wide = useMedia("(min-width: 1280px)");
  const tablet = useMedia("(min-width: 768px)");
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState(false);
  const has = aside !== undefined && aside !== null && aside !== false;
  const own = side !== undefined && side !== null && side !== false;
  // A screen's own navigation is words, so the pane keeps its full width for it.
  const labels = wide || own;
  // The sheets belong to the narrow layouts: a window made wider closes them.
  useEffect(() => {
    if (twoPanes) (setMenu(false), setSheet(false));
  }, [twoPanes]);
  const hash = useHash();
  useEffect(() => setMenu(false), [hash]);
  // The requests this screen shows itself: those it names, and those of the task or the run it is.
  const here = showing ?? (pending ?? []).filter((approval) => open !== null && (approval.taskId !== null ? `#/tasks/${approval.taskId}` : approval.runId !== null ? `#/runs/${approval.runId}` : null) === open.href).map((approval) => approval.id);
  const home = current === "Home" || (current === undefined && onScreen(hash, "#/"));
  const screens = (look: "list" | "rail" | "bar") => <Screens look={look} shown={current} needsYou={needsYou} onFollow={() => setMenu(false)} />;

  return (
    <CSPProvider disableStyleElements>
      <TooltipProvider>
        <Inspector.Provider value={{ inSheet: has && !twoPanes, open: () => setSheet(true), close: () => setSheet(false) }}>
          <div data-shell={twoPanes ? (wide ? "three" : "two") : "one"} className="flex min-h-svh">
            {twoPanes && (
              <div data-testid="shell-side" className={cn("sticky top-0 flex h-svh shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground", labels ? "w-66" : "w-16")}>
                {/* The slot's name is the one the navigation's head had as shadcn/ui's sidebar: the brand tests find the mark by it. */}
                <div data-slot="sidebar-header">
                  <a href="#/" aria-label={labels ? undefined : "Botbench"} className={cn("flex min-h-14 items-center gap-2 px-4 text-base font-semibold tracking-tight", !labels && "justify-center px-0")}>
                    <Mark size={20} />
                    {labels && "Botbench"}
                  </a>
                </div>
                <div className={cn("flex flex-1 flex-col gap-6 overflow-y-auto p-2", !labels && "items-center")}>
                  {own ? side : screens(labels ? "list" : "rail")}
                  {open !== null && <OpenWork open={open} rail={!labels} />}
                </div>
                <Workbench rail={!labels} />
              </div>
            )}
            <div className={cn("min-w-0 flex-1", twoPanes && has && "grid grid-cols-[minmax(0,1fr)_19.5rem] min-[1440px]:grid-cols-[minmax(0,1fr)_21.25rem]")}>
              <div className="flex min-h-svh min-w-0 flex-col">
                <div className="flex min-h-14 items-center gap-3 border-b px-4 md:px-6 lg:border-b-0 min-[1440px]:px-8">
                  {!twoPanes && (
                    <Button variant="ghost" size="icon" className="size-(--control) max-md:hidden" aria-label="Screens menu" onClick={() => setMenu(true)}>
                      <Menu aria-hidden="true" />
                    </Button>
                  )}
                  {/* The screen's own line keeps the room that is left, so what it sets at its right end stays beside what waits, at the bar's right. */}
                  <div className="flex min-w-0 flex-1 items-center gap-3">{bar}</div>
                  {tablet && <Waiting showing={here} cardsShown={cardsShown} home={home} row={false} />}
                </div>
                {!tablet && <Waiting showing={here} cardsShown={cardsShown} home={home} row />}
                {!connected && (
                  <p role="status" data-testid="stream-banner" className="border-b bg-fill px-4 py-1.5 text-meta text-muted-foreground md:px-6 min-[1440px]:px-8">
                    Live updates are disconnected. Reconnecting.
                  </p>
                )}
                <div className="flex flex-1 flex-col">{children}</div>
                {!twoPanes && (foot !== undefined || has) && (
                  <div data-testid="foot" className="sticky bottom-0 z-10 border-t bg-pane px-4 py-3 max-md:bottom-14 md:px-6">
                    <div className="mx-auto flex max-w-[47.5rem] flex-col gap-2">{foot ?? <InspectorButton>{asideLabel}</InspectorButton>}</div>
                  </div>
                )}
                {!tablet && <div className="sticky bottom-0 z-10 border-t bg-sidebar">{screens("bar")}</div>}
              </div>
              {twoPanes && has && aside}
            </div>
          </div>
          {!twoPanes && (
            <Sheet open={menu} onOpenChange={setMenu}>
              <SheetContent side="left" className="w-66 gap-0 bg-sidebar p-0">
                <SheetTitle className="flex min-h-14 items-center gap-2 px-4 text-base font-semibold tracking-tight">
                  <Mark size={20} />
                  Botbench
                </SheetTitle>
                <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-2">
                  {screens("list")}
                  {open !== null && <OpenWork open={open} rail={false} />}
                </div>
                <Workbench rail={false} />
              </SheetContent>
            </Sheet>
          )}
          {!twoPanes && has && (
            <Sheet open={sheet} onOpenChange={setSheet}>
              <SheetContent side="bottom" className="max-h-[88svh] gap-0 overflow-y-auto rounded-t-2xl p-0">
                <SheetTitle className="px-4 pt-4 text-meta font-semibold text-muted-foreground md:px-6">{asideLabel}</SheetTitle>
                {aside}
              </SheetContent>
            </Sheet>
          )}
        </Inspector.Provider>
      </TooltipProvider>
    </CSPProvider>
  );
}
