/*
 * Arriving on a screen: what the tab and the history call it, where focus goes, and whether the screen being left
 * agrees to be left. Botbench serves one page, so the browser does none of this on its own when the address changes.
 */

/** The tab's name for a screen: the screen first, so a row of tabs and the history can be told apart. */
export const tabTitle = (screen: string): string => `${screen} \u2013 Botbench`;

let navigated = false;
let unclaimed: number | undefined;

/**
 * The address changed after the page loaded: the next screen's heading takes focus when it is drawn. A change that
 * draws no new heading (a section of the two-pane Settings, which moves focus itself) leaves nothing waiting: the
 * note is dropped after a moment, so a heading drawn later for another reason does not take focus.
 */
export function noteNavigation(): void {
  navigated = true;
  window.clearTimeout(unclaimed);
  unclaimed = window.setTimeout(() => (navigated = false), 250);
}

/** A field somebody may be typing in. */
const typing = (el: Element): boolean => el.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

/**
 * Where focus goes on arrival, given what has it now: nowhere when the owner is in a field (on this screen or in the
 * column beside it), in the screen itself, or in an open dialog; else the heading. A heading drawn for a screen reader
 * only (the chat's) passes focus to the screen's message box where there is a keyboard, so a sighted reader sees it.
 */
export function arrivalTarget(heading: HTMLElement, active: Element | null, fine: boolean): HTMLElement | null {
  const main = heading.closest("main");
  if (active !== null && active !== document.body && (typing(active) || main?.contains(active) || active.closest("dialog[open]") !== null)) return null;
  if (fine && heading.closest(".ds-visually-hidden") !== null) return main?.querySelector<HTMLElement>("textarea:not(:disabled)") ?? heading;
  return heading;
}

/**
 * Called when a screen's one h1 is drawn. After a change of address it moves focus to the heading, so a keyboard or a
 * screen reader starts at the top of the new screen and hears its name, instead of staying on the link that led here.
 * The first screen after a page load is left alone.
 */
export function arrive(heading: HTMLElement | null): void {
  if (!navigated || heading === null) return;
  navigated = false;
  window.clearTimeout(unclaimed);
  requestAnimationFrame(() => arrivalTarget(heading, document.activeElement, window.matchMedia("(pointer: fine)").matches)?.focus());
}

let guard: ((to: string) => boolean) | null = null;

/**
 * A screen that holds unsaved words asks to be told before the address changes: `ask` is given the address the owner
 * is going to and returns whether to go now. Returning false keeps the screen; it then goes there itself (after
 * `setLeaveGuard(null)`) once the owner has answered. One screen at a time; null takes the guard away.
 */
export function setLeaveGuard(ask: ((to: string) => boolean) | null): void {
  guard = ask;
}

/** Whether the screen now shown agrees to the address changing to `to`. */
export const mayLeave = (to: string): boolean => guard === null || guard(to);
