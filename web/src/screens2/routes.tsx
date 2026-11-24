import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { holdArrival } from "../app/arrival.ts";
import type { Route } from "../app/route.ts";

/*
 * The one place that sends an address to a screen rebuilt on shadcn/ui and Tailwind (ADR 0012). Each rebuilt screen
 * is a folder under screens2/ and one line here; it is fetched only when its address is opened. Until a screen is
 * listed, or while its address does not ask for the rebuilt one, the old screen is shown, exactly as before.
 *
 * To add a screen: make screens2/<name>/<name>-screen.tsx with a default export that renders inside <NextShell>
 * (shell/shell.tsx), add its lazy import below, and return it from `rebuilt` for its route. While old and new stand
 * side by side the address carries ?new=1 (app/route.ts sets `rebuilt` on the route); when the new one has passed its
 * tests, drop the flag for that route and delete the old screen. Home and Work are the screens for their addresses:
 * the old Work board is gone.
 */

const ReviewScreen = lazy(() => import("./review/review-screen.tsx"));
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
  if (route.screen === "task" && route.rebuilt) {
    return (
      <Suspense fallback={<Fetching />}>
        <ReviewScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />
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
export const isRebuilt = (route: Route): boolean => route.screen === "home" || route.screen === "work" || route.screen === "run" || (route.screen === "task" && route.rebuilt);
