import { ArrowLeft, BarChart3, Cpu, Link2, ShieldCheck, SquareTerminal, UserRound, type LucideIcon } from "lucide-react";
import { cn } from "@/ui/lib/utils";
import { GROUPS, groupHref, type SettingsGroup } from "../../app/settings-groups.ts";

export const GROUP_ICONS: Record<SettingsGroup, LucideIcon> = { agents: Cpu, environments: SquareTerminal, identity: UserRound, permissions: ShieldCheck, usage: BarChart3, connections: Link2 };

/**
 * The navigation of Settings: the way back to Home, then the six groups, the open one marked. The Settings screens
 * pass it to the shell's side pane. `current` is null on the phone's list of groups, where none is open.
 */
export function SettingsNav({ current, className }: { current: SettingsGroup | null; className?: string }) {
  return (
    <nav aria-label="Settings" data-testid="settings-nav" className={cn("flex flex-col gap-1", className)}>
      <a href="#/" className="flex min-h-(--control) items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground hover:bg-fill hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
        Back to Home
      </a>
      <p className="px-3 pt-3 pb-1 text-meta font-semibold text-muted-foreground">Settings</p>
      <ul className="flex flex-col gap-1">
        {GROUPS.map(({ group, name }) => {
          const Icon = GROUP_ICONS[group];
          const open = group === current;
          return (
            <li key={group}>
              <a href={groupHref(group)} aria-current={open ? "page" : undefined} className={cn("flex min-h-(--control) items-center gap-3 rounded-lg px-3 text-sm", open ? "bg-fill font-semibold text-foreground" : "text-muted-foreground hover:bg-fill hover:text-foreground")}>
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {name}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
