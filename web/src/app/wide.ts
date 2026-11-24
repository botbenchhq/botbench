import { useSyncExternalStore } from "react";

/**
 * From this width a screen has the column of chats and work beside it, and Settings is two panes. Below it every screen
 * is as it was. Approach from OpenMausBot src/components/settings/SettingsWindow.tsx: one media query decides which
 * layout is drawn, so the narrow layout's markup is left as it is rather than restyled.
 */
export const WIDE = "(min-width: 1024px)";

/** A media query as a value a screen reads: the screen is drawn again when the answer changes. */
function media(text: string): () => boolean {
  const query = (): MediaQueryList => window.matchMedia(text);
  const subscribe = (changed: () => void): (() => void) => {
    const list = query();
    list.addEventListener("change", changed);
    return () => list.removeEventListener("change", changed);
  };
  return () => useSyncExternalStore(subscribe, () => query().matches);
}

/** Whether the window is at least 1024px wide now; the screen is drawn again when it crosses that width. */
export const useWide = media(WIDE);

/** Whether the main pointer is a mouse or a trackpad, which comes with a keyboard: there Enter sends a message. */
export const useFinePointer = media("(pointer: fine)");

/** Whether the window is at least 1280px wide: there a rebuilt screen has its inspector as a third pane (ADR 0012). */
export const useThreePanes = media("(min-width: 1280px)");
