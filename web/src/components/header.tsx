import { useContext, type ReactNode } from "react";
import { ApprovalTray } from "./approval-card.tsx";
import { trayShows } from "./approval-tray.ts";
import { ApprovalsContext } from "../app/approvals.tsx";
import darkMark from "../brand/mark-dark.svg";
import lightMark from "../brand/mark-light.svg";
import { useAppearance } from "../app/appearance.ts";
import { Icon, type IconName } from "./icon.tsx";

/**
 * The destinations the navigation lists, and every one of them exists: Chat, where anything starts, and Work, the
 * runs and the tasks started on their own. Starting something new is an action, not a destination. Settings is the
 * app header's action on every signed-in screen, and Permissions and Usage are reached from it.
 */
const SCREENS: readonly { name: ScreenName; label: string; href: string; icon: IconName }[] = [
  { name: "turn", label: "Chat", href: "#/turn", icon: "message" },
  { name: "work", label: "Work", href: "#/work", icon: "git-branch" },
];
export type ScreenName = "turn" | "work";

/**
 * What every signed-in screen stands in: the app header with the approvals tray, the banner when there is one, the
 * navigation (a tab bar on a phone, a sidebar from 768px; only one of the two is ever drawn or announced) and the
 * screen itself. `fill` keeps the frame at the height of the window, for a screen that scrolls inside itself.
 * `back` puts a link back to the screen this one is reached from in place of the product name (and, for Settings, in
 * place of the gear). `actions` are the
 * screen's own quiet icon actions, before Settings. `showing` holds the ids of the approvals whose card this screen
 * shows: when it shows every one waiting, the tray keeps only its live line.
 */
export function Frame({ current, banner, fill = false, back, actions, showing = [], children }: { current: ScreenName | null; banner?: ReactNode; fill?: boolean; back?: { href: string; label: string }; actions?: ReactNode; showing?: readonly number[]; children: ReactNode }) {
  // The mark drawn for the page's surface: the dark-surface variant in dark mode, the light-surface one in light.
  const { drawn } = useAppearance();
  // The tray takes a row of the header only while it has something to say. Its live region stays in the page either way.
  const { pending, problem } = useContext(ApprovalsContext);
  const tray = trayShows({ pending, showing, problem });
  return (
    <div className={fill ? "ds-app-shell h-screen" : "ds-app-shell"}>
      <header className="ds-app-header ds-app-header--sticky">
        {back === undefined ? (
          <a className="ds-app-header__name" href="#/turn">
            {/* Decorative: the word beside it is the name. */}
            <img src={drawn === "light" ? lightMark : darkMark} alt="" width={20} height={20} />
            Botbench
          </a>
        ) : (
          <a className="ds-app-header__back" href={back.href}>
            <Icon name="chevron-left" className="ds-app-header__icon" />
            {back.label}
          </a>
        )}
        <div className="ds-app-header__actions">
          {actions}
          {/* On a screen reached from Settings, the back link already leads there. */}
          {back?.href !== "#/settings" && (
            <a className="ds-app-header__action" href="#/settings" aria-label="Settings">
              <Icon name="settings" className="ds-app-header__icon" />
            </a>
          )}
        </div>
        <div className={tray === "tray" ? "ds-app-header__tray" : undefined}>
          <ApprovalTray here={tray === "here"} />
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
export function PageHeader({ title, theirs = false, hidden = false, action, children }: { title: string; theirs?: boolean; hidden?: boolean; action?: ReactNode; children?: ReactNode }) {
  // `theirs`: the title is somebody else's words (a task's prompt). `hidden`: the view's one h1 is for assistive
  // technology only, on a screen whose content says what it is (the chat).
  return (
    <header className={hidden ? "ds-page-header ds-visually-hidden" : "ds-page-header"}>
      <div className="ds-page-header__text">
        <h1 data-ds-content={theirs ? "" : undefined} className="ds-page-header__title">
          {title}
        </h1>
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
