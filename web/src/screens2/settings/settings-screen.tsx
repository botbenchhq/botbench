import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ApiError, getAgents, getPeerOverview, getRepositoryExecutions, getDefaultMode, getChatWebAccess, getWorkbench, listDevices, type AgentState, type PeerOverview } from "../../api/client.ts";
import { arrive, tabTitle } from "../../app/arrival.ts";
import { agentName, agentState } from "../../app/chat.ts";
import { counted } from "../../app/format.ts";
import { MODE_NAMES } from "../../app/run-words.ts";
import { useWide } from "../../app/wide.ts";
import { NextShell } from "../../shell/shell.tsx";
import { PeerCardsWaiting } from "../peer/waiting.tsx";
import { AGENTS, AgentsGroup } from "./agents.tsx";
import { ConnectionsGroup } from "./connections.tsx";
import { EnvironmentsGroup } from "./environments.tsx";
import { GROUPS, groupHref, type SettingsGroup } from "../../app/settings-groups.ts";
import { IdentityGroup } from "./identity.tsx";
import { Panel } from "./parts.tsx";
import { PermissionsGroup } from "./permissions.tsx";
import { GROUP_ICONS, SettingsNav } from "./settings-nav.tsx";
import { UsageGroup } from "./usage.tsx";

/*
 * Settings, rebuilt on shadcn/ui and Tailwind 4 (ADR 0012), in six groups, each at its own address. From 1024px the
 * settings navigation stands beside the open group, and Settings with no group named opens Agents and models. Below
 * that, Settings with no group named is the list of the six groups under a summary of the workbench, and a group is a
 * screen of its own with the way back to the list. Everything shown is read through the API client.
 */

/** The line under each group's title. */
const LEAD: Record<SettingsGroup, string> = {
  agents: "Botbench drives each agent's own command-line tool and never reads its credentials.",
  environments: "Where each repository's commands run. Set per repository in the settings file: Botbench reads that file and never writes it, so it is shown here, not changed.",
  identity: "What this workbench is called, how a paired workbench knows it, the version it runs and how it looks on this device.",
  permissions: "Each change is saved as you make it.",
  usage: "Tokens only. Botbench stores no dollar amount, so none is shown.",
  connections: "Who else reaches this workbench: one paired workbench, the devices signed in to it, and what it may tell this device.",
};

/** The widest a group's column grows: one column of settings reads best narrow, a group with two columns needs the room. */
const WIDTH: Record<SettingsGroup, string> = { agents: "max-w-[47.5rem]", environments: "max-w-[65rem]", identity: "max-w-[65rem]", permissions: "max-w-[47.5rem]", usage: "max-w-[65rem]", connections: "max-w-[65rem]" };

function Group({ group, onSignedOut }: { group: SettingsGroup; onSignedOut: () => void }) {
  if (group === "agents") return <AgentsGroup onSignedOut={onSignedOut} />;
  if (group === "environments") return <EnvironmentsGroup onSignedOut={onSignedOut} />;
  if (group === "identity") return <IdentityGroup onSignedOut={onSignedOut} />;
  if (group === "permissions") return <PermissionsGroup onSignedOut={onSignedOut} />;
  if (group === "usage") return <UsageGroup onSignedOut={onSignedOut} />;
  return <ConnectionsGroup onSignedOut={onSignedOut} />;
}

/** What the phone's list says under each group's name, from what the server reports now; a line it could not read is left out. */
interface Summary {
  agents: AgentState[] | null;
  repositories: number | null;
  workbench: string | null;
  devices: number | null;
  mode: string | null;
  web: string | null;
  peers: PeerOverview | null;
}

function useSummary(on: boolean, onSignedOut: () => void): Summary {
  const [summary, setSummary] = useState<Summary>({ agents: null, repositories: null, workbench: null, devices: null, mode: null, web: null, peers: null });
  useEffect(() => {
    if (!on) return;
    let stale = false;
    const read = <T,>(asked: Promise<T>, keep: (value: T) => Partial<Summary>): void => {
      asked.then(
        (value) => stale || setSummary((have) => ({ ...have, ...keep(value) })),
        (err: unknown) => err instanceof ApiError && err.status === 401 && onSignedOut(),
      );
    };
    read(getAgents(), (agents) => ({ agents }));
    read(getRepositoryExecutions(), (found) => ({ repositories: found.length }));
    read(getWorkbench(), (found) => ({ workbench: found.name }));
    read(listDevices(), (found) => ({ devices: found.length }));
    read(getDefaultMode(), (mode) => ({ mode: MODE_NAMES[mode] }));
    read(getChatWebAccess(), (web) => ({ web: { allow: "Allow", ask: "Ask", off: "Off" }[web] }));
    read(getPeerOverview(), (peers) => ({ peers }));
    return () => {
      stale = true;
    };
  }, [on, onSignedOut]);
  return summary;
}

/** The phone's Settings: a summary of the workbench as it is now, then the six groups, each a row that opens it. */
function GroupList({ onSignedOut }: { onSignedOut: () => void }) {
  const s = useSummary(true, onSignedOut);
  const usable = s.agents?.filter((a) => a.problem === null).length ?? null;
  const paired = s.peers?.pairings.find((p) => p.state === "in_force") ?? null;
  const waiting = s.agents?.find((a) => a.problem !== null && a.installed && !a.signedIn);
  const about: Record<SettingsGroup, ReactNode> = {
    agents: usable === null || s.agents === null ? GROUPS[0]!.about : `${usable} of ${s.agents.length} available${waiting === undefined ? "" : ` · ${agentName(waiting.agent)} is signed out`}`,
    environments: s.repositories === null ? GROUPS[1]!.about : s.repositories === 0 ? "Every task's commands run on this Mac" : `Setup and checks for ${counted(s.repositories, "repository", "repositories")}`,
    identity:
      s.workbench === null ? (
        GROUPS[2]!.about
      ) : (
        <>
          <span data-ds-content="">{s.workbench}</span>
          {s.devices === null ? "" : ` · ${counted(s.devices, "signed-in device", "signed-in devices")}`}
        </>
      ),
    permissions: s.mode === null ? GROUPS[3]!.about : `${s.mode} by default${s.web === null ? "" : ` · Web access: ${s.web}`}`,
    usage: GROUPS[4]!.about,
    connections:
      s.peers === null ? (
        GROUPS[5]!.about
      ) : paired !== null ? (
        <>
          {"Paired with "}
          <span data-ds-content="">{paired.peer.name}</span>
        </>
      ) : (
        "No paired workbench"
      ),
  };
  return (
    <>
      {s.agents !== null && (
        <Panel data-testid="settings-summary" className="flex flex-col gap-4 p-5">
          <h2 className="text-base font-semibold">{`${usable} of ${s.agents.length} agents available`}</h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-3">
            {AGENTS.flatMap(({ agent: key, name }) => {
              const agent = s.agents!.find((found) => found.agent === key);
              if (agent === undefined) return [];
              const state = agentState(agent);
              return [
                <li key={key} className="flex items-start gap-2">
                  <span aria-hidden="true" className={`mt-2 size-2 shrink-0 rounded-full ${state === "Available" ? "bg-success" : state === "Signed out" ? "bg-attention" : "bg-edge"}`} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold">{name}</span>
                    <span className="text-meta text-muted-foreground">{state}</span>
                  </span>
                </li>,
              ];
            })}
          </ul>
          {paired !== null && (
            <p className="flex items-center gap-2 border-t pt-3 text-sm">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-peer" />
              <span data-ds-content="" className="font-semibold">
                {paired.peer.name}
              </span>
              <span className="text-muted-foreground">· paired workbench</span>
            </p>
          )}
        </Panel>
      )}
      <Panel>
        <ul data-testid="settings-groups" className="divide-y">
          {GROUPS.map(({ group, name }) => {
            const Icon = GROUP_ICONS[group];
            return (
              <li key={group}>
                <a href={groupHref(group)} className="flex min-h-16 items-center gap-4 px-5 py-3 hover:bg-fill">
                  <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-base font-semibold">{name}</span>
                    <span className="text-meta text-muted-foreground">{about[group]}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                </a>
              </li>
            );
          })}
        </ul>
      </Panel>
    </>
  );
}

/**
 * The width of the shell's whole screen area. The shell keeps a column at the right for a screen's own pane from
 * 1280px, also for a screen that has none, and Settings has none: it is drawn across that column too. Measured, not
 * assumed, so it is right whatever the shell keeps.
 */
function useScreenWidth(): { ref: React.RefObject<HTMLDivElement | null>; width: number | undefined } {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const inset = ref.current?.closest<HTMLElement>('[data-slot="sidebar-inset"]');
    if (inset == null) return;
    const measure = (): void => setWidth(inset.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inset);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Settings. `group` is the group the address names, or null for Settings itself. */
export default function SettingsScreen({ group, onSignedOut }: { group: SettingsGroup | null; onSignedOut: () => void }) {
  const wide = useWide();
  // From 1024px the navigation is beside the group, so there is always one open: Agents and models when none is named.
  const open = group ?? (wide ? "agents" : null);
  const name = open === null ? "Settings" : GROUPS.find((g) => g.group === open)!.name;
  const heading = useRef<HTMLHeadingElement>(null);
  const screen = useScreenWidth();
  useEffect(() => {
    document.title = tabTitle(name);
    // Each group is a screen of its own: its heading takes the focus as any screen's does, so a keyboard or a screen
    // reader starts in what the navigation opened.
    arrive(heading.current);
  }, [open, name]);

  return (
    <NextShell
      open={null}
      bar={
        <nav aria-label="Where this is" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {open === null || wide ? (
            <span className="font-semibold">Settings</span>
          ) : (
            <a href="#/settings" className="inline-flex min-h-(--control-small) items-center gap-1 text-muted-foreground hover:text-foreground">
              <ChevronLeft aria-hidden="true" className="size-4" />
              Settings
            </a>
          )}
          <PeerCardsWaiting />
        </nav>
      }
    >
      <div ref={screen.ref} style={{ width: screen.width }} className="flex min-w-0 flex-1">
        {wide && (
          <div data-testid="settings-side" className="w-64 shrink-0 border-r bg-pane px-2 py-4">
            <SettingsNav current={open} className="sticky top-4" />
          </div>
        )}
        <main data-testid="settings" data-group={open ?? ""} className="min-w-0 flex-1 px-4 pt-6 pb-16 md:px-8">
          <div className={`mx-auto flex flex-col gap-8 ${open === null ? "max-w-[47.5rem]" : WIDTH[open]}`}>
            <header className="flex flex-col gap-2">
              <h1 ref={heading} tabIndex={-1} className="text-[1.5rem] leading-[1.875rem] font-bold tracking-tight outline-none md:text-title">
                {name}
              </h1>
              <p className="text-base text-muted-foreground">{open === null ? "Each change is saved as you make it." : LEAD[open]}</p>
            </header>
            {open === null ? <GroupList onSignedOut={onSignedOut} /> : <Group key={open} group={open} onSignedOut={onSignedOut} />}
          </div>
        </main>
      </div>
    </NextShell>
  );
}
