import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { hasSession } from "../api/client.ts";
import { arrive, mayLeave, noteNavigation, tabTitle } from "./arrival.ts";
import { parseRoute, type Route } from "./route.ts";
import { ApprovalsProvider } from "./approvals.tsx";
import { PeerCardsProvider } from "./peer-cards.tsx";
import { ThreadScreen } from "../screens/thread.tsx";
import { Alert, Frame, Page } from "../components/header.tsx";
import { BoardScreen } from "../screens/board.tsx";
import { RunScreen } from "../screens/run.tsx";
import { SettingsScreen } from "../screens/settings.tsx";
import { SignInScreen } from "../screens/sign-in.tsx";
import { TaskScreen } from "../screens/task.tsx";
import { TrustScreen } from "../screens/trust.tsx";
import { isRebuilt, rebuilt } from "../screens2/routes.tsx";
import { UsageScreen } from "../screens/usage.tsx";
import { WorkColumn } from "../components/work-column.tsx";
import { useWide } from "./wide.ts";

type Session = "checking" | "unreachable" | "signed-out" | "signed-in";

function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  // The address of the screen now shown, and whether the next change is this hook putting it back.
  const shown = useRef(window.location.hash);
  const restoring = useRef(false);
  useEffect(() => {
    const onChange = (): void => {
      const to = window.location.hash;
      if (restoring.current) {
        restoring.current = false;
        return;
      }
      // A screen with unsaved words is asked first. When it says no, the address goes back to it, and the screen
      // itself goes on to `to` once the owner has answered.
      if (to !== shown.current && !mayLeave(to)) {
        restoring.current = true;
        window.location.replace(shown.current === "" ? "#/" : shown.current);
        return;
      }
      shown.current = to;
      noteNavigation();
      setHash(to);
    };
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

/** The screen shown for an address that names none. Its heading names the tab and takes focus as any screen's does. */
function NotFound({ what }: { what: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = tabTitle("No such screen");
    arrive(heading.current);
  }, []);
  return (
    <Frame current={null}>
      <Page>
        <div className="ds-not-found">
          <div role="alert" className="ds-empty-state">
            <h1 ref={heading} tabIndex={-1} className="ds-empty-state__title">
              {"There is no screen at "}
              <span data-ds-content="">{what}</span>.
            </h1>
            <p className="ds-empty-state__body">The address may be mistyped. The navigation lists every screen there is.</p>
          </div>
        </div>
      </Page>
    </Frame>
  );
}

function screenFor(route: Route, onSignedOut: () => void, wide: boolean) {
  // From 1024px Permissions and Usage are sections of the two-pane Settings, at their own addresses.
  if (wide && (route.screen === "trust" || route.screen === "usage")) return <SettingsScreen section={route.screen === "trust" ? "permissions" : "usage"} onSignedOut={onSignedOut} />;
  // A screen rebuilt on shadcn/ui (ADR 0012), when there is one for this address: screens2/routes.tsx is the one switch.
  const next = rebuilt(route, onSignedOut);
  if (next !== null) return next;
  if (route.screen === "redirect") return <Redirect to={route.to} />;
  if (route.screen === "trust") return <TrustScreen onSignedOut={onSignedOut} />;
  if (route.screen === "usage") return <UsageScreen onSignedOut={onSignedOut} />;
  if (route.screen === "work") return <BoardScreen onSignedOut={onSignedOut} />;
  if (route.screen === "settings") return <SettingsScreen section={route.section} onSignedOut={onSignedOut} />;
  if (route.screen === "run") return <RunScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />;
  // The key gives each task its own screen state, so one task's transcript never shows under another's name.
  if (route.screen === "task") return <TaskScreen key={route.id} id={route.id} discard={route.discard} onSignedOut={onSignedOut} />;
  if (route.screen === "thread") return <ThreadScreen key={`${route.pairingId} ${route.contextId}`} pairingId={route.pairingId} contextId={route.contextId} onSignedOut={onSignedOut} />;
  // Chat and New chat or task are rebuilt screens, returned above.
  return route.screen === "none" ? <NotFound key={route.what} what={route.what} /> : null;
}

/** The row of the column of chats and work that the open screen shows, as WorkColumn keys it. */
const openRow = (route: Route): string | null => (route.screen === "run" ? `run ${route.id}` : route.screen === "task" ? `task ${route.id}` : null);

/**
 * From 1024px, every screen but Settings (with Permissions and Usage, its sections there) has the column of runs and
 * tasks beside it, as the design system's split panel lays them out. The column is drawn here, above the screens, so
 * opening a row replaces only the screen: the column keeps its search and its scroll position. Focus goes to the
 * opened screen's heading, as on any arrival (arrival.ts), unless the owner is typing in the column's search. The screen
 * is in a plain region of its own, not a section, so its header and navigation stay the page's landmarks. Below 1024px
 * the screen is laid out alone, exactly as before, but in the same place in the tree, so it is never drawn anew.
 */
function Beside({ route, wide, onSignedOut, children }: { route: Route; wide: boolean; onSignedOut: () => void; children: ReactNode }) {
  // Kept here, so the search is still there after a visit to Settings, which has no column.
  const [query, setQuery] = useState("");
  const settings = route.screen === "settings" || route.screen === "trust" || route.screen === "usage";
  // A rebuilt screen has its own navigation at the left, and no column beside it.
  const split = wide && !settings && !isRebuilt(route);
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
        <PeerCardsProvider onSignedOut={onSignedOut}>
          <Beside route={route} wide={wide} onSignedOut={onSignedOut}>
            {screenFor(route, onSignedOut, wide)}
          </Beside>
        </PeerCardsProvider>
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
