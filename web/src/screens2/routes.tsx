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
const RunScreen = lazy(() => import("./run/run-screen.tsx"));

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
export const isRebuilt = (route: Route): boolean => route.screen === "task" || route.screen === "run";
