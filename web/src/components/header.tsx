import type { ReactNode } from "react";
import { ApprovalTray } from "./approval-card.tsx";
import { Icon, type IconName } from "./icon.tsx";

/**
 * The destinations the navigation lists. Every one of them exists. Starting something new is an action, not a
 * destination: New run and New task are buttons in the Runs and Tasks views, as the design system has it, which
 * also keeps the phone's tab bar within the five it holds.
 */
const SCREENS: readonly { name: string; label: string; href: string; icon: IconName }[] = [
  { name: "turn", label: "Chat", href: "#/turn", icon: "terminal" },
  { name: "runs", label: "Runs", href: "#/runs", icon: "git-branch" },
  { name: "tasks", label: "Tasks", href: "#/tasks", icon: "file" },
  { name: "trust", label: "Permissions", href: "#/trust", icon: "circle-check" },
];
export type ScreenName = "turn" | "runs" | "tasks" | "trust";

/**
 * What every signed-in screen stands in: the app header with the approvals tray, the banner when there is one, the
 * navigation (a tab bar on a phone, a sidebar from 768px; only one of the two is ever drawn or announced) and the
 * screen itself. `fill` keeps the frame at the height of the window, for a screen that scrolls inside itself.
 */
export function Frame({ current, banner, fill = false, children }: { current: ScreenName | null; banner?: ReactNode; fill?: boolean; children: ReactNode }) {
  return (
    <div className={fill ? "gw-app-shell h-screen" : "gw-app-shell"}>
      <header className="gw-app-header gw-app-header--sticky">
        <a className="gw-app-header__name" href="#/turn">
          Botbench
        </a>
        <div className="gw-app-header__tray">
          <ApprovalTray />
        </div>
      </header>
      {banner}
      <div className="gw-sidebar-layout gw-app-shell__body min-h-0 grid-rows-1">
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

/** The main column of an ordinary screen, as the design system's app shell has it: it starts with the view's page header, which holds the one h1. */
export function Page({ children }: { children: ReactNode }) {
  return <main className="gw-container gw-app-shell__main min-w-0">{children}</main>;
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
        {title !== undefined && <p className="gw-alert__title">{title}</p>}
        <p className="gw-alert__body">{children}</p>
        {action !== undefined && <div className="gw-alert__action">{action}</div>}
      </div>
    </div>
  );
}

/** The top of a view: its one h1 and, under it, what the view adds. `action` is the view's own action, beside the title. */
export function PageHeader({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <header className="gw-page-header">
      <div className="gw-page-header__text">
        <h1 className="gw-page-header__title">{title}</h1>
        {children}
      </div>
      {action !== undefined && <div className="gw-page-header__action">{action}</div>}
    </header>
  );
}

/** A list view's one main action: the link to the screen that starts a new one. */
export function NewLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="gw-button gw-button--primary">
      <Icon name="plus" className="gw-button__icon" />
      {children}
    </a>
  );
}
