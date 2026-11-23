import { useSyncExternalStore } from "react";

/**
 * From this width a screen has the column of chats and work beside it, and Settings is two panes. Below it every screen
 * is as it was. Approach from OpenMausBot src/components/settings/SettingsWindow.tsx: one media query decides which
 * layout is drawn, so the narrow layout's markup is left as it is rather than restyled.
 */
export const WIDE = "(min-width: 1024px)";

const query = (): MediaQueryList => window.matchMedia(WIDE);
const subscribe = (changed: () => void): (() => void) => {
  const list = query();
  list.addEventListener("change", changed);
  return () => list.removeEventListener("change", changed);
};

/** Whether the window is at least 1024px wide now; the screen is drawn again when it crosses that width. */
export const useWide = (): boolean => useSyncExternalStore(subscribe, () => query().matches);
