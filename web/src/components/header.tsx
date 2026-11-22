import type { ReactNode } from "react";
import { ApprovalTray } from "./approval-card.tsx";
import darkMark from "../brand/mark-dark.svg";
import lightMark from "../brand/mark-light.svg";
import { useAppearance } from "../app/appearance.ts";
import { Icon, type IconName } from "./icon.tsx";

/**
 * The destinations the navigation lists. Every one of them exists. Starting something new is an action, not a
 * destination: New run and New task are buttons in the Runs and Tasks views, as the design system has it, which
 * also keeps the phone's tab bar within the five it holds (Chat, Runs, Tasks, Permissions, Usage). Settings is not a destination either: it is the app
 * header's action, on every signed-in screen, so the tab bar keeps room for the app's main destinations.
 */
const SCREENS: readonly { name: string; label: string; href: string; icon: IconName }[] = [
  { name: "turn", label: "Chat", href: "#/turn", icon: "terminal" },
  { name: "runs", label: "Runs", href: "#/runs", icon: "git-branch" },
  { name: "tasks", label: "Tasks", href: "#/tasks", icon: "file" },
  { name: "trust", label: "Permissions", href: "#/trust", icon: "circle-check" },
  { name: "usage", label: "Usage", href: "#/usage", icon: "clock" },
];
export type ScreenName = "turn" | "runs" | "tasks" | "trust" | "usage";

/**
 * What every signed-in screen stands in: the app header with the approvals tray, the banner when there is one, the
 * navigation (a tab bar on a phone, a sidebar from 768px; only one of the two is ever drawn or announced) and the
 * screen itself. `fill` keeps the frame at the height of the window, for a screen that scrolls inside itself.
 */
export function Frame({ current, banner, fill = false, children }: { current: ScreenName | null; banner?: ReactNode; fill?: boolean; children: ReactNode }) {
  // The mark drawn for the page's surface: the dark-surface variant in dark mode, the light-surface one in light.
  const { drawn } = useAppearance();
  return (
    <div className={fill ? "ds-app-shell h-screen" : "ds-app-shell"}>
      <header className="ds-app-header ds-app-header--sticky">
        <a className="ds-app-header__name" href="#/turn">
          {/* Decorative: the word beside it is the name. */}
          <img src={drawn === "light" ? lightMark : darkMark} alt="" width={20} height={20} />
          Botbench
        </a>
        <div className="ds-app-header__actions">
          {/* A link to another view, in words: the icon set has no settings icon (recorded in web/design-gaps.json). */}
          <a className="ds-app-header__action" href="#/settings">
            Settings
          </a>
        </div>
        <div className="ds-app-header__tray">
          <ApprovalTray />
        </div>
      </header>
      {banner}
      <div className="ds-sidebar-layout ds-app-shell__body min-h-0 grid-rows-1">
        <nav className="ds-sidebar-nav" aria-label="Screens">
          <ul className="ds-sidebar-nav__items">
            {SCREENS.map((screen) => (
              <li key={screen.name}>
                <a className="ds-sidebar-nav__item" href={screen.href} aria-current={screen.name === current ? "page" : undefined}>
                  <Icon name={screen.icon} className="ds-sidebar-nav__icon" />
                  <span className="ds-sidebar-nav__label">{screen.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {children}
      </div>
      <nav className="ds-tab-bar" aria-label="Screens">
        {SCREENS.map((screen) => (
          <a key={screen.name} className="ds-tab-bar__item" href={screen.href} aria-current={screen.name === current ? "page" : undefined}>
            <Icon name={screen.icon} className="ds-tab-bar__icon" />
            <span className="ds-tab-bar__label">{screen.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

/**
 * The main column of an ordinary screen, as the design system's app shell has it: it starts with the view's page header,
 * which holds the one h1. `pattern` is the page pattern the main element is, when the screen is one (the settings page).
 */
export function Page({ pattern, children }: { pattern?: "ds-settings-page"; children: ReactNode }) {
  return <main className={`ds-container ds-app-shell__main min-w-0${pattern === undefined ? "" : ` ${pattern}`}`}>{children}</main>;
}

/** The connection-lost banner, under the app header. */
export function StreamBanner() {
  return (
    <div className="ds-banner ds-banner--warning" role="status" data-testid="stream-banner">
      <p className="ds-banner__text">Live updates are disconnected. Reconnecting.</p>
    </div>
  );
}

/** A message inside a view. `tone` picks the word that names it; the stylesheet draws the matching icon. */
export function Alert({ tone, role, id, testId, title, action, children }: { tone: "note" | "warning" | "error"; role?: "status" | "alert"; id?: string; testId?: string; title?: string; action?: ReactNode; children: ReactNode }) {
  const look = { note: "ds-alert", warning: "ds-alert ds-alert--warning", error: "ds-alert ds-alert--danger" }[tone];
  const label = { note: "Note", warning: "Warning", error: "Error" }[tone];
  return (
    <div className={look} role={role} id={id} data-testid={testId}>
      <div className="ds-alert__content">
        <p className="ds-alert__label">{label}</p>
        {title !== undefined && <p className="ds-alert__title">{title}</p>}
        <p className="ds-alert__body">{children}</p>
        {action !== undefined && <div className="ds-alert__action">{action}</div>}
      </div>
    </div>
  );
}

/** The top of a view: its one h1 and, under it, what the view adds. `action` is the view's own action, beside the title. */
export function PageHeader({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ds-page-header">
      <div className="ds-page-header__text">
        <h1 className="ds-page-header__title">{title}</h1>
        {children}
      </div>
      {action !== undefined && <div className="ds-page-header__action">{action}</div>}
    </header>
  );
}

/** A list view's one main action: the link to the screen that starts a new one. */
export function NewLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="ds-button ds-button--primary">
      <Icon name="plus" className="ds-button__icon" />
      {children}
    </a>
  );
}
