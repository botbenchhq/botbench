import type { ReactNode } from "react";
import { ApprovalTray } from "./approval-card.tsx";

/** The product name, as every screen shows it. */
export function Mark() {
  return <span className="font-mono text-mono font-semibold uppercase tracking-widest">Smelt</span>;
}

/** The screens the navigation lists. Every one of them exists. */
const SCREENS = [
  { name: "turn", label: "Turn", href: "#/turn" },
  { name: "tasks", label: "Tasks", href: "#/tasks" },
  { name: "new-task", label: "New task", href: "#/tasks/new" },
  { name: "trust", label: "Trust", href: "#/trust" },
] as const;
type ScreenName = (typeof SCREENS)[number]["name"];

/** The top of every signed-in screen: the name, the navigation, the approvals tray, and whatever the screen adds below. */
export function Header({ current, children }: { current: ScreenName | null; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-xs border-b px-lg py-sm">
      <div className="flex items-center gap-md">
        <Mark />
        <nav aria-label="Screens" className="flex gap-xs font-mono text-mono">
          {SCREENS.map((screen) => (
            <a
              key={screen.name}
              href={screen.href}
              aria-current={screen.name === current ? "page" : undefined}
              className={`inline-flex min-h-touch min-w-touch items-center justify-center px-sm ${screen.name === current ? "font-semibold underline underline-offset-xs" : "text-muted"}`}
            >
              {screen.label}
            </a>
          ))}
        </nav>
      </div>
      <ApprovalTray />
      {children}
    </header>
  );
}
