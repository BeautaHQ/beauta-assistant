import { isDate, WEEKDAYS } from "../../rules";
import { refuse, tool, type Tool } from "../../toolkit";

const MAX_DAYS = 92;
const TOP = 10;

const weekdayOf = (date: string) => WEEKDAYS[((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1];
const money = (value: number) => Math.round(value * 100) / 100;

/** The salon's bookings between two dates, added up every way an owner asks about them. */
export const analyticsTools: Tool[] = [
  tool(
    "get_booking_stats",
    "Bookings between startDate and endDate (YYYY-MM-DD, inclusive, at most 92 days): counts by status, revenue from completed bookings, per day, per staff member, most-booked services, and new customers. Legacy imports excluded.",
    { startDate: { type: "string" }, endDate: { type: "string" } },
    async (args, context) => {
      const item = args as { startDate: string; endDate: string };
      if (!isDate(item.startDate) || !isDate(item.endDate) || item.startDate > item.endDate) {
        return refuse("startDate and endDate must be YYYY-MM-DD, start no later than end");
      }
      if (Date.parse(item.endDate) - Date.parse(item.startDate) > MAX_DAYS * 86_400_000) return refuse(`at most ${MAX_DAYS} days at a time`);

      const [rows, newCustomers, currency] = await Promise.all([
        context.data.bookingsBetween(item.startDate, item.endDate, context.input.timezone),
        context.data.newCustomersBetween(item.startDate, item.endDate),
        context.data.currency(),
      ]);

      const empty = () => ({ scheduled: 0, completed: 0, cancelled: 0, noShow: 0, revenue: 0 });
      const totals = { ...empty(), bookedValue: 0, paidOnline: 0, people: 0 };
      const byDay = new Map<string, ReturnType<typeof empty>>();
      const byStaff = new Map<string, { completed: number; scheduled: number; revenue: number }>();
      const services = new Map<string, number>();

      const count = (bucket: ReturnType<typeof empty>, status: string, revenue: number) => {
        if (status === "COMPLETED") { bucket.completed += 1; bucket.revenue = money(bucket.revenue + revenue); }
        else if (status === "CANCELED") bucket.cancelled += 1;
        else if (status === "NO_SHOW") bucket.noShow += 1;
        else bucket.scheduled += 1;
      };

      for (const row of rows) {
        const revenue = row.status === "COMPLETED" ? row.finalPrice : 0;
        count(totals, row.status, revenue);
        totals.people += row.quantity;
        if (row.status === "SCHEDULED") totals.bookedValue = money(totals.bookedValue + row.finalPrice);
        if (row.status === "COMPLETED" && row.bookingPaymentType === "ONLINE") totals.paidOnline = money(totals.paidOnline + (row.amountPaid ?? row.finalPrice));

        if (!byDay.has(row.day)) byDay.set(row.day, empty());
        count(byDay.get(row.day)!, row.status, revenue);

        const staffNames = [...new Set(row.bookingTasks.map((task) => task.staff.name))];
        for (const name of staffNames) {
          if (!byStaff.has(name)) byStaff.set(name, { completed: 0, scheduled: 0, revenue: 0 });
          const bucket = byStaff.get(name)!;
          if (row.status === "COMPLETED") { bucket.completed += 1; bucket.revenue = money(bucket.revenue + revenue / staffNames.length); }
          else if (row.status === "SCHEDULED") bucket.scheduled += 1;
        }

        if (row.status !== "CANCELED") {
          for (const name of new Set(row.bookingTasks.map((task) => task.service?.name).filter((name): name is string => Boolean(name)))) {
            services.set(name, (services.get(name) ?? 0) + 1);
          }
        }
      }

      return {
        range: { startDate: item.startDate, endDate: item.endDate, days: Math.round((Date.parse(item.endDate) - Date.parse(item.startDate)) / 86_400_000) + 1 },
        currency,
        bookings: { total: rows.length, scheduled: totals.scheduled, completed: totals.completed, cancelled: totals.cancelled, noShow: totals.noShow, people: totals.people },
        revenue: totals.revenue,
        paidOnline: totals.paidOnline,
        bookedValue: totals.bookedValue,
        newCustomers,
        byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, bucket]) => ({ date, weekday: weekdayOf(date), ...bucket })),
        byStaff: [...byStaff.entries()].map(([name, bucket]) => ({ name, ...bucket, revenue: money(bucket.revenue) })).sort((a, b) => b.completed - a.completed || b.scheduled - a.scheduled),
        topServices: [...services.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([name, bookings]) => ({ name, bookings })),
      };
    },
  ),
];
