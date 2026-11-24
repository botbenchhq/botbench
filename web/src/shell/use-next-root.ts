import { useLayoutEffect } from "react";

/**
 * While a screen rebuilt on shadcn/ui is shown, the page's root carries data-ui="next", and styles/theme.css gives the
 * page the new theme's canvas, text and typefaces. An overlay is drawn in the body, outside the screen's own tree, so
 * the mark is on the root. It is taken off when the screen goes, and the old screens look as they did.
 */
export function useNextRoot(): void {
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-ui", "next");
    return () => document.documentElement.removeAttribute("data-ui");
  }, []);
}
