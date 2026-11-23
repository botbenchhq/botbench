import { useCallback, useEffect, useState, type ReactNode } from "react";
import { hasSession } from "../api/client.ts";
import { parseRoute, type Route } from "./route.ts";
import { ApprovalsProvider } from "./approvals.tsx";
import { Alert, Frame, Page } from "../components/header.tsx";
import { BoardScreen } from "../screens/board.tsx";
import { RunScreen } from "../screens/run.tsx";
import { SettingsScreen } from "../screens/settings.tsx";
import { SignInScreen } from "../screens/sign-in.tsx";
import { TaskScreen } from "../screens/task.tsx";
import { TrustScreen } from "../screens/trust.tsx";
import { OpenChat, TurnScreen } from "../screens/turn.tsx";
import { UsageScreen } from "../screens/usage.tsx";
import { WorkColumn } from "../components/work-column.tsx";
import { useWide } from "./wide.ts";

type Session = "checking" | "unreachable" | "signed-out" | "signed-in";

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
  if (route.screen === "turn") return <TurnScreen key={`${route.start ?? ""} ${route.proposal ?? ""} ${route.from === undefined ? "" : `${route.from.kind}-${route.from.id}`}`} start={route.start} proposal={route.proposal ?? null} from={route.from ?? null} onSignedOut={onSignedOut} />;
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
 * the screen is laid out alone, exactly as before, but in the same place in the tree, so it is never drawn anew.
 */
function Beside({ route, wide, onSignedOut, children }: { route: Route; wide: boolean; onSignedOut: () => void; children: ReactNode }) {
  // Kept here, so the search is still there after a visit to Settings, which has no column.
  const [query, setQuery] = useState("");
  const settings = route.screen === "settings" || route.screen === "trust" || route.screen === "usage";
  const split = wide && !settings;
  // The screen keeps its place in the tree at every width: crossing 1024px only adds or removes the column and the
  // panel's classes, so the screen is not drawn anew and keeps what the owner typed (a note, a message, an open dialog).
  // Below 1024px, and on Settings, the two wrappers are `display: contents`: the screen is laid out as if drawn alone.
  return (
    <div className={split ? "ds-split-panel ds-split-panel--fill h-screen" : "contents"}>
      {split && <WorkColumn current={openRow(route)} query={query} onQuery={setQuery} onSignedOut={onSignedOut} />}
      <div className={split ? "ds-split-panel__detail p-0" : "contents"}>{children}</div>
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
