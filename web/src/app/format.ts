/*
 * How the screens write a number, a date, a clock, a duration and a counted noun: the one owner of each rule. Pure, so
 * the tests read it without a browser (test/format.test.ts).
 *
 * The interface's words are English and stay English. The digits, the order of a date and the kind of clock are the
 * reader's own: every function formats with the browser's locale and time zone unless it is given others, which only
 * the tests do.
 */

/** Whose conventions to format with. Left out, the browser's own locale and time zone. */
export interface Where {
  locale?: string | undefined;
  timeZone?: string | undefined;
}

/** An instant as the screens hold one: the stored ISO text, milliseconds, or a Date. */
export type Instant = string | number | Date;

const dateOf = (at: Instant): Date => (at instanceof Date ? at : new Date(at));
const shaped = (at: Instant, where: Where, shape: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat(where.locale, { ...shape, timeZone: where.timeZone }).format(dateOf(at));

/** A number with the reader's grouping and decimal mark: "1,234,567", or "1.234.567" for a German reader. */
export const number = (n: number, where: Where = {}): string => new Intl.NumberFormat(where.locale).format(n);

/** The noun for a count: `one` for exactly 1, `many` for every other count, 0 included. */
export const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** A count with its noun: "1 task", "0 tasks", "12,345 tokens". */
export const counted = (count: number, one: string, many: string, where: Where = {}): string => `${number(count, where)} ${plural(count, one, many)}`;

/** A time of day: "14:30", or "2:30 PM" where the reader's locale uses a twelve-hour clock. */
export const clock = (at: Instant, where: Where = {}): string => shaped(at, where, { timeStyle: "short" });

/** A day and its clock, without the year: "24 November at 08:05"; with `weekday`, "Tuesday 24 November at 08:05". */
export const dayAndClock = (at: Instant, where: Where & { weekday?: boolean } = {}): string =>
  `${shaped(at, where, { ...(where.weekday === true ? { weekday: "long" } : {}), day: "numeric", month: "long" })} at ${clock(at, where)}`;

/** A date with its year and the clock to the second, as the reader's locale writes them: "24/11/2026, 08:05:09". */
export const fullDate = (at: Instant, where: Where = {}): string => shaped(at, where, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });

/** Whether two instants fall on the same calendar day where the reader is. */
export function sameDay(a: Instant, b: Instant, where: Where = {}): boolean {
  const day = (at: Instant): string => shaped(at, { locale: "en", timeZone: where.timeZone }, { year: "numeric", month: "numeric", day: "numeric" });
  return day(a) === day(b);
}

/**
 * How a duration is written:
 * - "short", the transcript's running and worked-for times: "42s", "2m 14s", "1h 3m";
 * - "units", a check's or a tool call's time, as the design system writes one: "380 ms", "2.4 s", "42 s", "4 min 12 s", "1 h 4 min";
 * - "words", a wait as a person says it, in one whole unit: "less than a minute", "12 minutes", "3 hours", "2 days".
 */
export type DurationStyle = "short" | "units" | "words";

/** A length of time in the style asked for, and as an ISO 8601 duration for a time element. A negative length is none. */
export function duration(ms: number, style: DurationStyle, where: Where = {}): { words: string; iso: string } {
  const length = Math.max(0, ms);
  if (style === "words") {
    const minutes = Math.floor(length / 60_000);
    if (minutes < 1) return { words: "less than a minute", iso: "PT0S" };
    if (minutes < 120) return { words: counted(minutes, "minute", "minutes", where), iso: `PT${minutes}M` };
    if (minutes < 48 * 60) return { words: counted(Math.floor(minutes / 60), "hour", "hours", where), iso: `PT${Math.floor(minutes / 60)}H` };
    return { words: counted(Math.floor(minutes / (24 * 60)), "day", "days", where), iso: `P${Math.floor(minutes / (24 * 60))}D` };
  }
  if (style === "units" && length < 1000) {
    const whole = Math.round(length);
    return { words: `${whole} ms`, iso: `PT${whole / 1000}S` };
  }
  if (style === "units" && length < 10_000) {
    const s = Math.round(length / 100) / 10;
    return { words: `${number(s, where)} s`, iso: `PT${s}S` };
  }
  const total = Math.round(length / 1000);
  const h = Math.floor(total / 3600);
  const min = Math.floor(total / 60) % 60;
  const s = total % 60;
  if (style === "short") {
    if (h > 0) return { words: `${h}h ${min}m`, iso: `PT${h}H${min}M` };
    return min > 0 ? { words: `${min}m ${s}s`, iso: `PT${min}M${s}S` } : { words: `${s}s`, iso: `PT${s}S` };
  }
  // Two parts at most, and a second part of nothing is left out.
  if (h > 0) return { words: min === 0 ? `${h} h` : `${h} h ${min} min`, iso: `PT${h}H${min === 0 ? "" : `${min}M`}` };
  if (min > 0) return { words: s === 0 ? `${min} min` : `${min} min ${s} s`, iso: `PT${min}M${s === 0 ? "" : `${s}S`}` };
  return { words: `${s} s`, iso: `PT${s}S` };
}

/** How long ago `since` was, counted from `now`: "less than a minute ago", "12 minutes ago", "3 hours ago", "2 days ago". */
export const ago = (since: Instant, now: number, where: Where = {}): string => `${duration(now - dateOf(since).getTime(), "words", where).words} ago`;
