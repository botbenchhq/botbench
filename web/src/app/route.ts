import type { RunSourceRef } from "../api/client.ts";
import type { Kind } from "./composer.ts";
import { sourceInAddress } from "./run-source.ts";

/*
 * The client's addresses and the screen each names, as a plain function so it is tested without a browser
 * (test/route.test.ts). The part after `#` is the whole address: the server only ever serves the one page.
 */

/** A section of the two-pane Settings, from 1024px (screens/settings.tsx). */
export type SettingsSection = "agents" | "appearance" | "notifications" | "devices" | "workbench" | "paired" | "permissions" | "usage";

export type Route =
  | { screen: "turn"; start: Kind | null; proposal?: number; from?: RunSourceRef; fresh?: true }
  | { screen: "redirect"; to: string }
  | { screen: "trust" }
  | { screen: "usage" }
  | { screen: "task"; id: number; discard: boolean; rebuilt: boolean }
  | { screen: "work" }
  | { screen: "settings"; section: SettingsSection | null }
  | { screen: "run"; id: number }
  | { screen: "chat"; id: number }
  | { screen: "thread"; pairingId: string; contextId: string }
  | { screen: "none"; what: string };

/** The screen an address names. */
export function parseRoute(hash: string): Route {
  const at = hash.replace(/^#/, "");
  if (at === "" || at === "/" || at === "/turn") return { screen: "turn", start: null };
  // New chat or task: the composer with its four intents, and no chat on the screen.
  if (at === "/new") return { screen: "turn", start: null, fresh: true };
  // New task and New run open the composer with that kind chosen.
  if (at === "/turn?start=task" || at === "/turn?start=run") return { screen: "turn", start: at.endsWith("task") ? "task" : "run" };
  // Make this a run, on a finished task or a chat: Plan a run, with the owner's note as the prompt (components/make-run.tsx).
  const from = sourceInAddress(at);
  if (from !== null) return { screen: "turn", start: "run", from };
  // Start on an issue proposed on Work: a run, with the From an issue row opened on that issue (components/proposals.tsx).
  const proposed = /^\/turn\?start=run&proposal=([1-9]\d{0,14})$/.exec(at);
  if (proposed) return { screen: "turn", start: "run", proposal: Number(proposed[1]) };
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
  // The other sections of the two-pane Settings, from 1024px. Permissions and Usage keep their own addresses.
  const part = /^\/settings\/(appearance|notifications|devices|workbench|paired)$/.exec(at);
  if (part) return { screen: "settings", section: part[1] as SettingsSection };
  // One conversation with the paired workbench, from its card or from Settings → Paired workbench.
  const thread = /^\/paired\/([0-9a-f-]{36})\/threads\/([0-9a-f-]{36})$/.exec(at);
  if (thread) return { screen: "thread", pairingId: thread[1]!, contextId: thread[2]! };
  // A chat from the Work list: Chat, with that chat on it.
  const chat = /^\/chats\/([1-9]\d{0,14})$/.exec(at);
  if (chat) return { screen: "chat", id: Number(chat[1]) };
  // A task's Discard chosen from its More menu on Work: the task's screen, with Discard's confirmation open.
  // With ?new=1: the same task on the review screen rebuilt on shadcn/ui (ADR 0012), beside the old one until it replaces it.
  const task = /^\/tasks\/([1-9]\d{0,14})(\?discard|\?new=1)?$/.exec(at);
  if (task) return { screen: "task", id: Number(task[1]), discard: task[2] === "?discard", rebuilt: task[2] === "?new=1" };
  const run = /^\/runs\/([1-9]\d{0,14})$/.exec(at);
  return run ? { screen: "run", id: Number(run[1]) } : { screen: "none", what: at };
}
