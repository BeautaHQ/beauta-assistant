import type { DayHours, SalonDayHours } from "./types";

/**
 * Beauta's rules for hours and dates, checked the moment the agent proposes
 * something so it can correct itself or ask the owner. beauta-api checks the
 * same rules again when the owner confirms, and its answer is the one that
 * counts; these exist so the owner hears about a problem before confirming.
 */

export const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isTime = (value: string | null | undefined): value is string => typeof value === "string" && TIME.test(value);
export const isDate = (value: string | null | undefined): value is string =>
  typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Problems with a set of staff days on their own: day numbers, time format, start before end. */
export const staffDayProblems = (days: DayHours[], requireAllSeven: boolean) => {
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const day of days) {
    if (!Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 1 || day.dayOfWeek > 7) { problems.push(`dayOfWeek ${day.dayOfWeek} is not 1-7`); continue; }
    if (seen.has(day.dayOfWeek)) problems.push(`${WEEKDAYS[day.dayOfWeek]} is listed twice`);
    seen.add(day.dayOfWeek);
    if (day.isOff) continue;
    if (!isTime(day.startTime) || !isTime(day.endTime)) problems.push(`${WEEKDAYS[day.dayOfWeek]}: times must be HH:mm`);
    else if (day.startTime >= day.endTime) problems.push(`${WEEKDAYS[day.dayOfWeek]}: start must be before end`);
  }
  if (requireAllSeven && seen.size !== 7) problems.push("workingHours must contain all 7 days (1=Monday ... 7=Sunday), each once");
  return problems;
};

/** Working days that fall outside the salon's opening hours, or on a day it is closed. */
export const outsideSalonHours = (staffName: string, days: DayHours[], salon: SalonDayHours[]) => {
  const byDay = new Map(salon.map((item) => [item.dayOfWeek, item]));
  const problems: string[] = [];
  for (const day of days) {
    if (day.isOff) continue;
    const open = byDay.get(day.dayOfWeek);
    const weekday = WEEKDAYS[day.dayOfWeek] ?? `day ${day.dayOfWeek}`;
    if (!open || open.isClosed) problems.push(`${staffName} cannot work ${day.startTime}-${day.endTime} on ${weekday}: the salon is closed that day`);
    else if (day.startTime < open.openTime || day.endTime > open.closeTime) {
      problems.push(`${staffName} cannot work ${day.startTime}-${day.endTime} on ${weekday}: the salon is only open ${open.openTime}-${open.closeTime}`);
    }
  }
  return problems;
};

/** The staff member's week with some days replaced. */
export const withDays = (current: DayHours[], changes: DayHours[]) => {
  const changed = new Map(changes.map((day) => [day.dayOfWeek, day]));
  return current.map((day) => changed.get(day.dayOfWeek) ?? day);
};

/**
 * A week as lines with the weekday spelled out ("Wednesday 09:00-19:00",
 * "Tuesday off"). Handed back to the model so it never has to count from a
 * day number itself; mistranslating those numbers is how summaries went wrong.
 */
export const describeWeek = (days: DayHours[]) =>
  [...days].sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((day) => `${WEEKDAYS[day.dayOfWeek] ?? `day ${day.dayOfWeek}`} ${day.isOff ? "off" : `${day.startTime}-${day.endTime}`}`);

export const describeSalonWeek = (days: SalonDayHours[]) =>
  [...days].sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((day) => `${WEEKDAYS[day.dayOfWeek] ?? `day ${day.dayOfWeek}`} ${day.isClosed ? "closed" : `${day.openTime}-${day.closeTime}`}`);

/** "Saturday 2026-09-26 10:00" in the salon's own time. */
export const inSalonTime = (when: Date, timezone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(when).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

export const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
