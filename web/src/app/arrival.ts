/*
 * Arriving on a screen: what the tab and the history call it, and where focus goes. Botbench serves one page, so the
 * browser does neither on its own when the address changes.
 */

/** The tab's name for a screen: the screen first, so a row of tabs and the history can be told apart. */
export const tabTitle = (screen: string): string => `${screen} \u2013 Botbench`;

let navigated = false;

/** The address changed after the page loaded: the next screen's heading takes focus when it is drawn. */
export function noteNavigation(): void {
  navigated = true;
}

/**
 * Called when a screen's one h1 is drawn. After a change of address it moves focus to the heading, so a keyboard or a
 * screen reader starts at the top of the new screen and hears its name, instead of staying on the link that led here.
 * A screen that has already put focus in a field of its own (the message box, a dialog) keeps it, and so does the
 * first screen after a page load.
 */
export function arrive(heading: HTMLElement | null): void {
  if (!navigated || heading === null) return;
  navigated = false;
  requestAnimationFrame(() => {
    const active = document.activeElement;
    const main = heading.closest("main");
    if (active !== null && active !== document.body && (main?.contains(active) || active.closest("dialog[open]") !== null)) return;
    heading.focus();
  });
}
