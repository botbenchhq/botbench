import path from "node:path";
import type { Page } from "@playwright/test";
import { SHOTS } from "./helpers.ts";

// What a screen filled with long and many things must still hold to, measured in the page (e2e/stress.e2e.ts): nothing
// drawn past the window's edge, no text cut off without an ellipsis, no two controls on top of each other, and text
// that can be read against what is behind it. `checkScreen` (helpers.ts) keeps the words, the control heights and the
// smallest text; this is the part that only shows with stressed content.

/** The widths the shell changes at, each with the width just under it, and the five sizes of the approved design. */
export const WIDTHS = [
  { width: 390, height: 844, touch: true },
  { width: 767, height: 1024, touch: true },
  { width: 768, height: 1024, touch: true },
  { width: 1023, height: 768, touch: false },
  { width: 1024, height: 768, touch: false },
  { width: 1279, height: 800, touch: false },
  { width: 1280, height: 800, touch: false },
  { width: 1440, height: 900, touch: false },
] as const;

export interface Fit {
  /** How far the page scrolls sideways, in px. */
  sideways: number;
  /** Things drawn past the window's right or left edge, outside anything that scrolls. */
  past: string[];
  /** Text cut off by its own box or one around it, with no ellipsis to say so. */
  clipped: string[];
  /** Two controls drawn over each other. */
  overlapping: string[];
  /** Text under 4.5:1 against what is behind it (3:1 for large text). */
  faint: string[];
}

/** Measure the screen as it stands. `faint` is left empty unless `contrast` is asked for, since it paints each colour to read it. */
export async function fit(page: Page, { contrast = false }: { contrast?: boolean } = {}): Promise<Fit> {
  await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))), new Promise((resolve) => setTimeout(resolve, 600))]));
  return page.evaluate((contrast) => {
    const width = document.documentElement.clientWidth;
    const say = (el: Element): string => `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
    const drawn = (el: Element): boolean => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      // Not drawn, or drawn only for assistive technology (sr-only is a 1px box that clips its words).
      if (!(box.width > 1 && box.height > 1 && style.visibility !== "hidden")) return false;
      for (let up: Element | null = el; up !== null; up = up.parentElement) {
        const s = getComputedStyle(up);
        if (s.position === "absolute" && s.overflow === "hidden" && up.getBoundingClientRect().width <= 2) return false;
      }
      return true;
    };
    /** The nearest box around `el` that cuts off or scrolls what passes its sides. */
    const clipper = (el: Element): { el: Element; scrolls: boolean } | null => {
      for (let up = el.parentElement; up !== null; up = up.parentElement) {
        const x = getComputedStyle(up).overflowX;
        if (x === "auto" || x === "scroll") return { el: up, scrolls: true };
        if (x === "hidden" || x === "clip") return { el: up, scrolls: false };
      }
      return null;
    };
    const ellipsis = (el: Element): boolean => {
      for (let up: Element | null = el; up !== null; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") return true;
      }
      return false;
    };
    const past: string[] = [];
    const clipped: string[] = [];
    const leaves = [...document.querySelectorAll("body *")].filter((el) => drawn(el) && [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== ""));
    for (const el of [...document.querySelectorAll("body *")].filter(drawn)) {
      const box = el.getBoundingClientRect();
      const around = clipper(el);
      if ((box.right > width + 1 || box.left < -1) && around === null) past.push(`${say(el)} reaches ${Math.round(box.right)} of ${width}`);
    }
    for (const el of leaves) {
      const style = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      // A field scrolls its own words; a select shows its choice's start.
      if (tag === "input" || tag === "textarea" || tag === "select" || tag === "option") continue;
      // Cut off by its own box.
      if ((style.overflowX === "hidden" || style.overflowX === "clip") && el.scrollWidth > el.clientWidth + 1 && !ellipsis(el)) clipped.push(`${say(el)} is cut at ${el.clientWidth} of ${el.scrollWidth}`);
      // Its words run past its own box, onto whatever is beside it.
      if (style.overflowX === "visible" && style.display !== "inline") {
        const own = el.getBoundingClientRect();
        for (const node of el.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim() === "") continue;
          const range = document.createRange();
          range.selectNode(node);
          const words = range.getBoundingClientRect();
          // More than a space: a line of kept white space (pre-wrap) ends in one that hangs past the box, which is not a word.
          if (words.right > own.right + 6 || words.left < own.left - 6) clipped.push(`${say(el)} has words past its own box by ${Math.round(Math.max(words.right - own.right, own.left - words.left))}px`);
        }
      }
      // Cut off by a box around it that does not scroll.
      const around = clipper(el);
      if (around !== null && !around.scrolls && !ellipsis(el)) {
        const box = el.getBoundingClientRect();
        const outer = around.el.getBoundingClientRect();
        if (box.right > outer.right + 1 || box.left < outer.left - 1) clipped.push(`${say(el)} passes the side of ${say(around.el).slice(0, 40)}`);
      }
    }
    const overlapping: string[] = [];
    const controls = [...document.querySelectorAll("button, select, textarea, input:not([type=radio]):not([type=checkbox]), a[href], summary")].filter((el) => drawn(el) && getComputedStyle(el).display !== "inline" && el.closest("[aria-hidden=true]") === null);
    // Only what is on top counts where a dialog or a sheet is open: the page under it is covered on purpose.
    const top = document.querySelector("[role=dialog], [role=alertdialog], [role=menu]");
    const shown = top === null ? controls : controls.filter((el) => top.contains(el));
    for (const [i, a] of shown.entries()) {
      for (const b of shown.slice(i + 1)) {
        if (a.contains(b) || b.contains(a)) continue;
        const [p, q] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
        const across = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const down = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        // Something that sticks to the window's edge lies over what scrolls under it, on purpose.
        const sticks = (el: Element): boolean => {
          for (let up: Element | null = el; up !== null; up = up.parentElement) if (["sticky", "fixed"].includes(getComputedStyle(up).position)) return true;
          return false;
        };
        if (across > 1 && down > 1 && sticks(a) === sticks(b)) overlapping.push(`${say(a)} and ${say(b)} by ${Math.round(across)}×${Math.round(down)}`);
      }
    }
    const faint: string[] = [];
    if (contrast) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      /** `colours` painted one over the other, the first at the bottom, as the screen's own red, green and blue. */
      const painted = (colours: string[]): [number, number, number] => {
        ctx.clearRect(0, 0, 1, 1);
        for (const colour of colours) {
          ctx.fillStyle = colour;
          ctx.fillRect(0, 0, 1, 1);
        }
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return [r!, g!, b!];
      };
      const light = ([r, g, b]: [number, number, number]): number => {
        const part = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * part(r) + 0.7152 * part(g) + 0.0722 * part(b);
      };
      for (const el of leaves) {
        const style = getComputedStyle(el);
        if (el.closest(":disabled, [aria-disabled=true], [class*='ds-']") !== null || parseFloat(style.opacity) < 1) continue;
        // What is behind the words: every background from the page up to the element, painted in order.
        const behind: string[] = [];
        let dimmed = false;
        for (let up: Element | null = el; up !== null; up = up.parentElement) {
          const s = getComputedStyle(up);
          if (parseFloat(s.opacity) < 1 || s.backgroundImage !== "none") dimmed = true;
          behind.unshift(s.backgroundColor);
        }
        if (dimmed) continue;
        const back = painted(["#fff", ...behind]);
        const fore = painted([`rgb(${back.join(" ")})`, style.color]);
        const [hi, lo] = [light(back), light(fore)].sort((a, b) => b - a) as [number, number];
        const ratio = (hi + 0.05) / (lo + 0.05);
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5) - 0.05) faint.push(`${say(el)} is ${ratio.toFixed(2)}:1 (${style.color} on rgb(${back.join(" ")}))`);
      }
    }
    return { sideways: document.documentElement.scrollWidth - width, past: [...new Set(past)].slice(0, 12), clipped: [...new Set(clipped)].slice(0, 12), overlapping: overlapping.slice(0, 12), faint: [...new Set(faint)].slice(0, 12) };
  }, contrast);
}

/** A picture of the window as it stands, kept as `<BOTBENCH_SHOTS>/<name>.png` when that folder is named. */
export async function picture(page: Page, name: string, fullPage = false): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage, scale: "css" });
}
