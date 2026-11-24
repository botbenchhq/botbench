import { useContext, type ReactNode } from "react";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { Layers, MessageSquare, Settings } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/ui/sidebar";
import { TooltipProvider } from "@/ui/tooltip";
import { ApprovalsContext } from "../app/approvals.tsx";
import { Mark } from "../brand/mark.tsx";
import { useNextRoot } from "./use-next-root.ts";

/** The screens that exist today, by the names they have everywhere else (components/header.tsx, docs/product/voice.md). */
const SCREENS = [
  { label: "Chat", href: "#/turn", icon: MessageSquare },
  { label: "Work", href: "#/work", icon: Layers },
  { label: "Settings", href: "#/settings", icon: Settings },
] as const;

/**
 * The frame of a screen rebuilt on shadcn/ui (ADR 0012): the navigation at the left as shadcn/ui's sidebar (a sheet
 * behind the menu button under 768px), and the screen beside it. `open` is the work the screen shows, named in the
 * navigation under Open. `bar` is the screen's own line at the top: where it is, and its state. `aside` is its pane at the right.
 *
 * A request that waits for the owner's answer is never hidden by a rebuilt screen: the bar links to the task that
 * waits, where its card is.
 *
 * Base UI is told to write no <style> element (`disableStyleElements`): Botbench's content security policy refuses
 * one, and the two components that would write one (the scroll area, and a select aligned to its trigger) are not used.
 */
export function NextShell({ open, bar, aside, children }: { open: { title: string; href: string } | null; bar: ReactNode; aside?: ReactNode; children: ReactNode }) {
  useNextRoot();
  const { pending } = useContext(ApprovalsContext);
  const waiting = pending?.[0];
  return (
    <CSPProvider disableStyleElements>
      <TooltipProvider>
        <SidebarProvider>
          <Sidebar>
            <SidebarHeader className="px-4 pt-4">
              <a href="#/turn" className="flex min-h-(--control-small) items-center gap-2 text-base font-semibold tracking-tight">
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
                          <SidebarMenuButton render={<a href={screen.href} />} className="h-9 gap-3 px-3 text-muted-foreground hover:text-foreground">
                            <screen.icon aria-hidden="true" />
                            <span>{screen.label}</span>
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
          {/* From 1280px the screen's own pane (`aside`) stands beside its main column at full height; under that it follows it. */}
          <SidebarInset className="min-w-0 xl:grid xl:grid-cols-[minmax(0,1fr)_21.25rem]">
            <div className="flex min-w-0 flex-col">
            <div className="flex min-h-14 items-center gap-3 border-b px-4 md:px-8 xl:border-b-0">
              <SidebarTrigger className="size-(--control) md:hidden" />
              {bar}
              {waiting !== undefined && waiting.taskId !== null && (
                <Badge variant="outline" render={<a href={`#/tasks/${waiting.taskId}`} />} className="ml-auto border-attention/50 bg-attention-subtle text-attention">
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
