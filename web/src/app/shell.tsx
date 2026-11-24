import { useCallback, useEffect, useRef, useState } from "react";
import { hasSession } from "../api/client.ts";
import { mayLeave, noteNavigation } from "./arrival.ts";
import { parseRoute, type Route } from "./route.ts";
import { ApprovalsProvider } from "./approvals.tsx";
import { PeerCardsProvider } from "./peer-cards.tsx";
import { rebuilt, sessionState, signInScreen } from "../screens2/routes.tsx";

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

function screenFor(route: Route, onSignedOut: () => void) {
  // Every screen is a folder under screens2/, and screens2/routes.tsx is the one switch (ADR 0012).
  const next = rebuilt(route, onSignedOut);
  if (next !== null) return next;
  return route.screen === "redirect" ? <Redirect to={route.to} /> : null;
}

/** Decides which screen to show: sign-in, or behind it the screen the address names. */
export function Shell() {
  const [session, setSession] = useState<Session>("checking");
  const [notice, setNotice] = useState<string | null>(null);
  const route = useRoute();

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
    // One provider above every screen: the shell's count of what waits and the card on a task's screen read the same list.
    return (
      <ApprovalsProvider onSignedOut={onSignedOut}>
        <PeerCardsProvider onSignedOut={onSignedOut}>
          {screenFor(route, onSignedOut)}
        </PeerCardsProvider>
      </ApprovalsProvider>
    );
  }
  if (session === "signed-out") return signInScreen(notice, onSignedIn);
  return sessionState(session === "unreachable");
}
