import { availableTimes, isTimeAvailable, staffAvailableTimes } from "../../availability";
import { toE164 } from "../../phone";
import { WEEKDAYS, inSalonTime, isDate, isTime } from "../../rules";
import type { CreateBookingAction, OwnerAction } from "../../types";
import { refuse, tool, type Tool, type ToolContext } from "../../toolkit";

const int = { type: "integer" };

const accept = ({ batch }: ToolContext, action: OwnerAction, extra: Record<string, unknown> = {}) => {
  batch.proposals.push(action);
  return { ok: true, proposed: action, ...extra };
};
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (date: string) => WEEKDAYS[((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1];
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** "09:00-11:30, 14:00-16:50": runs of consecutive 10-minute start times. */
const asRanges = (slots: string[]) => {
  const ranges: string[] = [];
  let start: string | null = null;
  let previous: string | null = null;
  for (const slot of [...slots].sort()) {
    if (start && previous && minutes(slot) - minutes(previous) === 10) { previous = slot; continue; }
    if (start && previous) ranges.push(start === previous ? start : `${start}-${previous}`);
    start = slot; previous = slot;
  }
  if (start && previous) ranges.push(start === previous ? start : `${start}-${previous}`);
  return ranges;
};

type Request = { serviceId: number; addonIds: number[]; staffId: number | null; people: number };

/** Check the service, addons and staff belong to this salon and fit together, before asking the engine. */
const checkRequest = async ({ data }: ToolContext, item: Request) => {
  const problems: string[] = [];
  const service = (await data.services()).find((row) => row.id === item.serviceId);
  if (!service) return { problems: [`no service with id ${item.serviceId}; call list_services`] };
  const addons = await data.addons();
  for (const addonId of item.addonIds) {
    const addon = addons.find((row) => row.id === addonId);
    if (!addon) problems.push(`no addon with id ${addonId}`);
    else if (!addon.serviceIds.includes(service.id)) problems.push(`addon ${addon.name} is not offered with ${service.name}`);
  }
  if (!Number.isInteger(item.people) || item.people < 1 || item.people > 10) problems.push("people must be 1-10");
  let staffName: string | null = null;
  if (item.staffId !== null) {
    const staff = (await data.staff()).find((row) => row.id === item.staffId);
    if (!staff) problems.push(`no staff member with id ${item.staffId}; call list_staff`);
    else if (!staff.serviceIds.includes(service.id)) problems.push(`${staff.name} does not do ${service.name}, so they can never be booked for it`);
    else staffName = staff.name;
    if (item.people > 1) problems.push("a named staff member serves one customer at a time; use people=1, or no staff for a group");
  }
  return { problems, service, staffName };
};

const lookup = (context: ToolContext, item: Request, date: string) => (item.staffId !== null
  ? staffAvailableTimes(context.input.organizationId, { serviceId: item.serviceId, staffId: item.staffId, date })
  : availableTimes(context.input.organizationId, { serviceId: item.serviceId, addonIds: item.addonIds, date, people: item.people }));

const request = {
  serviceId: int, addonIds: { type: "array", items: int }, staffId: { type: ["integer", "null"], description: "null for any staff" },
  people: { type: "integer", description: "customers coming together; usually 1" },
};

export const calendarTools: Tool[] = [
  tool("find_available_times", "Free start times for a service (with addons) from startDate to endDate (YYYY-MM-DD, at most 7 days), for any staff or one staff member. fromTime/toTime (HH:mm, or null) keep only start times in that part of the day.", {
    ...request, startDate: { type: "string" }, endDate: { type: "string" }, fromTime: { type: ["string", "null"] }, toTime: { type: ["string", "null"] },
  }, async (args, context) => {
    const item = args as Request & { startDate: string; endDate: string; fromTime: string | null; toTime: string | null };
    const checked = await checkRequest(context, item);
    if (!isDate(item.startDate) || !isDate(item.endDate) || item.endDate < item.startDate) checked.problems.push("dates must be YYYY-MM-DD, end on or after start");
    else if (item.endDate > addDays(item.startDate, 6)) checked.problems.push("at most 7 days at a time");
    if ((item.fromTime !== null && !isTime(item.fromTime)) || (item.toTime !== null && !isTime(item.toTime))) checked.problems.push("fromTime and toTime must be HH:mm or null");
    if (checked.problems.length) return refuse(...checked.problems);
    // Past days have nothing to book; they are skipped rather than reported as "none".
    const today = context.input.today;
    const dates: string[] = [];
    for (let date = item.startDate > today ? item.startDate : today; date <= item.endDate; date = addDays(date, 1)) dates.push(date);
    if (!dates.length) return refuse(`those dates are in the past (today is ${weekdayOf(today)} ${today})`);
    const inWindow = (slot: string) => (item.fromTime === null || slot >= item.fromTime) && (item.toTime === null || slot <= item.toTime);
    const days = await Promise.all(dates.map(async (date) => {
      const slots = (await lookup(context, item, date)).filter(inWindow);
      return { date, weekday: weekdayOf(date), startTimes: slots.length ? asRanges(slots) : "none" };
    }));
    return {
      service: checked.service?.name, durationMinutes: checked.service?.durationMinutes, staff: checked.staffName ?? "any staff", people: item.people,
      window: item.fromTime || item.toTime ? `${item.fromTime ?? "open"}-${item.toTime ?? "close"}` : "whole day", days,
      ...(item.startDate < today ? { skipped: `days before today (${today}) are past` } : {}),
      ...(item.staffId !== null && item.addonIds.length ? { note: "For one staff member the times do not include addon time; confirm a time with check_time_available." } : {}),
    };
  }),

  tool("check_time_available", "Whether one start time (date YYYY-MM-DD, time HH:mm) is free for a service with addons, for any staff or one staff member. If not, gives the nearest free times that day.", {
    ...request, date: { type: "string" }, time: { type: "string" },
  }, async (args, context) => {
    const item = args as Request & { date: string; time: string };
    const checked = await checkRequest(context, item);
    if (!isDate(item.date)) checked.problems.push("date must be YYYY-MM-DD");
    if (!isTime(item.time)) checked.problems.push("time must be HH:mm");
    if (checked.problems.length) return refuse(...checked.problems);
    const slots = await lookup(context, item, item.date);
    const available = item.staffId === null && item.addonIds.length
      ? await isTimeAvailable(context.input.organizationId, { serviceId: item.serviceId, addonIds: item.addonIds, date: item.date, time: item.time, people: item.people })
      : slots.includes(item.time);
    const nearest = available ? [] : [...slots].sort((a, b) => Math.abs(minutes(a) - minutes(item.time)) - Math.abs(minutes(b) - minutes(item.time))).slice(0, 4).sort();
    return {
      service: checked.service?.name, staff: checked.staffName ?? "any staff", date: `${weekdayOf(item.date)} ${item.date}`, time: item.time, available,
      ...(!available && minutes(item.time) % 10 !== 0 ? { reason: "start times are on the 10-minute mark; this time is not taken, it is just not a start time" } : {}),
      ...(available ? {} : { nearestFreeTimes: nearest.length ? nearest : "nothing free that day" }),
    };
  }),
];

const addMinutes = (time: string, add: number) => {
  const total = minutes(time) + add;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export const bookingTools: Tool[] = [
  tool("propose_create_booking", "Propose a booking for a customer identified by phone. firstName/lastName are only used for a new customer (null otherwise). staffId null = any free staff. date YYYY-MM-DD, time HH:mm.", {
    phone: { type: "string" }, firstName: { type: ["string", "null"] }, lastName: { type: ["string", "null"] }, email: { type: ["string", "null"] },
    ...request, date: { type: "string" }, time: { type: "string" }, notes: { type: ["string", "null"] },
    reminder: { type: "boolean", description: "true only when the owner asked for a reminder to be sent; otherwise false" },
  }, async (args, context) => {
    const item = args as Request & { phone: string; firstName: string | null; lastName: string | null; email: string | null; date: string; time: string; notes: string | null; reminder: boolean };
    const phone = toE164(item.phone, context.input.timezone);
    if (!phone) return refuse(`${item.phone} is not a valid phone number; ask the owner to check it`);
    const checked = await checkRequest(context, item);
    if (!isDate(item.date)) checked.problems.push("date must be YYYY-MM-DD");
    else if (item.date < context.input.today) checked.problems.push(`${item.date} is in the past (today is ${context.input.today})`);
    if (!isTime(item.time)) checked.problems.push("time must be HH:mm");
    const customer = await context.data.customerByPhone(phone);
    if (!customer && !item.firstName?.trim()) checked.problems.push(`no customer with ${phone} yet: ask the owner for the new customer's first name`);
    if (context.batch.pending("CREATE_BOOKING").some((row) => row.phone === phone && row.date === item.date && row.time === item.time)) checked.problems.push("this booking is already proposed");
    if (checked.problems.length) return refuse(...checked.problems);

    // Is the time really free? The same engine the booking page uses.
    const slots = await lookup(context, item, item.date);
    const available = item.staffId === null && item.addonIds.length
      ? await isTimeAvailable(context.input.organizationId, { serviceId: item.serviceId, addonIds: item.addonIds, date: item.date, time: item.time, people: item.people })
      : slots.includes(item.time);
    if (!available) {
      const nearest = [...slots].sort((a, b) => Math.abs(minutes(a) - minutes(item.time)) - Math.abs(minutes(b) - minutes(item.time))).slice(0, 4).sort();
      return refuse(minutes(item.time) % 10 !== 0
        ? `${item.time} is not a start time: bookings start on the 10-minute mark`
        : `${item.time} on ${weekdayOf(item.date)} ${item.date} is not free for ${checked.staffName ?? "any staff"}`,
        nearest.length ? `nearest free start times that day: ${nearest.join(", ")}` : "nothing is free that day");
    }

    const service = checked.service!;
    const addons = (await context.data.addons()).filter((row) => item.addonIds.includes(row.id));
    const durationMinutes = service.durationMinutes + addons.reduce((sum, row) => sum + row.durationMinutes, 0);
    const price = (service.price + addons.reduce((sum, row) => sum + row.price, 0)) * item.people;
    const action: CreateBookingAction = {
      type: "CREATE_BOOKING", phone,
      firstName: customer?.firstName ?? item.firstName!.trim(), lastName: customer?.lastName ?? item.lastName?.trim() ?? "",
      email: customer?.email ?? (item.email?.trim() || null), isNewCustomer: !customer,
      serviceId: service.id, serviceName: service.name, addonIds: addons.map((row) => row.id), addonNames: addons.map((row) => row.name),
      staffId: item.staffId, staffName: checked.staffName ?? null,
      date: item.date, time: item.time, endTime: addMinutes(item.time, durationMinutes), people: item.people,
      durationMinutes, price, currency: await context.data.currency(), notes: item.notes?.trim() || null, reminderEnabled: item.reminder === true,
    };
    context.batch.proposals.push(action);
    return {
      ok: true, when: `${weekdayOf(item.date)} ${item.date} ${item.time}-${action.endTime}`,
      customer: customer ? `existing customer ${customer.firstName} ${customer.lastName}` : "new customer, created on confirm",
      ...(customer?.isBlocked ? { warning: "This customer is blocked from booking online. Tell the owner." } : {}),
    };
  }),
];

/** Endpoint-free checks every change to an existing booking needs first. */
const existingBooking = async (context: ToolContext, bookingId: number) => {
  const booking = await context.data.booking(bookingId);
  if (!booking) return { problem: `no booking with id ${bookingId} at this salon; find it with list_bookings or get_customer_history` };
  if (booking.status !== "SCHEDULED") return { problem: `that booking is ${booking.status}, so it cannot be changed` };
  return { booking };
};

export const bookingChangeTools: Tool[] = [
  tool("list_bookings", "This salon's bookings starting on one date (YYYY-MM-DD, salon time), optionally only one staff member's: booking id, time, customer, phone, services, staff, status.", {
    date: { type: "string" }, staffId: { type: ["integer", "null"] },
  }, async (args, context) => {
    const item = args as { date: string; staffId: number | null };
    if (!isDate(item.date)) return refuse("date must be YYYY-MM-DD");
    const timezone = context.input.timezone;
    const rows = (await context.data.bookingsOn(item.date, timezone)).filter((row) => item.staffId === null || row.staff.some((staff) => staff.id === item.staffId));
    return {
      date: `${weekdayOf(item.date)} ${item.date}`,
      bookings: rows.map((row) => ({
        bookingId: row.id, time: `${inSalonTime(row.startTime, timezone).slice(-5)}-${inSalonTime(row.endTime, timezone).slice(-5)}`, status: row.status,
        customer: row.customer, phone: row.phone, services: row.services, staff: row.staff.map((staff) => staff.name), ...(row.people > 1 ? { people: row.people } : {}),
      })),
    };
  }),

  tool("propose_reschedule_booking", "Propose moving a scheduled booking to a new date (YYYY-MM-DD) and start time (HH:mm). keepStaff true keeps its staff member; false lets any free staff take it.", {
    bookingId: int, date: { type: "string" }, time: { type: "string" }, keepStaff: { type: "boolean" },
  }, async (args, context) => {
    const item = args as { bookingId: number; date: string; time: string; keepStaff: boolean };
    const found = await existingBooking(context, item.bookingId);
    if (!found.booking) return refuse(found.problem!);
    const booking = found.booking;
    const problems: string[] = [];
    if (!isDate(item.date)) problems.push("date must be YYYY-MM-DD");
    else if (item.date < context.input.today) problems.push(`${item.date} is in the past (today is ${context.input.today})`);
    if (!isTime(item.time)) problems.push("time must be HH:mm");
    else if (minutes(item.time) % 10 !== 0) problems.push(`${item.time} is not a start time: bookings start on the 10-minute mark`);
    if (!booking.serviceId) problems.push("this booking has no service to reschedule");
    if (item.keepStaff && booking.staff.length !== 1) problems.push(`this booking is done by ${booking.staff.map((staff) => staff.name).join(" and ")}; keep them all by moving it with keepStaff=false, or ask the owner`);
    if (context.batch.pending("RESCHEDULE_BOOKING").some((row) => row.bookingId === booking.id) || context.batch.pending("CANCEL_BOOKING").some((row) => row.bookingId === booking.id)) problems.push("this booking already has a change proposed");
    if (problems.length) return refuse(...problems);

    const staff = item.keepStaff ? booking.staff[0]! : null;
    // The engine still counts this booking where it is now, so a move overlapping its own current time can look taken.
    const slots = staff
      ? await staffAvailableTimes(context.input.organizationId, { serviceId: booking.serviceId!, staffId: staff.id, date: item.date })
      : await availableTimes(context.input.organizationId, { serviceId: booking.serviceId!, addonIds: booking.addonIds, date: item.date, people: booking.people });
    if (!slots.includes(item.time)) {
      const nearest = [...slots].sort((a, b) => Math.abs(minutes(a) - minutes(item.time)) - Math.abs(minutes(b) - minutes(item.time))).slice(0, 4).sort();
      return refuse(`${item.time} on ${weekdayOf(item.date)} ${item.date} is not free for ${staff?.name ?? "any staff"}`,
        nearest.length ? `nearest free start times that day: ${nearest.join(", ")}` : "nothing is free that day",
        ...(booking.startTime.toISOString().slice(0, 10) === item.date ? ["if the new time overlaps where the booking is now, the engine may count the booking itself as busy"] : []));
    }
    const length = Math.round((booking.endTime.getTime() - booking.startTime.getTime()) / 60_000);
    return accept(context, {
      type: "RESCHEDULE_BOOKING", bookingId: booking.id, customer: booking.customer, phone: booking.phone, services: booking.services,
      from: inSalonTime(booking.startTime, context.input.timezone), toDate: item.date, toTime: item.time, toEndTime: addMinutes(item.time, length),
      staffMode: staff ? "SAME" : "ANY", staffId: staff?.id ?? null, staffName: staff?.name ?? null,
    }, { to: `${weekdayOf(item.date)} ${item.date} ${item.time}-${addMinutes(item.time, length)}` });
  }),

  tool("propose_cancel_booking", "Propose cancelling a scheduled booking, or marking it a no-show (only once its start time has passed). notifyCustomer emails the customer (default true); reason, if given, goes into that email.", {
    bookingId: int, noShow: { type: "boolean" }, notifyCustomer: { type: "boolean" }, reason: { type: ["string", "null"] },
  }, async (args, context) => {
    const item = args as { bookingId: number; noShow: boolean; notifyCustomer: boolean; reason: string | null };
    const found = await existingBooking(context, item.bookingId);
    if (!found.booking) return refuse(found.problem!);
    const booking = found.booking;
    const problems: string[] = [];
    if (item.noShow && booking.startTime > new Date()) problems.push("a booking can only be a no-show once its start time has passed; cancel it instead");
    if (item.reason && item.reason.length > 500) problems.push("the reason can be at most 500 characters");
    if (context.batch.pending("RESCHEDULE_BOOKING").some((row) => row.bookingId === booking.id) || context.batch.pending("CANCEL_BOOKING").some((row) => row.bookingId === booking.id)) problems.push("this booking already has a change proposed");
    if (problems.length) return refuse(...problems);
    const refund = item.noShow ? null : booking.refundOnCancel;
    return accept(context, {
      type: "CANCEL_BOOKING", bookingId: booking.id, customer: booking.customer, phone: booking.phone, services: booking.services,
      staff: booking.staff.map((staff) => staff.name), when: inSalonTime(booking.startTime, context.input.timezone),
      noShow: item.noShow, notifyCustomer: item.notifyCustomer, reason: item.reason?.trim() || null, refund, currency: await context.data.currency(),
    }, {
      ...(refund ? { refund: `the customer paid online, so cancelling refunds ${refund}: tell the owner` } : {}),
      ...(item.notifyCustomer && !booking.hasEmail ? { note: "the customer has no email, so no cancellation email can be sent" } : {}),
    });
  }),
];
