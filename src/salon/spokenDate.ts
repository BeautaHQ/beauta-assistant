/**
 * The day a customer named, worked out in code.
 *
 * Left to the model, "Friday" came back as "which Friday?", and "9/10/26" as a
 * choice between the 9th and the 16th. A day named without a date is the next
 * one from today, and a date written in numbers is day first, the way it is in
 * Australia and New Zealand. None of that is a judgement call, so it is not
 * left to one.
 *
 * Returns YYYY-MM-DD in the salon's own calendar, or null when the message
 * names no day. English and Vietnamese.
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

// Word edges that also work for Vietnamese letters: JavaScript's \b only
// knows ASCII, so "thứ tư" at the end of a message never matched it.
const L = "(?<![\\p{L}\\d])";
const R = "(?![\\p{L}\\d])";
const word = (alternatives: string) => new RegExp(`${L}(?:${alternatives})${R}`, "u");

/** 1 = Monday ... 7 = Sunday. */
const WEEKDAY_WORDS: [RegExp, number][] = [
  [word("monday|mon|thứ\\s*(?:2|hai)|t2"), 1],
  [word("tuesday|tues|tue|thứ\\s*(?:3|ba)|t3"), 2],
  [word("wednesday|wed|thứ\\s*(?:4|tư|bốn)|t4"), 3],
  [word("thursday|thurs|thur|thu|thứ\\s*(?:5|năm)|t5"), 4],
  [word("friday|fri|thứ\\s*(?:6|sáu)|t6"), 5],
  [word("saturday|sat|thứ\\s*(?:7|bảy|bẩy)|t7"), 6],
  [word("sunday|sun|chủ\\s*nhật|cn"), 7],
];

const pad = (value: number) => String(value).padStart(2, "0");
const iso = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/** A real calendar date, or null (31 February, 0 October...). */
const valid = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? iso(year, month, day) : null;
};

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** Today in the salon's timezone, as YYYY-MM-DD. */
export const salonToday = (timezone: string, now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/**
 * A date without a year is this year's, unless it has already gone, then next
 * year's: on 20 December, "5/1" is next January.
 */
const withYear = (today: string, month: number, day: number, year?: number) => {
  if (year !== undefined) return valid(year < 100 ? 2000 + year : year, month, day);
  const thisYear = Number(today.slice(0, 4));
  const candidate = valid(thisYear, month, day);
  if (candidate && candidate >= today) return candidate;
  return valid(thisYear + 1, month, day);
};

export const resolveSpokenDate = (message: string, timezone: string, now = new Date()): string | null => {
  const text = message.toLocaleLowerCase("vi").replace(/\s+/g, " ");
  const today = salonToday(timezone, now);

  // Numbers first: "9/10/26", "9-10", "9.10" are day/month(/year).
  // Not a clock time: "9.10am", "10.30pm", "9.10 giờ" are times.
  const numeric = /(?<![\d:])(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?(?![\d:])(?!\s?(?:am|pm|h\b|giờ))/.exec(text);
  if (numeric) {
    const date = withYear(today, Number(numeric[2]), Number(numeric[1]), numeric[3] ? Number(numeric[3]) : undefined);
    if (date) return date;
  }

  // "9 October", "9th of Oct", "October 9", "9 tháng 10", "ngày 9/10" (caught above).
  const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${monthNames})\\b`).exec(text);
  if (dayMonth) {
    const date = withYear(today, MONTHS[dayMonth[2]!]!, Number(dayMonth[1]));
    if (date) return date;
  }
  const monthDay = new RegExp(`\\b(${monthNames}) (\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(text);
  if (monthDay) {
    const date = withYear(today, MONTHS[monthDay[1]!]!, Number(monthDay[2]));
    if (date) return date;
  }
  const vietnameseMonth = /(?:ngày )?(\d{1,2}) tháng (\d{1,2})(?!\d)/.exec(text);
  if (vietnameseMonth) {
    const date = withYear(today, Number(vietnameseMonth[2]), Number(vietnameseMonth[1]));
    if (date) return date;
  }

  // Relative days.
  if (word("day after tomorrow|ngày mốt|mốt").test(text)) return addDays(today, 2);
  if (word("tomorrow|tmr|tmrw|tomoz|ngày mai|mai").test(text)) return addDays(today, 1);
  if (word("today|tonight|this afternoon|this morning|this evening|hôm nay|tối nay|chiều nay|sáng nay").test(text)) return today;

  // A weekday: the coming one (today if it is that day); "next Friday",
  // "Friday next week", "thứ 6 tuần sau" the one after it.
  for (const [pattern, weekday] of WEEKDAY_WORDS) {
    if (!pattern.test(text)) continue;
    const ahead = (weekday - weekdayOf(today) + 7) % 7;
    const next = word("next|tuần sau|tuần tới").test(text);
    return addDays(today, ahead + (next ? 7 : 0));
  }

  // "the 9th", "ngày 9" on its own: that day this month, or next month once it has passed.
  const dayOnly = /\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b|ngày (\d{1,2})(?![\d/.-])/.exec(text);
  if (dayOnly) {
    const day = Number(dayOnly[1] ?? dayOnly[2]);
    const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const thisMonth = valid(year, month, day);
    if (thisMonth && thisMonth >= today) return thisMonth;
    return month === 12 ? valid(year + 1, 1, day) : valid(year, month + 1, day);
  }

  return null;
};

/**
 * A clock time the customer named, as HH:mm, or null.
 *
 * Only an exact time: "10am", "2:30pm", "14:00", "3h chiều", "10 giờ sáng".
 * "after 5pm" or "trước 3h" is a part of the day, not a time, and is left to
 * the model, which treats it as a window.
 */
export const resolveSpokenTime = (message: string): string | null => {
  const text = message.toLocaleLowerCase("vi");
  const match =
    /(?<![\d/.:])(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?![\p{L}])/u.exec(text) ??
    /(?<![\d/.:])(\d{1,2}):(\d{2})(?![\d/.:])()/.exec(text) ??
    /(?<![\d/.:])(\d{1,2})\s*(?:h|giờ)\s*(\d{2})?\s*(sáng|trưa|chiều|tối)?(?![\p{L}\d])/u.exec(text);
  if (!match) return null;
  const before = text.slice(Math.max(0, match.index - 12), match.index);
  if (/(after|before|from|between|until|sau|trước|từ|đến)\s*$/u.test(before)) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const half = match[3];
  if (half === "pm" || half === "chiều" || half === "tối") { if (hour < 12) hour += 12; }
  else if (half === "am" && hour === 12) hour = 0;
  else if (half === "trưa" && hour < 11) hour += 12;
  else if (!half && hour >= 1 && hour <= 7 && /\d\s*(?:h|giờ)/u.test(match[0])) hour += 12; // "3h" at a salon is the afternoon
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

/** "3", "4.20", "3:30pm", "3h chiều" as HH:mm; bare 1–7 o'clock is the afternoon at a salon. */
const clockOf = (hourText: string, minuteText: string | undefined, meridiem: string | undefined, fallback?: string) => {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  const half = meridiem ?? fallback;
  if (half === "pm" || half === "chiều" || half === "tối") { if (hour < 12) hour += 12; }
  else if (half === "am" || half === "sáng") { if (hour === 12) hour = 0; }
  else if (hour >= 1 && hour <= 7) hour += 12;
  return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : null;
};

const T = String.raw`(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?\s*(?:h|giờ)?\s*(sáng|chiều|tối)?`;

/**
 * The part of the day they want, for a waitlist or for finding a time:
 * "between 3 and 4.20", "3-4pm", "từ 3h đến 4h chiều", "after 5pm",
 * "before 2". null when the message names no window. Open ends are null:
 * "after 5pm" is { from: "17:00", to: null }.
 */
export const resolveSpokenWindow = (message: string): { from: string | null; to: string | null } | null => {
  const text = message.toLocaleLowerCase("vi");
  const range = new RegExp(String.raw`(?:between|from|từ)?\s*${T}\s*(?:-|–|and|to|till|until|đến|tới)\s*${T}`, "u").exec(text);
  // A bare "9-10" is as likely a date as a window, so a dash alone needs a clock word (pm, h, giờ...).
  const worded = range && /between|from|từ|and|to|till|until|đến|tới/u.test(range[0]);
  const clocked = range && /am|pm|h|giờ|sáng|chiều|tối|[:.]\d{2}/u.test(range[0]);
  if (range && (worded || clocked)) {
    const to = clockOf(range[5]!, range[6], range[7], range[8]);
    const from = clockOf(range[1]!, range[2], range[3], range[4]);
    if (from && to && from < to) return { from, to };
  }
  const after = new RegExp(String.raw`(?:after|from|sau|từ)\s*${T}`, "u").exec(text);
  if (after) { const from = clockOf(after[1]!, after[2], after[3], after[4]); if (from) return { from, to: null }; }
  const before = new RegExp(String.raw`(?:before|trước)\s*${T}`, "u").exec(text);
  if (before) { const to = clockOf(before[1]!, before[2], before[3], before[4]); if (to) return { from: null, to }; }
  return null;
};
