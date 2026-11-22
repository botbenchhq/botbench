import { useCallback, useEffect, useState } from "react";
import { hasSession } from "../api/client.ts";
import { SignInScreen } from "../screens/sign-in.tsx";
import { TurnScreen } from "../screens/turn.tsx";

type Session = "checking" | "unreachable" | "signed-out" | "signed-in";

/** The product name, as every screen shows it. */
export function Mark() {
  return <span className="font-mono text-mono font-semibold uppercase tracking-widest">Smelt</span>;
}

/**
 * Decides which screen to show. There are two: sign-in, and the turn screen
 * behind it. Nothing else is listed anywhere because nothing else exists yet.
 */
export function Shell() {
  const [session, setSession] = useState<Session>("checking");
  const [notice, setNotice] = useState<string | null>(null);

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

  const onSignedIn = useCallback(() => {
    setNotice(null);
    setSession("signed-in");
  }, []);
  const onSignedOut = useCallback(() => {
    setNotice("Your session ended, which happens when Smelt restarts. Sign in again.");
    setSession("signed-out");
  }, []);

  if (session === "signed-in") return <TurnScreen onSignedOut={onSignedOut} />;
  if (session === "signed-out") return <SignInScreen notice={notice} onSignedIn={onSignedIn} />;
  return (
    <main className="mx-auto flex min-h-screen max-w-column flex-col gap-lg p-lg">
      <Mark />
      <p role="status" className="text-muted">
        {session === "checking" ? "Checking your session." : "Cannot reach Smelt. Trying again every two seconds."}
      </p>
    </main>
  );
}
