import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { Layers, Menu, MessageSquare, Moon, PanelBottomOpen, Settings, Sun } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/ui/lib/utils";
import { getAgents, getWorkbench } from "../api/client.ts";
import { chooseAppearance, useAppearance } from "../app/appearance.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import { counted } from "../app/format.ts";
import { Mark } from "../brand/mark.tsx";
import { useNextRoot } from "./use-next-root.ts";

/** The screens that exist today, by the names they have everywhere else (components/header.tsx, docs/product/voice.md). */
const SCREENS = [
  { label: "Chat", href: "#/turn", icon: MessageSquare },
  { label: "Work", href: "#/work", icon: Layers },
  { label: "Settings", href: "#/settings", icon: Settings },
] as const;

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

/** Whether the address is on `href`'s screen. */
const onScreen = (hash: string, href: string): boolean => hash === href || hash.startsWith(`${href}/`) || hash.startsWith(`${href}?`) || (href === "#/turn" && (hash === "" || hash === "#/"));

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
function Screens({ look }: { look: "list" | "rail" | "bar" }) {
  const hash = useHash();
  return (
    <nav aria-label="Screens">
      <ul className={look === "bar" ? "flex" : "flex flex-col gap-0.5"}>
        {SCREENS.map((screen) => {
          const current = onScreen(hash, screen.href);
          const link = (
            <a
              href={screen.href}
              aria-current={current ? "page" : undefined}
              aria-label={look === "rail" ? screen.label : undefined}
              className={cn(
                "flex items-center text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:text-foreground",
                look === "bar" ? "min-h-14 flex-col justify-center gap-1 text-xs aria-[current=page]:font-semibold aria-[current=page]:text-primary" : "min-h-9 gap-3 rounded-lg px-3 hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent pointer-coarse:min-h-11",
                look === "rail" && "size-10 justify-center px-0 pointer-coarse:size-11",
              )}
            >
              <screen.icon aria-hidden="true" className="size-4 shrink-0" />
              {look !== "rail" && <span>{screen.label}</span>}
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
        <a href="#/settings/workbench" aria-label={rail ? `Workbench ${name}` : undefined} className={cn("flex min-h-(--control) min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50", rail && "flex-none")}>
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
 * The frame of a screen rebuilt on shadcn/ui (ADR 0012), in the four layouts of the approved design (board V2Widths):
 *
 *   1280px and wider   three panes: the navigation with its labels (264px), the screen, the screen's own pane (`aside`).
 *   1024 to 1279px     two panes and a rail: the navigation as icons, each named on hover and focus; `aside` still in view.
 *   768 to 1023px      one pane: the navigation behind the menu button in the bar; `aside` in a sheet, opened from the foot.
 *   under 768px        one pane: the navigation as a bar at the foot; `aside` in a sheet, opened from the foot.
 *
 * `open` is the work the screen shows, named in the navigation under Open. `bar` is the screen's own line at the top:
 * where it is, and its state. `aside` is its pane at the right, named `asideLabel` where it is a sheet. `foot` is what
 * stays in reach at the foot of the window under 1024px: the screen's main action, and an <InspectorButton> for the
 * rest; a screen that gives an `aside` and no `foot` gets that button alone.
 *
 * A request that waits for the owner's answer is never hidden by a rebuilt screen: the bar links to the task that
 * waits, where its card is.
 *
 * Base UI is told to write no <style> element (`disableStyleElements`): Botbench's content security policy refuses
 * one, and the two components that would write one (the scroll area, and a select aligned to its trigger) are not used.
 */
export function NextShell({ open, bar, aside, asideLabel = "Details", foot, children }: { open: { title: string; href: string } | null; bar: ReactNode; aside?: ReactNode; asideLabel?: string; foot?: ReactNode; children: ReactNode }) {
  useNextRoot();
  const { pending } = useContext(ApprovalsContext);
  // The oldest request of another task: this screen's own is on it already.
  const waiting = pending?.find((approval) => approval.taskId !== null && `#/tasks/${approval.taskId}` !== open?.href);
  const twoPanes = useMedia("(min-width: 1024px)");
  const labels = useMedia("(min-width: 1280px)");
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState(false);
  const has = aside !== undefined && aside !== null && aside !== false;
  // The sheets belong to the narrow layouts: a window made wider closes them.
  useEffect(() => {
    if (twoPanes) (setMenu(false), setSheet(false));
  }, [twoPanes]);
  const hash = useHash();
  useEffect(() => setMenu(false), [hash]);

  return (
    <CSPProvider disableStyleElements>
      <TooltipProvider>
        <Inspector.Provider value={{ inSheet: has && !twoPanes, open: () => setSheet(true), close: () => setSheet(false) }}>
          <div data-shell={twoPanes ? (labels ? "three" : "two") : "one"} className="flex min-h-svh">
            {twoPanes && (
              <div className={cn("sticky top-0 flex h-svh shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground", labels ? "w-66" : "w-16")}>
                <a href="#/turn" aria-label={labels ? undefined : "Botbench"} className={cn("flex min-h-14 items-center gap-2 px-4 text-base font-semibold tracking-tight", !labels && "justify-center px-0")}>
                  <Mark size={labels ? 16 : 20} />
                  {labels && "Botbench"}
                </a>
                <div className={cn("flex flex-1 flex-col gap-6 overflow-y-auto p-2", !labels && "items-center")}>
                  <Screens look={labels ? "list" : "rail"} />
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
                  {bar}
                  {waiting !== undefined && (
                    <Badge variant="outline" render={<a href={`#/tasks/${waiting.taskId}`} />} className="ml-auto border-attention/50 bg-attention-subtle text-attention pointer-coarse:h-11">
                      {`Needs input: task ${waiting.taskId}`}
                    </Badge>
                  )}
                </div>
                <div className="flex-1">{children}</div>
                {!twoPanes && (foot !== undefined || has) && (
                  <div data-testid="foot" className="sticky bottom-0 z-10 border-t bg-pane px-4 py-3 max-md:bottom-14 md:px-6">
                    <div className="mx-auto flex max-w-[47.5rem] flex-col gap-2">{foot ?? <InspectorButton>{asideLabel}</InspectorButton>}</div>
                  </div>
                )}
                {!twoPanes && (
                  <div className="sticky bottom-0 z-10 border-t bg-sidebar md:hidden">
                    <Screens look="bar" />
                  </div>
                )}
              </div>
              {twoPanes && has && aside}
            </div>
          </div>
          {!twoPanes && (
            <Sheet open={menu} onOpenChange={setMenu}>
              <SheetContent side="left" className="w-66 gap-0 bg-sidebar p-0">
                <SheetTitle className="flex min-h-14 items-center gap-2 px-4 text-base font-semibold tracking-tight">
                  <Mark />
                  Botbench
                </SheetTitle>
                <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-2">
                  <Screens look="list" />
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
