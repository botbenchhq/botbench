import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { holdArrival } from "../app/arrival.ts";
import type { Route } from "../app/route.ts";

/*
 * The one place that sends an address to its screen (ADR 0012). Each screen is a folder under screens2/ and one line
 * here; it is fetched only when its address is opened.
 *
 * To add a screen: make screens2/<name>/<name>-screen.tsx with a default export that renders inside <NextShell>
 * (shell/shell.tsx), add its lazy import below, and return it from `rebuilt` for its route.
 */

const TaskScreen = lazy(() => import("./task/task-screen.tsx"));
const ChatScreen = lazy(() => import("./chat/chat-screen.tsx"));
const OpenChat = lazy(() => import("./chat/chat-screen.tsx").then((module) => ({ default: module.OpenChat })));
const SettingsScreen = lazy(() => import("./settings/settings-screen.tsx"));
const PeerScreen = lazy(() => import("./peer/peer-screen.tsx"));
const SignInScreen = lazy(() => import("./sign-in/sign-in-screen.tsx"));
const SessionState = lazy(() => import("./sign-in/sign-in-screen.tsx").then((m) => ({ default: m.SessionState })));
const RunScreen = lazy(() => import("./run/run-screen.tsx"));
const HomeScreen = lazy(() => import("./home/home-screen.tsx"));
const WorkScreen = lazy(() => import("./work/work-screen.tsx"));
const NotFoundScreen = lazy(() => import("./not-found/not-found-screen.tsx"));

/** Shown, as nothing, while a rebuilt screen's code is fetched: the screen's heading still takes focus when it is drawn (app/arrival.ts). */
function Fetching() {
  useEffect(() => holdArrival(), []);
  return null;
}

/** The screen for `route`, or null for an old address, which is only passed on to its new one. */
export function rebuilt(route: Route, onSignedOut: () => void): ReactNode | null {
  if (route.screen === "task") {
    return (
      <Suspense fallback={<Fetching />}>
        {/* The key gives each task its own screen state, so one task's activity never shows under another's name. */}
        <TaskScreen key={route.id} id={route.id} discard={route.discard} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  if (route.screen === "home") {
    return (
      <Suspense fallback={<Fetching />}>
        <HomeScreen onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  if (route.screen === "work") {
    return (
      <Suspense fallback={<Fetching />}>
        <WorkScreen key={route.state ?? ""} state={route.state} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  // Chat, and New chat or task: one screen at both addresses, kept as it is when the address goes from one to the other.
  // A start (New task, New run, Make this a run, Start on an issue) is a screen of its own, as it always was.
  if (route.screen === "turn") {
    return (
      <Suspense fallback={<Fetching />}>
        <ChatScreen key={`${route.start ?? ""} ${route.proposal ?? ""} ${route.from === undefined ? "" : `${route.from.kind}-${route.from.id}`}`} start={route.start} proposal={route.proposal ?? null} from={route.from ?? null} fresh={route.fresh === true} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  if (route.screen === "chat") {
    return (
      <Suspense fallback={<Fetching />}>
        <OpenChat key={route.id} id={route.id} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  // Settings and its six groups. One screen for all of them, so choosing another group keeps the navigation in place.
  if (route.screen === "settings") {
    return (
      <Suspense fallback={<Fetching />}>
        <SettingsScreen group={route.group} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  // One conversation with the paired workbench.
  if (route.screen === "thread") {
    return (
      <Suspense fallback={<Fetching />}>
        <PeerScreen key={`${route.pairingId} ${route.contextId}`} pairingId={route.pairingId} contextId={route.contextId} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  // A run has no old screen any more: this is the screen at its address.
  if (route.screen === "run") {
    return (
      <Suspense fallback={<Fetching />}>
        <RunScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  if (route.screen === "none") {
    return (
      <Suspense fallback={<Fetching />}>
        <NotFoundScreen key={route.what} what={route.what} />
      </Suspense>
    );
  }
  return null;
}

/** Sign in: the whole window, with no navigation. */
export function signInScreen(notice: string | null, onSignedIn: () => void): ReactNode {
  return (
    <Suspense fallback={<Fetching />}>
      <SignInScreen notice={notice} onSignedIn={onSignedIn} />
    </Suspense>
  );
}

/** What stands in the window before the session is known: that it is being checked, or that Botbench cannot be reached. */
export function sessionState(unreachable: boolean): ReactNode {
  return (
    <Suspense fallback={<Fetching />}>
      <SessionState unreachable={unreachable} />
    </Suspense>
  );
}
