import type { ReactNode } from "react";
import { ApprovalTray } from "./approval-card.tsx";
import { Icon, type IconName } from "./icon.tsx";

/** The screens the navigation lists. Every one of them exists. */
const SCREENS: readonly { name: string; label: string; href: string; icon: IconName }[] = [
  { name: "turn", label: "Turn", href: "#/turn", icon: "terminal" },
  { name: "tasks", label: "Tasks", href: "#/tasks", icon: "file" },
  { name: "new-task", label: "New task", href: "#/tasks/new", icon: "plus" },
  { name: "trust", label: "Trust", href: "#/trust", icon: "circle-check" },
];
export type ScreenName = "turn" | "tasks" | "new-task" | "trust";

/**
 * What every signed-in screen stands in: the app header with the approvals tray, the banner when there is one, the
 * navigation (a tab bar on a phone, a sidebar from 768px; only one of the two is ever drawn or announced) and the
 * screen itself. `fill` keeps the frame at the height of the window, for a screen that scrolls inside itself.
 */
export function Frame({ current, banner, fill = false, children }: { current: ScreenName | null; banner?: ReactNode; fill?: boolean; children: ReactNode }) {
  return (
    <div className={fill ? "flex h-screen flex-col" : "flex min-h-screen flex-col"}>
      <header className="gw-app-header gw-app-header--sticky">
        <a className="gw-app-header__name" href="#/turn">
          Smelt
        </a>
        <div className="gw-app-header__tray">
          <ApprovalTray />
        </div>
      </header>
      {banner}
      <div className="gw-sidebar-layout min-h-0 flex-1 grid-rows-1">
        <nav className="gw-sidebar-nav" aria-label="Screens">
          <ul className="gw-sidebar-nav__items">
            {SCREENS.map((screen) => (
              <li key={screen.name}>
                <a className="gw-sidebar-nav__item" href={screen.href} aria-current={screen.name === current ? "page" : undefined}>
                  <Icon name={screen.icon} className="gw-sidebar-nav__icon" />
                  <span className="gw-sidebar-nav__label">{screen.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {children}
      </div>
      <nav className="gw-tab-bar" aria-label="Screens">
        {SCREENS.map((screen) => (
          <a key={screen.name} className="gw-tab-bar__item" href={screen.href} aria-current={screen.name === current ? "page" : undefined}>
            <Icon name={screen.icon} className="gw-tab-bar__icon" />
            <span className="gw-tab-bar__label">{screen.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

/** The main column of an ordinary screen: one reading-width column, its parts one above the other. */
export function Page({ children }: { children: ReactNode }) {
  return <main className="gw-container gw-stack gw-gap-lg min-w-0 py-lg">{children}</main>;
}

/** The connection-lost banner, under the app header. */
export function StreamBanner() {
  return (
    <div className="gw-banner gw-banner--warning" role="status" data-testid="stream-banner">
      <p className="gw-banner__text">Live updates are disconnected. Reconnecting.</p>
    </div>
  );
}

/** A message inside a view. `tone` picks the word that names it; the stylesheet draws the matching icon. */
export function Alert({ tone, role, id, testId, title, action, children }: { tone: "note" | "warning" | "error"; role?: "status" | "alert"; id?: string; testId?: string; title?: string; action?: ReactNode; children: ReactNode }) {
  const look = { note: "gw-alert", warning: "gw-alert gw-alert--warning", error: "gw-alert gw-alert--danger" }[tone];
  const label = { note: "Note", warning: "Warning", error: "Error" }[tone];
  return (
    <div className={look} role={role} id={id} data-testid={testId}>
      <div className="gw-alert__content">
        <p className="gw-alert__label">{label}</p>
        {title !== undefined && <p className="gw-alert__title sm-wrap">{title}</p>}
        <p className="gw-alert__body sm-wrap">{children}</p>
        {action !== undefined && <div className="gw-alert__action">{action}</div>}
      </div>
    </div>
  );
}

/** The top of a view: its one h1 and, under it, what the view adds. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="gw-page-header">
      <div className="gw-page-header__text">
        <h1 className="gw-page-header__title">{title}</h1>
        {children}
      </div>
    </header>
  );
}
