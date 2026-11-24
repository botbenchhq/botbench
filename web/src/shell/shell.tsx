import { useContext, useEffect, useState, type ReactNode } from "react";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { House, Layers, MessageSquare, Settings } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/ui/sidebar";
import { TooltipProvider } from "@/ui/tooltip";
import { getHomeCount } from "../api/client.ts";
import { ApprovalsContext, PeerChangesContext, WorkChangesContext } from "../app/approvals.tsx";
import { Mark } from "../brand/mark.tsx";
import { useNextRoot } from "./use-next-root.ts";

/** The screens that exist today, by the names they have everywhere else (components/header.tsx, docs/product/voice.md). */
const SCREENS = [
  { label: "Home", href: "#/", icon: House },
  { label: "Work", href: "#/work", icon: Layers },
  { label: "Chat", href: "#/turn", icon: MessageSquare },
  { label: "Settings", href: "#/settings", icon: Settings },
] as const;

/**
 * The frame of a screen rebuilt on shadcn/ui (ADR 0012): the navigation at the left as shadcn/ui's sidebar (a sheet
 * behind the menu button under 768px), and the screen beside it. `current` is the screen of the navigation that is
 * shown, when it is one of them. `open` is the work the screen shows, named in the
 * navigation under Open. `bar` is the screen's own line at the top: where it is, and its state. `aside` is its pane at the right.
 *
 * A request that waits for the owner's answer is never hidden by a rebuilt screen: the bar links to the task that
 * waits, where its card is.
 *
 * Base UI is told to write no <style> element (`disableStyleElements`): Botbench's content security policy refuses
 * one, and the two components that would write one (the scroll area, and a select aligned to its trigger) are not used.
 */
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

export function NextShell({ open, bar, aside, current, children }: { open: { title: string; href: string } | null; bar: ReactNode; aside?: ReactNode; current?: "Home" | "Work"; children: ReactNode }) {
  useNextRoot();
  const needsYou = useNeedsYou();
  const { pending } = useContext(ApprovalsContext);
  const waiting = pending?.[0];
  return (
    <CSPProvider disableStyleElements>
      <TooltipProvider>
        <SidebarProvider>
          <Sidebar>
            <SidebarHeader className="px-4 pt-4">
              <a href="#/" className="flex min-h-(--control-small) items-center gap-2 text-base font-semibold tracking-tight">
                <Mark />
                Botbench
              </a>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <nav aria-label="Screens">
                    <SidebarMenu>
                      {SCREENS.map((screen) => (
                        <SidebarMenuItem key={screen.href}>
                          <SidebarMenuButton isActive={screen.label === current} render={<a href={screen.href} aria-current={screen.label === current ? "page" : undefined} />} className="h-9 gap-3 px-3 text-muted-foreground hover:text-foreground data-active:bg-sidebar-accent data-active:font-semibold data-active:text-foreground">
                            <screen.icon aria-hidden="true" />
                            <span>{screen.label}</span>
                            {/* What waits for the owner, counted by the server: a small amber number, never a band. */}
                            {screen.label === "Home" && needsYou !== null && needsYou > 0 && (
                              <span data-testid="home-count" className="ml-auto text-xs font-semibold text-attention tabular-nums">
                                {needsYou}
                                <span className="sr-only"> waiting for you</span>
                              </span>
                            )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </nav>
                </SidebarGroupContent>
              </SidebarGroup>
              {open !== null && (
                <SidebarGroup>
                  <SidebarGroupLabel className="text-meta font-semibold text-muted-foreground">Open</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton isActive render={<a href={open.href} aria-current="page" />} className="h-auto min-h-9 items-start gap-3 px-3 py-2 font-semibold data-active:bg-sidebar-accent">
                          <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-attention" />
                          {/* A div, not a span: the menu button cuts its last span to one line, and a task's title is read whole on two. */}
                          <div data-ds-content="" className="line-clamp-2 min-w-0">
                            {open.title}
                          </div>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              )}
            </SidebarContent>
          </Sidebar>
          {/* From 1280px the screen's own pane (`aside`), when it has one, stands beside its main column at full height; under that it follows it. */}
          <SidebarInset className={aside === undefined ? "min-w-0" : "min-w-0 xl:grid xl:grid-cols-[minmax(0,1fr)_21.25rem]"}>
            <div className="flex min-w-0 flex-col">
            <div className="flex min-h-14 items-center gap-3 border-b px-4 md:px-8 xl:border-b-0">
              <SidebarTrigger className="size-(--control) md:hidden" />
              {bar}
              {waiting !== undefined && waiting.taskId !== null && (
                <Badge variant="outline" render={<a href={`#/tasks/${waiting.taskId}`} />} className="ml-auto h-(--control-small) border-attention/50 bg-attention-subtle text-attention">
                  {`Needs input: task ${waiting.taskId}`}
                </Badge>
              )}
            </div>
            {children}
            </div>
            {aside}
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </CSPProvider>
  );
}
