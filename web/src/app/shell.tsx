import { useCallback, useEffect, useState } from "react";
import { hasSession } from "../api/client.ts";
import { ApprovalsProvider } from "./approvals.tsx";
import { Alert, Frame, Page } from "../components/header.tsx";
import { NewRunScreen } from "../screens/new-run.tsx";
import { NewTaskScreen } from "../screens/new-task.tsx";
import { RunScreen } from "../screens/run.tsx";
import { RunsScreen } from "../screens/runs.tsx";
import { SignInScreen } from "../screens/sign-in.tsx";
import { TaskScreen } from "../screens/task.tsx";
import { TasksScreen } from "../screens/tasks.tsx";
import { TrustScreen } from "../screens/trust.tsx";
import { TurnScreen } from "../screens/turn.tsx";

type Session = "checking" | "unreachable" | "signed-out" | "signed-in";

type Route = { screen: "turn" } | { screen: "tasks" } | { screen: "new-task" } | { screen: "trust" } | { screen: "task"; id: number } | { screen: "runs" } | { screen: "new-run" } | { screen: "run"; id: number } | { screen: "none"; what: string };

/** The screen an address names. The part after `#` is the whole address: the server only ever serves the one page. */
function parseRoute(hash: string): Route {
  const at = hash.replace(/^#/, "");
  if (at === "" || at === "/" || at === "/turn") return { screen: "turn" };
  if (at === "/tasks") return { screen: "tasks" };
  if (at === "/tasks/new") return { screen: "new-task" };
  if (at === "/trust") return { screen: "trust" };
  if (at === "/runs") return { screen: "runs" };
  if (at === "/runs/new") return { screen: "new-run" };
  const one = /^\/(tasks|runs)\/([1-9]\d{0,14})$/.exec(at);
  return one ? { screen: one[1] === "runs" ? "run" : "task", id: Number(one[2]) } : { screen: "none", what: at };
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

function screenFor(route: Route, onSignedOut: () => void) {
  if (route.screen === "turn") return <TurnScreen onSignedOut={onSignedOut} />;
  if (route.screen === "tasks") return <TasksScreen onSignedOut={onSignedOut} />;
  if (route.screen === "new-task") return <NewTaskScreen onSignedOut={onSignedOut} />;
  if (route.screen === "trust") return <TrustScreen onSignedOut={onSignedOut} />;
  if (route.screen === "runs") return <RunsScreen onSignedOut={onSignedOut} />;
  if (route.screen === "new-run") return <NewRunScreen onSignedOut={onSignedOut} />;
  if (route.screen === "run") return <RunScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />;
  // The key gives each task its own screen state, so one task's transcript never shows under another's name.
  if (route.screen === "task") return <TaskScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />;
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
    setNotice("Your session ended, which happens when Botbench restarts. Sign in again.");
    setSession("signed-out");
  }, []);

  if (session === "signed-in") {
    // One provider above every screen: the tray in each screen's header and the card on a task's screen read the same list.
    return <ApprovalsProvider onSignedOut={onSignedOut}>{screenFor(route, onSignedOut)}</ApprovalsProvider>;
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
