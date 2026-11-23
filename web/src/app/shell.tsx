import { useCallback, useEffect, useState } from "react";
import { hasSession } from "../api/client.ts";
import type { Kind } from "./composer.ts";
import { ApprovalsProvider } from "./approvals.tsx";
import { Alert, Frame, Page } from "../components/header.tsx";
import { BoardScreen } from "../screens/board.tsx";
import { RunScreen } from "../screens/run.tsx";
import { SettingsScreen } from "../screens/settings.tsx";
import { SignInScreen } from "../screens/sign-in.tsx";
import { TaskScreen } from "../screens/task.tsx";
import { TrustScreen } from "../screens/trust.tsx";
import { OpenChat, TurnScreen } from "../screens/turn.tsx";
import { UsageScreen } from "../screens/usage.tsx";

type Session = "checking" | "unreachable" | "signed-out" | "signed-in";

type Route = { screen: "turn"; start: Kind | null } | { screen: "redirect"; to: string } | { screen: "trust" } | { screen: "usage" } | { screen: "task"; id: number; discard: boolean } | { screen: "work" } | { screen: "settings"; section: "agents" | null } | { screen: "run"; id: number } | { screen: "chat"; id: number } | { screen: "none"; what: string };

/** The screen an address names. The part after `#` is the whole address: the server only ever serves the one page. */
function parseRoute(hash: string): Route {
  const at = hash.replace(/^#/, "");
  if (at === "" || at === "/" || at === "/turn") return { screen: "turn", start: null };
  // New task and New run open the composer with that kind chosen.
  if (at === "/turn?start=task" || at === "/turn?start=run") return { screen: "turn", start: at.endsWith("task") ? "task" : "run" };
  // The addresses of the New task and New run forms the composer replaced.
  if (at === "/tasks/new") return { screen: "redirect", to: "#/turn?start=task" };
  if (at === "/runs/new") return { screen: "redirect", to: "#/turn?start=run" };
  // Work lists the runs and the tasks started on their own, where Runs and Tasks were.
  if (at === "/work") return { screen: "work" };
  if (at === "/runs" || at === "/tasks") return { screen: "redirect", to: "#/work" };
  // The sign-in address from Add a device, opened on a device that is already signed in: the code is not needed.
  if (at.startsWith("code=")) return { screen: "redirect", to: "#/" };
  if (at === "/trust") return { screen: "trust" };
  if (at === "/usage") return { screen: "usage" };
  if (at === "/settings") return { screen: "settings", section: null };
  // Settings at its Agents section: where the home screen sends the owner to connect an agent.
  if (at === "/settings/agents") return { screen: "settings", section: "agents" };
  // A chat from the Work list: Chat, with that chat on it.
  const chat = /^\/chats\/([1-9]\d{0,14})$/.exec(at);
  if (chat) return { screen: "chat", id: Number(chat[1]) };
  // A task's Discard chosen from its More menu on Work: the task's screen, with Discard's confirmation open.
  const task = /^\/tasks\/([1-9]\d{0,14})(\?discard)?$/.exec(at);
  if (task) return { screen: "task", id: Number(task[1]), discard: task[2] !== undefined };
  const run = /^\/runs\/([1-9]\d{0,14})$/.exec(at);
  return run ? { screen: "run", id: Number(run[1]) } : { screen: "none", what: at };
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

/** An old address: replaced in the history by the new one, so Back does not return to it. */
function Redirect({ to }: { to: string }) {
  useEffect(() => window.location.replace(to), [to]);
  return null;
}

function screenFor(route: Route, onSignedOut: () => void) {
  if (route.screen === "turn") return <TurnScreen key={route.start ?? ""} start={route.start} onSignedOut={onSignedOut} />;
  if (route.screen === "redirect") return <Redirect to={route.to} />;
  if (route.screen === "trust") return <TrustScreen onSignedOut={onSignedOut} />;
  if (route.screen === "usage") return <UsageScreen onSignedOut={onSignedOut} />;
  if (route.screen === "work") return <BoardScreen onSignedOut={onSignedOut} />;
  if (route.screen === "settings") return <SettingsScreen section={route.section} onSignedOut={onSignedOut} />;
  if (route.screen === "run") return <RunScreen key={route.id} id={route.id} onSignedOut={onSignedOut} />;
  // The key gives each task its own screen state, so one task's transcript never shows under another's name.
  if (route.screen === "task") return <TaskScreen key={route.id} id={route.id} discard={route.discard} onSignedOut={onSignedOut} />;
  if (route.screen === "chat") return <OpenChat key={route.id} id={route.id} onSignedOut={onSignedOut} />;
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

  // A real page load after signing in, not only a new screen: Safari offers to save a password for a form after the
  // page that follows it loads, so the phone's password manager can keep the token. The address is kept.
  const onSignedIn = useCallback(() => window.location.reload(), []);
  const onSignedOut = useCallback(() => {
    setNotice("This device was signed out. Sign in again.");
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
