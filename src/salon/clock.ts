/**
 * Today and tomorrow, in the salon's own clock.
 *
 * Both are handed over rather than only today. Asked to work "tomorrow" out for
 * itself the model took it as the day after whatever date was last mentioned,
 * so a caller who said "put me on the waitlist for tomorrow" during a
 * conversation about Wednesday was waitlisted for Thursday. Tomorrow is
 * tomorrow, counted from today, and now it never has to do the sum.
 */
export const salonDates = (timezone: string) => {
  const format = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);

  const weekday = (date: Date) =>
    new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "long" }).format(
      date,
    );

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  return {
    today: format(now),
    todayName: weekday(now),
    tomorrow: format(tomorrow),
    tomorrowName: weekday(tomorrow),
  };
};
