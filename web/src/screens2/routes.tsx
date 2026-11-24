import { lazy, Suspense, type ReactNode } from "react";
import type { Route } from "../app/route.ts";

/*
 * The one place that sends an address to a screen rebuilt on shadcn/ui and Tailwind (ADR 0012). Each rebuilt screen
 * is a folder under screens2/ and one line here; it is fetched only when its address is opened. Until a screen is
 * listed, or while its address does not ask for the rebuilt one, the old screen is shown, exactly as before.
 *
 * To add a screen: make screens2/<name>/<name>-screen.tsx with a default export that renders inside <NextShell>
 * (shell/shell.tsx), add its lazy import below, and return it from `rebuilt` for its route. While old and new stand
 * side by side the address carries ?new=1 (app/route.ts sets `rebuilt` on the route); when the new one has passed its
 * tests, drop the flag for that route and delete the old screen.
 */

const ReviewScreen = lazy(() => import("./review/review-screen.tsx"));
const ChatScreen = lazy(() => import("./chat/chat-screen.tsx"));
const OpenChat = lazy(() => import("./chat/chat-screen.tsx").then((module) => ({ default: module.OpenChat })));

/** The rebuilt screen for `route`, or null when there is none and the old screen is to be shown. */
export function rebuilt(route: Route, onSignedOut: () => void): ReactNode | null {
  if (route.screen === "task" && route.rebuilt) {
    return (
      <Suspense fallback={null}>
        <ReviewScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  // Chat, and New chat or task: one screen at both addresses, kept as it is when the address goes from one to the other.
  // A start (New task, New run, Make this a run, Start on an issue) is a screen of its own, as it always was.
  if (route.screen === "turn") {
    return (
      <Suspense fallback={null}>
        <ChatScreen key={`${route.start ?? ""} ${route.proposal ?? ""} ${route.from === undefined ? "" : `${route.from.kind}-${route.from.id}`}`} start={route.start} proposal={route.proposal ?? null} from={route.from ?? null} fresh={route.fresh === true} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  if (route.screen === "chat") {
    return (
      <Suspense fallback={null}>
        <OpenChat key={route.id} id={route.id} onSignedOut={onSignedOut} />
      </Suspense>
    );
  }
  return null;
}

/** Whether `route` is shown by a rebuilt screen, which brings its own navigation and takes the whole window. */
export const isRebuilt = (route: Route): boolean => (route.screen === "task" && route.rebuilt) || route.screen === "turn" || route.screen === "chat";
