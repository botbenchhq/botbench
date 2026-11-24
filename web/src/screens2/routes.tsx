import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { holdArrival } from "../app/arrival.ts";
import type { Route } from "../app/route.ts";

/*
 * The one place that sends an address to a screen rebuilt on shadcn/ui and Tailwind (ADR 0012). Each rebuilt screen
 * is a folder under screens2/ and one line here; it is fetched only when its address is opened. Until a screen is
 * listed the old screen is shown, exactly as before.
 *
 * To add a screen: make screens2/<name>/<name>-screen.tsx with a default export that renders inside <NextShell>
 * (shell/shell.tsx), add its lazy import below, return it from `rebuilt` for its route, and delete the old screen.
 */

const TaskScreen = lazy(() => import("./task/task-screen.tsx"));
const ChatScreen = lazy(() => import("./chat/chat-screen.tsx"));
const OpenChat = lazy(() => import("./chat/chat-screen.tsx").then((module) => ({ default: module.OpenChat })));
const RunScreen = lazy(() => import("./run/run-screen.tsx"));
const HomeScreen = lazy(() => import("./home/home-screen.tsx"));
const WorkScreen = lazy(() => import("./work/work-screen.tsx"));

/** Shown, as nothing, while a rebuilt screen's code is fetched: the screen's heading still takes focus when it is drawn (app/arrival.ts). */
function Fetching() {
  useEffect(() => holdArrival(), []);
  return null;
}

/** The rebuilt screen for `route`, or null when there is none and the old screen is to be shown. */
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
  // A run has no old screen any more: this is the screen at its address.
  if (route.screen === "run") {
    return (
      <Suspense fallback={<Fetching />}>
        <RunScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  return null;
}

/** Whether `route` is shown by a rebuilt screen, which brings its own navigation and takes the whole window. */
export const isRebuilt = (route: Route): boolean => route.screen === "home" || route.screen === "work" || route.screen === "task" || route.screen === "run" || route.screen === "turn" || route.screen === "chat";
