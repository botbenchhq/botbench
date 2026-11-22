import { useCallback, useEffect, useState } from "react";
import { hasSession } from "../api/client.ts";
import { Header, Mark } from "../components/header.tsx";
import { NewTaskScreen } from "../screens/new-task.tsx";
import { SignInScreen } from "../screens/sign-in.tsx";
import { TaskScreen } from "../screens/task.tsx";
import { TasksScreen } from "../screens/tasks.tsx";
import { TurnScreen } from "../screens/turn.tsx";

type Session = "checking" | "unreachable" | "signed-out" | "signed-in";

type Route = { screen: "turn" } | { screen: "tasks" } | { screen: "new-task" } | { screen: "task"; id: number } | { screen: "none"; what: string };

/** The screen an address names. The part after `#` is the whole address: the server only ever serves the one page. */
function parseRoute(hash: string): Route {
  const at = hash.replace(/^#/, "");
  if (at === "" || at === "/" || at === "/turn") return { screen: "turn" };
  if (at === "/tasks") return { screen: "tasks" };
  if (at === "/tasks/new") return { screen: "new-task" };
  const task = /^\/tasks\/([1-9]\d{0,14})$/.exec(at);
  return task ? { screen: "task", id: Number(task[1]) } : { screen: "none", what: at };
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

  const onSignedIn = useCallback(() => {
    setNotice(null);
    setSession("signed-in");
  }, []);
  const onSignedOut = useCallback(() => {
    setNotice("Your session ended, which happens when Smelt restarts. Sign in again.");
    setSession("signed-out");
  }, []);

  if (session === "signed-in") {
    if (route.screen === "turn") return <TurnScreen onSignedOut={onSignedOut} />;
    if (route.screen === "tasks") return <TasksScreen onSignedOut={onSignedOut} />;
    if (route.screen === "new-task") return <NewTaskScreen onSignedOut={onSignedOut} />;
    // The key gives each task its own screen state, so one task's transcript never shows under another's name.
    if (route.screen === "task") return <TaskScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />;
    return (
      <div className="mx-auto flex min-h-screen max-w-transcript flex-col">
        <Header current={null} />
        <main className="p-lg">
          <p role="alert" className="break-words font-medium">{`There is no screen at ${route.what}.`}</p>
        </main>
      </div>
    );
  }
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
