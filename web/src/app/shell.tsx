import { useCallback, useEffect, useState, type ReactNode } from "react";
import { hasSession } from "../api/client.ts";
import type { Kind } from "./composer.ts";
import { ApprovalsProvider } from "./approvals.tsx";
import { Alert, Frame, Page } from "../components/header.tsx";
import { BoardScreen } from "../screens/board.tsx";
import { RunScreen } from "../screens/run.tsx";
import { SettingsScreen, type SettingsSection } from "../screens/settings.tsx";
import { SignInScreen } from "../screens/sign-in.tsx";
import { TaskScreen } from "../screens/task.tsx";
import { TrustScreen } from "../screens/trust.tsx";
import { OpenChat, TurnScreen } from "../screens/turn.tsx";
import { UsageScreen } from "../screens/usage.tsx";
import { WorkColumn } from "../components/work-column.tsx";
import { useWide } from "./wide.ts";

type Session = "checking" | "unreachable" | "signed-out" | "signed-in";

type Route = { screen: "turn"; start: Kind | null; proposal?: number } | { screen: "redirect"; to: string } | { screen: "trust" } | { screen: "usage" } | { screen: "task"; id: number; discard: boolean } | { screen: "work" } | { screen: "settings"; section: SettingsSection | null } | { screen: "run"; id: number } | { screen: "chat"; id: number } | { screen: "none"; what: string };

/** The screen an address names. The part after `#` is the whole address: the server only ever serves the one page. */
function parseRoute(hash: string): Route {
  const at = hash.replace(/^#/, "");
  if (at === "" || at === "/" || at === "/turn") return { screen: "turn", start: null };
  // New task and New run open the composer with that kind chosen.
  if (at === "/turn?start=task" || at === "/turn?start=run") return { screen: "turn", start: at.endsWith("task") ? "task" : "run" };
  // Start on an issue proposed on Work: a run, with the From an issue row opened on that issue (components/proposals.tsx).
  const proposed = /^\/turn\?start=run&proposal=([1-9]\d{0,14})$/.exec(at);
  if (proposed) return { screen: "turn", start: "run", proposal: Number(proposed[1]) };
  // The addresses of the New task and New run forms the composer replaced.
  if (at === "/tasks/new") return { screen: "redirect", to: "#/turn?start=task" };
  if (at === "/runs/new") return { screen: "redirect", to: "#/turn?start=run" };
  // Work lists the runs and the tasks started on their own, where Runs and Tasks were.
  if (at === "/work") return { screen: "work" };
  if (at === "/runs" || at === "/tasks") return { screen: "redirect", to: "#/work" };
  // The sign-in address from Add a device, opened on a device that is already signed in: the code is not needed.
  if (at.startsWith("code=")) return { screen: "redirect", to: "#/" };
  if (at === "/trust") return { screen: "trust" };
  if (at === "/usage") return { screen: "usage" };
  if (at === "/settings") return { screen: "settings", section: null };
  // Settings at its Agents section: where the home screen sends the owner to connect an agent.
  if (at === "/settings/agents") return { screen: "settings", section: "agents" };
  // The other sections of the two-pane Settings, from 1024px. Permissions and Usage keep their own addresses.
  const part = /^\/settings\/(appearance|notifications|devices|workbench)$/.exec(at);
  if (part) return { screen: "settings", section: part[1] as SettingsSection };
  // A chat from the Work list: Chat, with that chat on it.
  const chat = /^\/chats\/([1-9]\d{0,14})$/.exec(at);
  if (chat) return { screen: "chat", id: Number(chat[1]) };
  // A task's Discard chosen from its More menu on Work: the task's screen, with Discard's confirmation open.
  const task = /^\/tasks\/([1-9]\d{0,14})(\?discard)?$/.exec(at);
  if (task) return { screen: "task", id: Number(task[1]), discard: task[2] !== undefined };
  const run = /^\/runs\/([1-9]\d{0,14})$/.exec(at);
  return run ? { screen: "run", id: Number(run[1]) } : { screen: "none", what: at };
}

function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return parseRoute(hash);
}

/** An old address: replaced in the history by the new one, so Back does not return to it. */
function Redirect({ to }: { to: string }) {
  useEffect(() => window.location.replace(to), [to]);
  return null;
}

function screenFor(route: Route, onSignedOut: () => void, wide: boolean) {
  // From 1024px Permissions and Usage are sections of the two-pane Settings, at their own addresses.
  if (wide && (route.screen === "trust" || route.screen === "usage")) return <SettingsScreen section={route.screen === "trust" ? "permissions" : "usage"} onSignedOut={onSignedOut} />;
  if (route.screen === "turn") return <TurnScreen key={`${route.start ?? ""} ${route.proposal ?? ""}`} start={route.start} proposal={route.proposal ?? null} onSignedOut={onSignedOut} />;
  if (route.screen === "redirect") return <Redirect to={route.to} />;
  if (route.screen === "trust") return <TrustScreen onSignedOut={onSignedOut} />;
  if (route.screen === "usage") return <UsageScreen onSignedOut={onSignedOut} />;
  if (route.screen === "work") return <BoardScreen onSignedOut={onSignedOut} />;
  if (route.screen === "settings") return <SettingsScreen section={route.section} onSignedOut={onSignedOut} />;
  if (route.screen === "run") return <RunScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />;
  // The key gives each task its own screen state, so one task's transcript never shows under another's name.
  if (route.screen === "task") return <TaskScreen key={route.id} id={route.id} discard={route.discard} onSignedOut={onSignedOut} />;
  if (route.screen === "chat") return <OpenChat key={route.id} id={route.id} onSignedOut={onSignedOut} />;
  return (
    <Frame current={null}>
      <Page>
        <div className="ds-not-found">
          <div role="alert" className="ds-empty-state">
            <h1 className="ds-empty-state__title">
              {"There is no screen at "}
              <span data-ds-content="">{route.what}</span>.
            </h1>
            <p className="ds-empty-state__body">The address may be mistyped. The navigation lists every screen there is.</p>
          </div>
        </div>
      </Page>
    </Frame>
  );
}

/** The row of the column of chats and work that the open screen shows, as WorkColumn keys it. */
const openRow = (route: Route): string | null => (route.screen === "run" ? `run ${route.id}` : route.screen === "task" ? `task ${route.id}` : null);

/**
 * From 1024px, every screen but Settings (with Permissions and Usage, its sections there) has the column of runs and
 * tasks beside it, as the design system's split panel lays them out. The column is drawn here, above the screens, so
 * opening a row replaces only the screen: the column keeps its search, its scroll position and its focus. The screen
 * is in a plain region of its own, not a section, so its header and navigation stay the page's landmarks. Below 1024px
 * the screen is drawn alone, exactly as before.
 */
function Beside({ route, wide, onSignedOut, children }: { route: Route; wide: boolean; onSignedOut: () => void; children: ReactNode }) {
  // Kept here, so the search is still there after a visit to Settings, which has no column.
  const [query, setQuery] = useState("");
  const settings = route.screen === "settings" || route.screen === "trust" || route.screen === "usage";
  if (!wide || settings) return children;
  return (
    <div className="ds-split-panel ds-split-panel--fill h-screen">
      <WorkColumn current={openRow(route)} query={query} onQuery={setQuery} onSignedOut={onSignedOut} />
      <div className="ds-split-panel__detail p-0">{children}</div>
    </div>
  );
}

/** Decides which screen to show: sign-in, or behind it the screen the address names. */
export function Shell() {
  const [session, setSession] = useState<Session>("checking");
  const [notice, setNotice] = useState<string | null>(null);
  const route = useRoute();
  const wide = useWide();

  useEffect(() => {
    if (session !== "checking" && session !== "unreachable") return;
    let cancelled = false;
    let timer: number | undefined;
    const check = (): void => {
      hasSession().then(
        (signedIn) => !cancelled && setSession(signedIn ? "signed-in" : "signed-out"),
        () => {
          if (cancelled) return;
          setSession("unreachable");
          timer = window.setTimeout(check, 2000);
        },
      );
    };
    check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [session === "checking" || session === "unreachable"]);

  // A real page load after signing in, not only a new screen: Safari offers to save a password for a form after the
  // page that follows it loads, so the phone's password manager can keep the token. The address is kept.
  const onSignedIn = useCallback(() => window.location.reload(), []);
  const onSignedOut = useCallback(() => {
    setNotice("This device was signed out. Sign in again.");
    setSession("signed-out");
  }, []);

  if (session === "signed-in") {
    // One provider above every screen: the tray in each screen's header and the card on a task's screen read the same list.
    return (
      <ApprovalsProvider onSignedOut={onSignedOut}>
        <Beside route={route} wide={wide} onSignedOut={onSignedOut}>
          {screenFor(route, onSignedOut, wide)}
        </Beside>
      </ApprovalsProvider>
    );
  }
  if (session === "signed-out") return <SignInScreen notice={notice} onSignedIn={onSignedIn} />;
  return (
    <main className="ds-sign-in p-lg">
      <p className="ds-sign-in__product">Botbench</p>
      {session === "checking" ? (
        <p role="status" className="ds-spinner">
          Checking your session.
        </p>
      ) : (
        <Alert tone="warning" role="status">
          Cannot reach Botbench. Trying again every two seconds.
        </Alert>
      )}
    </main>
  );
}
