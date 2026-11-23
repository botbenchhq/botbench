/*
 * How the screens write a number, a date, a clock, a duration and a counted noun: the one owner of each rule. Pure, so
 * the tests read it without a browser (test/format.test.ts).
 *
 * The interface's words are English and stay English, a day's and a month's name and the digits included. The
 * grouping of a number, the order of a date and the kind of clock are those of the reader's region: every function
 * formats in English as it is written where the browser's language is from ("fr-FR" reads as "en-FR": "Tuesday 24
 * November", "14:30", "12 345,5"), in the browser's time zone, unless it is given others, which only the tests do.
 *
 * One form does not follow the region. The server writes a clock into some of its sentences in a fixed form
 * ("Botbench restarted at 14:02", "on Monday 23 November at 14:02": src/engine/task.ts `clockWords`), and a sentence of
 * the client's shown beside one must not disagree with it. `serverForm` gives that form (a 24-hour clock, the day before
 * the month), still in the reader's time zone. It is used by the sentence of a task waiting for a usage limit
 * (components/task-status.ts `waitingWords`), on the task and on its run's row, and by nothing else.
 *
 * What is deliberately not here:
 * - a choice between two sentences that say different things, not a noun's number: "It waited … for you." or "They
 *   waited … in the middle, … at most." (app/paired-words.ts), "Claude Code only" or a list (app/handoff-words.ts
 *   `orderWords`), characters for a one-line command and lines for a longer one (screens/task.tsx), a list of one
 *   item or of several joined with "and", and "once" for a count of 1 (components/approval-card.tsx `times`);
 * - `noteTooLong` (app/run-source.ts), which repeats the server's own sentence, digit for digit, so that the composer
 *   and the server refuse a note in the same words;
 * - `limitName` (app/composer.ts), an approval time limit named by its largest whole unit ("1 hour", "1 day"), which
 *   `duration(…, "words")` does not say ("60 minutes", "24 hours").
 */

/**
 * Whose conventions to format with. Left out, the browser's own: `locale` is a reader's language tag ("de-DE"), of
 * which only the region is used, and `timeZone` an IANA zone.
 */
export interface Where {
  locale?: string | undefined;
  timeZone?: string | undefined;
}

/** A clock or a day in the form the server writes them, whatever the reader's region: "14:02", "Monday 23 November". */
export type Clocked = Where & { serverForm?: boolean };

/** The form of the server's own clock sentences: English with a 24-hour clock and the day before the month. */
const SERVER_FORM = "en-GB";

/** English as it is written in the region of a language tag: "de-DE" and "de" give "en-DE", "en-US" itself; "en" when the tag names no region or is not one. */
export function englishOf(tag: string | undefined): string {
  try {
    const region = tag === undefined ? undefined : new Intl.Locale(tag).maximize().region;
    return region === undefined ? "en" : `en-${region}`;
  } catch {
    return "en";
  }
}

/** The locale to format with: English, in the region of the locale given or of the browser's language. */
const localeOf = (where: Clocked): string => (where.serverForm === true ? SERVER_FORM : englishOf(where.locale ?? (typeof navigator === "undefined" ? undefined : navigator.language)));

/** An instant as the screens hold one: the stored ISO text, milliseconds, or a Date. */
export type Instant = string | number | Date;

const dateOf = (at: Instant): Date => (at instanceof Date ? at : new Date(at));

/*
 * A date or a clock is put together here from its parts (`formatToParts`), never taken as the engine's finished text:
 * the commas and spaces an engine puts between the parts differ from one version of its locale data to the next
 * ("Tuesday 24 November" in one, "Tuesday, 24 November" in another; a plain or a narrow no-break space before "PM"),
 * and a sentence of Botbench's must read the same in every browser. From the engine come only what a region decides:
 * the names, the digits and their padding, twelve or twenty-four hours, and which of the day and the month is first.
 * Two things are still the engine's text, as a region's own convention: the marks inside a numeric date ("24/11/2026",
 * "11/24/2026") and the grouping and decimal marks of a number, of which only a space is made one fixed character.
 */

/** The space Botbench writes where a line must not break: before AM or PM, and between a number's groups where a region groups with a space. */
const NO_BREAK = "\u00a0";

/** The parts of an instant in a shape, without the engine's own separators. */
const partsOf = (at: Instant, where: Clocked, shape: Intl.DateTimeFormatOptions): Intl.DateTimeFormatPart[] =>
  new Intl.DateTimeFormat(localeOf(where), { ...shape, timeZone: where.timeZone }).formatToParts(dateOf(at)).filter((part) => part.type !== "literal");

/** A clock from its parts: "14:30", "2:30 PM", and with `seconds` "14:30:09". */
function clockOf(at: Instant, where: Clocked, seconds: boolean): string {
  const parts = partsOf(at, where, { timeStyle: seconds ? "medium" : "short" });
  const of = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((part) => part.type === type)?.value;
  const digits = [of("hour"), of("minute"), ...(seconds ? [of("second")] : [])].join(":");
  const half = of("dayPeriod");
  return half === undefined ? digits : `${digits}${NO_BREAK}${half}`;
}

/** A day from its parts, in the order the region gives them: "24 November", "Tuesday 24 November"; where the month is first, "November 24", "Tuesday, November 24". */
function dayOf(at: Instant, where: Clocked, weekday: boolean): string {
  const parts = partsOf(at, where, { ...(weekday ? { weekday: "long" as const } : {}), day: "numeric", month: "long" });
  const named = parts.find((part) => part.type === "weekday")?.value;
  const date = parts.filter((part) => part.type === "day" || part.type === "month");
  const words = date.map((part) => part.value).join(" ");
  if (named === undefined) return words;
  return date[0]?.type === "month" ? `${named}, ${words}` : `${named} ${words}`;
}

/** A number with the grouping and decimal mark of the reader's region: "1,234,567", or "1.234.567" for a reader in Germany. */
export const number = (n: number, where: Where = {}): string => new Intl.NumberFormat(localeOf(where)).format(n).replace(/\s/gu, NO_BREAK);

/** The noun for a count: `one` for exactly 1, `many` for every other count, 0 included. */
export const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** A count with its noun: "1 task", "0 tasks", "12,345 tokens". */
export const counted = (count: number, one: string, many: string, where: Where = {}): string => `${number(count, where)} ${plural(count, one, many)}`;

/** A time of day: "14:30", or "2:30 PM" where the reader's region uses a twelve-hour clock; always "14:30" in the server's form. */
export const clock = (at: Instant, where: Clocked = {}): string => clockOf(at, where, false);

/** A day and its clock, without the year: "24 November at 08:05"; with `weekday`, "Tuesday 24 November at 08:05". */
export const dayAndClock = (at: Instant, where: Clocked & { weekday?: boolean } = {}): string => `${dayOf(at, where, where.weekday === true)} at ${clock(at, where)}`;

/** A date with its year and the clock to the second, as the reader's region writes them: "24/11/2026, 08:05:09". */
export const fullDate = (at: Instant, where: Where = {}): string =>
  `${new Intl.DateTimeFormat(localeOf(where), { year: "numeric", month: "numeric", day: "numeric", timeZone: where.timeZone }).format(dateOf(at))}, ${clockOf(at, where, true)}`;

/** Whether two instants fall on the same calendar day where the reader is. */
export function sameDay(a: Instant, b: Instant, where: Where = {}): boolean {
  const day = (at: Instant): string => partsOf(at, { locale: "en", timeZone: where.timeZone }, { year: "numeric", month: "numeric", day: "numeric" }).map((part) => part.value).join("-");
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
  // Whole milliseconds under a second; 999.5 ms and more is a second, never "1000 ms".
  const whole = Math.round(length);
  if (style === "units" && whole < 1000) return { words: `${whole} ms`, iso: `PT${whole / 1000}S` };
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
