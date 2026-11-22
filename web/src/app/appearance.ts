import { useSyncExternalStore } from "react";
import theme from "../../vendor/design-system/themes/botbench.json";

/*
 * The owner's appearance choice, kept on this device only. It is drawn as the Botbench theme documents it: the root's
 * data-theme is "dark", "light" or "auto" (which follows the device). The attribute is always set, also for the default,
 * dark: without it the theme still draws dark, but the page's color-scheme stays light, so native controls and
 * scrollbars would be drawn for a light page. The browser bar takes the theme's colour for the mode the page shows.
 *
 * The inline script in index.html applies the stored choice before the first paint, the same way; it cannot import
 * this module, which runs only once the client has loaded. The end-to-end tests check both.
 */

export type Appearance = "dark" | "light" | "auto";
export type Drawn = "dark" | "light";

/** Where the choice is kept. index.html reads the same key. */
const KEY = "botbench.appearance";
const DEVICE_LIGHT = "(prefers-color-scheme: light)";

const valid = (value: unknown): value is Appearance => value === "dark" || value === "light" || value === "auto";

function stored(): Appearance {
  try {
    const value = window.localStorage.getItem(KEY);
    return valid(value) ? value : "dark";
  } catch {
    // Private browsing may refuse storage: the page is then the default, dark.
    return "dark";
  }
}

const drawnAs = (choice: Appearance): Drawn => (choice === "auto" ? (window.matchMedia(DEVICE_LIGHT).matches ? "light" : "dark") : choice);

/** Set the root's data-theme and the browser bar's colour for `choice`. */
function apply(choice: Appearance): void {
  document.documentElement.setAttribute("data-theme", choice);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.themeColor[drawnAs(choice)]);
}

let current: Appearance = stored();
const listeners = new Set<() => void>();
const changed = (): void => {
  apply(current);
  for (const listener of listeners) listener();
};
// The device's own setting can change while the page is open; Match device follows it.
window.matchMedia(DEVICE_LIGHT).addEventListener("change", () => current === "auto" && changed());
apply(current);

/** Choose a mode for this device: drawn at once and remembered. */
export function chooseAppearance(choice: Appearance): void {
  current = choice;
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    // Not remembered where storage is refused: it holds until the page is reloaded.
  }
  changed();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The choice, and the mode the page is drawn in now (Match device resolved to the device's setting). */
export function useAppearance(): { choice: Appearance; drawn: Drawn } {
  const choice = useSyncExternalStore(subscribe, () => current);
  const drawn = useSyncExternalStore(subscribe, () => drawnAs(current));
  return { choice, drawn };
}
