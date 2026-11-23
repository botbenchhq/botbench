import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, clock, counted, dayAndClock, duration, englishOf, fullDate, number, plural, sameDay } from "../web/src/app/format.ts";

// The one place the screens format a number, a date, a clock, a duration and a counted noun (web/src/app/format.ts).
// Every instant here is fixed and every call names its reader's locale and time zone, so nothing depends on this machine.

const US = { locale: "en-US", timeZone: "UTC" };
const GB = { locale: "en-GB", timeZone: "UTC" };
const DE = { locale: "de-DE", timeZone: "UTC" };
const FR = { locale: "fr-FR", timeZone: "UTC" };
const EG = { locale: "ar-EG", timeZone: "UTC" };
const AT = "2026-11-24T08:05:09.000Z";
/** The no-break space Botbench itself writes before AM and PM and between a number's groups: one fixed character, whatever the engine's locale data has there. */
const NB = String.fromCharCode(0xa0);

test("the words are English wherever the reader is: only the region of their language is used", () => {
  assert.equal(englishOf("en-US"), "en-US");
  assert.equal(englishOf("de-DE"), "en-DE");
  // A language with no region named is read as where it is mostly spoken.
  assert.equal(englishOf("de"), "en-DE");
  assert.equal(englishOf("fr-FR"), "en-FR");
  assert.equal(englishOf("ar-EG"), "en-EG");
  // No tag, or text that is not one: plain English.
  assert.equal(englishOf(undefined), "en");
  assert.equal(englishOf("not a locale"), "en");
  // A French reader's day and month are in English, in the French order, with the French clock and grouping.
  assert.equal(dayAndClock(AT, { ...FR, weekday: true }), "Tuesday 24 November at 08:05");
  assert.equal(fullDate(AT, FR), "24/11/2026, 08:05:09");
  assert.equal(number(12345.5, FR), `12${NB}345,5`);
  assert.equal(counted(12345, "token", "tokens", FR), `12${NB}345 tokens`);
  // A reader in Egypt gets Latin digits and English words, with the twelve-hour clock used there.
  assert.equal(number(12345.5, EG), "12,345.5");
  assert.equal(clock("2026-11-24T14:30:00.000Z", EG), `2:30${NB}PM`);
  assert.equal(dayAndClock(AT, { ...EG, weekday: true }), `Tuesday, November 24 at 8:05${NB}AM`);
  assert.equal(fullDate(AT, EG), `11/24/2026, 8:05:09${NB}AM`);
  for (const where of [FR, EG, DE]) assert.match(`${fullDate(AT, where)} ${dayAndClock(AT, { ...where, weekday: true })} ${number(1234567.5, where)}`, /^[\x20-\x7e\u00a0\u202f]+$/, where.locale);
});

test("the server's form is a 24-hour clock and the day before the month whatever the reader's region, in the reader's time zone", () => {
  for (const where of [US, GB, DE, FR, EG]) {
    assert.equal(clock("2026-11-24T14:30:00.000Z", { ...where, serverForm: true }), "14:30", where.locale);
    assert.equal(clock(AT, { ...where, serverForm: true }), "08:05", where.locale);
    assert.equal(dayAndClock(AT, { ...where, serverForm: true, weekday: true }), "Tuesday 24 November at 08:05", where.locale);
  }
  assert.equal(clock(AT, { locale: "en-US", timeZone: "Asia/Tokyo", serverForm: true }), "17:05");
});

test("a number is grouped the way the reader's region groups it", () => {
  assert.equal(number(0, US), "0");
  assert.equal(number(999, US), "999");
  assert.equal(number(1234567, US), "1,234,567");
  assert.equal(number(1234567, GB), "1,234,567");
  assert.equal(number(1234567, DE), "1.234.567");
  assert.equal(number(2.5, DE), "2,5");
});

test("a noun takes its number from the count, and a counted noun carries the grouped count", () => {
  assert.equal(plural(0, "reply", "replies"), "replies");
  assert.equal(plural(1, "reply", "replies"), "reply");
  assert.equal(plural(2, "reply", "replies"), "replies");
  assert.equal(counted(0, "task", "tasks", US), "0 tasks");
  assert.equal(counted(1, "task", "tasks", US), "1 task");
  assert.equal(counted(2, "task", "tasks", US), "2 tasks");
  assert.equal(counted(12345, "token", "tokens", US), "12,345 tokens");
  // The words stay English; the digits are the reader's.
  assert.equal(counted(12345, "token", "tokens", DE), "12.345 tokens");
  assert.equal(counted(1, "token", "tokens", DE), "1 token");
});

test("a clock is the reader's own: twelve hours where they are used, twenty-four elsewhere, in the zone asked for", () => {
  assert.equal(clock(AT, US), `8:05${NB}AM`);
  assert.equal(clock(AT, GB), "08:05");
  assert.equal(clock(AT, DE), "08:05");
  assert.equal(clock("2026-11-24T14:30:00.000Z", GB), "14:30");
  assert.equal(clock("2026-11-24T14:30:00.000Z", US), `2:30${NB}PM`);
  assert.equal(clock("2026-11-24T00:05:00.000Z", GB), "00:05");
  // The same instant in another zone is another clock, and a Date or a number of milliseconds is read like the text.
  assert.equal(clock(AT, { locale: "en-GB", timeZone: "Asia/Tokyo" }), "17:05");
  assert.equal(clock(new Date(AT), GB), "08:05");
  assert.equal(clock(Date.parse(AT), GB), "08:05");
});

test("a day and clock names the day in the reader's order, with the weekday when asked, and no year", () => {
  assert.equal(dayAndClock(AT, GB), "24 November at 08:05");
  assert.equal(dayAndClock(AT, US), `November 24 at 8:05${NB}AM`);
  assert.equal(dayAndClock(AT, DE), "24 November at 08:05");
  assert.equal(dayAndClock(AT, { ...GB, weekday: true }), "Tuesday 24 November at 08:05");
  assert.equal(dayAndClock(AT, { ...US, weekday: true }), `Tuesday, November 24 at 8:05${NB}AM`);
  // Late in the evening in Honolulu it is still the day before.
  assert.equal(dayAndClock(AT, { locale: "en-GB", timeZone: "Pacific/Honolulu", weekday: true }), "Monday 23 November at 22:05");
});

test("a full date is the date with its year and the clock to the second, as the reader's locale writes them", () => {
  assert.equal(fullDate(AT, US), `11/24/2026, 8:05:09${NB}AM`);
  assert.equal(fullDate(AT, GB), "24/11/2026, 08:05:09");
  assert.equal(fullDate(AT, DE), "24/11/2026, 08:05:09");
  // For an English reader it is what the screens showed before this module: the browser's own default for a date and time.
  for (const where of [US, GB]) assert.equal(fullDate(AT, where).replace(/\s/gu, " "), new Date(AT).toLocaleString(where.locale, { timeZone: where.timeZone }).replace(/\s/gu, " "));
  assert.equal(fullDate(AT, { locale: "en-GB", timeZone: "Pacific/Auckland" }), "24/11/2026, 21:05:09");
});

test("two instants are the same day only in the zone they are read in", () => {
  assert.equal(sameDay("2026-11-24T01:00:00.000Z", "2026-11-24T23:00:00.000Z", GB), true);
  assert.equal(sameDay("2026-11-23T23:00:00.000Z", "2026-11-24T01:00:00.000Z", GB), false);
  assert.equal(sameDay("2026-11-23T23:00:00.000Z", "2026-11-24T01:00:00.000Z", { locale: "en-GB", timeZone: "Asia/Tokyo" }), true);
  assert.equal(sameDay("2026-11-24T08:00:00.000Z", "2027-11-24T08:00:00.000Z", GB), false);
});

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DAY = 24 * H;

test("a short duration is what the transcript shows: 42s, 2m 14s, 1h 3m", () => {
  const short = (ms: number): string => duration(ms, "short").words;
  assert.equal(short(0), "0s");
  assert.equal(short(4400), "4s");
  assert.equal(short(59 * S), "59s");
  assert.equal(short(60 * S), "1m 0s");
  assert.equal(short(2 * MIN + 14 * S), "2m 14s");
  assert.equal(short(59 * MIN + 59 * S), "59m 59s");
  assert.equal(short(H), "1h 0m");
  assert.equal(short(H + 3 * MIN + 10 * S), "1h 3m");
  // No screen shows a day in this style: hours go on counting.
  assert.equal(short(2 * DAY + H), "49h 0m");
  assert.deepEqual(duration(2 * MIN + 14 * S, "short"), { words: "2m 14s", iso: "PT2M14S" });
});

test("a duration with spelled units is what the checks show, with its ISO 8601 value for the time element", () => {
  const units = (ms: number) => duration(ms, "units", US);
  assert.deepEqual(units(0), { words: "0 ms", iso: "PT0S" });
  assert.deepEqual(units(38), { words: "38 ms", iso: "PT0.038S" });
  assert.deepEqual(units(999), { words: "999 ms", iso: "PT0.999S" });
  // Never "1000 ms": half a millisecond short of a second is a second.
  assert.deepEqual(units(999.4), { words: "999 ms", iso: "PT0.999S" });
  assert.deepEqual(units(999.5), { words: "1 s", iso: "PT1S" });
  assert.deepEqual(units(999.9), { words: "1 s", iso: "PT1S" });
  assert.deepEqual(units(1000), { words: "1 s", iso: "PT1S" });
  assert.deepEqual(units(2440), { words: "2.4 s", iso: "PT2.4S" });
  assert.deepEqual(units(9960), { words: "10 s", iso: "PT10S" });
  assert.deepEqual(units(42 * S), { words: "42 s", iso: "PT42S" });
  assert.deepEqual(units(59 * S), { words: "59 s", iso: "PT59S" });
  assert.deepEqual(units(60 * S), { words: "1 min", iso: "PT1M" });
  assert.deepEqual(units(4 * MIN + 12 * S), { words: "4 min 12 s", iso: "PT4M12S" });
  assert.deepEqual(units(59 * MIN + 59 * S), { words: "59 min 59 s", iso: "PT59M59S" });
  assert.deepEqual(units(H), { words: "1 h", iso: "PT1H" });
  assert.deepEqual(units(H + 4 * MIN + 30 * S), { words: "1 h 4 min", iso: "PT1H4M" });
  assert.deepEqual(units(2 * DAY + H), { words: "49 h", iso: "PT49H" });
  // The decimal mark is the reader's; the ISO value never changes with the locale.
  assert.deepEqual(duration(2440, "units", DE), { words: "2,4 s", iso: "PT2.4S" });
});

test("a duration in words is one whole unit, as a person says it", () => {
  const words = (ms: number): string => duration(ms, "words").words;
  assert.equal(words(-5), "less than a minute");
  assert.equal(words(0), "less than a minute");
  assert.equal(words(59 * S), "less than a minute");
  assert.equal(words(60 * S), "1 minute");
  assert.equal(words(12 * MIN + 40 * S), "12 minutes");
  assert.equal(words(59 * MIN + 59 * S), "59 minutes");
  assert.equal(words(H), "60 minutes");
  assert.equal(words(2 * H - 1), "119 minutes");
  assert.equal(words(2 * H), "2 hours");
  assert.equal(words(2 * DAY - 1), "47 hours");
  assert.equal(words(2 * DAY), "2 days");
  assert.equal(words(3 * DAY), "3 days");
  assert.deepEqual(duration(3 * DAY, "words"), { words: "3 days", iso: "P3D" });
  assert.deepEqual(duration(12 * MIN, "words"), { words: "12 minutes", iso: "PT12M" });
});

test("how long ago something was is its duration in words, counted from the time given", () => {
  const now = Date.parse("2026-11-23T12:00:00.000Z");
  assert.equal(ago("2026-11-23T11:59:30.000Z", now), "less than a minute ago");
  assert.equal(ago("2026-11-23T11:59:00.000Z", now), "1 minute ago");
  assert.equal(ago("2026-11-23T11:48:00.000Z", now), "12 minutes ago");
  assert.equal(ago("2026-11-23T09:00:00.000Z", now), "3 hours ago");
  assert.equal(ago("2026-11-21T12:00:00.000Z", now), "2 days ago");
  // A time still to come (two clocks that disagree) is never a negative wait.
  assert.equal(ago("2026-11-23T12:05:00.000Z", now), "less than a minute ago");
});

test("a date and a clock are joined from their parts with Botbench's own punctuation, the same whatever separators an engine's locale data has", () => {
  // The exact characters, for a reader in each of four regions: no comma after the weekday where the day is first, one
  // where the month is first, a colon in every clock, and one no-break space before AM or PM.
  const afternoon = "2026-11-24T14:05:09.000Z";
  const expected: Record<string, { clock: string; day: string; named: string; full: string; number: string }> = {
    "en-GB": { clock: "14:05", day: "24 November at 14:05", named: "Tuesday 24 November at 14:05", full: "24/11/2026, 14:05:09", number: "12,345.5" },
    "en-US": { clock: `2:05${NB}PM`, day: `November 24 at 2:05${NB}PM`, named: `Tuesday, November 24 at 2:05${NB}PM`, full: `11/24/2026, 2:05:09${NB}PM`, number: "12,345.5" },
    "de-DE": { clock: "14:05", day: "24 November at 14:05", named: "Tuesday 24 November at 14:05", full: "24/11/2026, 14:05:09", number: "12.345,5" },
    "fr-FR": { clock: "14:05", day: "24 November at 14:05", named: "Tuesday 24 November at 14:05", full: "24/11/2026, 14:05:09", number: `12${NB}345,5` },
  };
  for (const [locale, want] of Object.entries(expected)) {
    const where = { locale, timeZone: "UTC" };
    assert.deepEqual({ clock: clock(afternoon, where), day: dayAndClock(afternoon, where), named: dayAndClock(afternoon, { ...where, weekday: true }), full: fullDate(afternoon, where), number: number(12345.5, where) }, want, locale);
  }
  // Nothing but these characters between the parts: no narrow no-break space, no comma the region's order does not call for.
  for (const locale of Object.keys(expected)) {
    const where = { locale, timeZone: "UTC" };
    assert.doesNotMatch(`${clock(afternoon, where)} ${fullDate(afternoon, where)} ${number(1234567.5, where)}`, /[\u202f\u2009]/u, locale);
    assert.equal(dayAndClock(afternoon, { ...where, weekday: true }).split(",").length - 1, locale === "en-US" ? 1 : 0, locale);
  }
});
