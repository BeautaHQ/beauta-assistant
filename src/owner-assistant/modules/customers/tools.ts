import { toE164 } from "../../phone";
import { inSalonTime } from "../../rules";
import { refuse, tool, type Tool } from "../../toolkit";

export const customersTools: Tool[] = [
  tool("find_customer", "Look up this salon's customer by phone number (as the owner typed it). Returns the normalised number and the customer, or found=false.", {
    phone: { type: "string" },
  }, async ({ phone }, context) => {
    const normalised = toE164(String(phone), context.input.timezone);
    if (!normalised) return refuse(`${String(phone)} is not a valid phone number; ask the owner to check it`);
    const customer = await context.data.customerByPhone(normalised);
    return customer ? { phone: normalised, found: true, customer } : { phone: normalised, found: false };
  }),

  tool("search_customers", "Find this salon's customers by name (any part of first or last name) or by part of a phone number. At most 10.", {
    query: { type: "string" },
  }, async ({ query }, context) => {
    const text = String(query).trim();
    if (text.length < 2) return refuse("give at least 2 characters of a name or 4 digits of a phone");
    const customers = await context.data.searchCustomers(text);
    return { customers, ...(customers.length === 10 ? { note: "there may be more; ask the owner for more of the name or the phone" } : {}) };
  }),

  tool("get_customer_history", "One customer's bookings at this salon (customerId from find_customer or search_customers): upcoming, recent visits, cancellations, no-shows and total spent.", {
    customerId: { type: "integer" },
  }, async ({ customerId }, context) => {
    const bookings = await context.data.customerBookings(Number(customerId));
    if (!bookings) return refuse(`no customer with id ${String(customerId)} at this salon`);
    const now = new Date();
    const timezone = context.input.timezone;
    const describe = (booking: (typeof bookings)[number]) => ({
      bookingId: booking.id, when: inSalonTime(booking.startTime, timezone), status: booking.status,
      services: booking.services, addons: booking.addons, staff: booking.staff, price: booking.finalPrice,
      ...(booking.people > 1 ? { people: booking.people } : {}),
      ...(booking.notes ? { notes: booking.notes } : {}), ...(booking.customerNotes ? { customerNotes: booking.customerNotes } : {}),
    });
    const upcoming = bookings.filter((booking) => booking.startTime > now && booking.status === "SCHEDULED").reverse();
    const past = bookings.filter((booking) => booking.startTime <= now);
    const completed = bookings.filter((booking) => booking.status === "COMPLETED");
    return {
      totals: {
        bookings: bookings.length, completed: completed.length,
        cancelled: bookings.filter((booking) => booking.status === "CANCELED").length,
        noShows: bookings.filter((booking) => booking.status === "NO_SHOW").length,
        spent: Math.round(completed.reduce((sum, booking) => sum + booking.finalPrice, 0) * 100) / 100,
        currency: await context.data.currency(),
        firstVisit: past.length ? inSalonTime(past[past.length - 1]!.startTime, timezone) : null,
      },
      upcoming: upcoming.slice(0, 10).map(describe),
      recent: past.slice(0, 10).map(describe),
      ...(bookings.length === 200 ? { note: "only the latest 200 bookings were counted" } : {}),
    };
  }),

  tool("get_loyalty_settings", "How this salon's loyalty points work: whether they are on, how much spending earns one point, and what one point is worth when redeemed.", {},
    async (_args, { data }) => ({ loyalty: await data.loyaltySettings(), currency: await data.currency() })),

  tool("get_customer_points", "A customer's loyalty point balance, what it is worth, and their latest point movements (customerId from find_customer or search_customers).", {
    customerId: { type: "integer" },
  }, async ({ customerId }, context) => {
    const points = await context.data.customerPoints(Number(customerId));
    if (!points) return refuse(`no customer with id ${String(customerId)} at this salon`);
    const settings = await context.data.loyaltySettings();
    return {
      balance: points.balance, worth: Math.round(points.balance * settings.pointValue * 100) / 100, currency: await context.data.currency(),
      ...(settings.enabled ? {} : { note: "loyalty points are switched off at this salon" }),
      latest: points.transactions.map((row) => ({
        when: inSalonTime(row.createdAt, context.input.timezone), change: row.type === "ADD" ? row.points : -row.points, balanceAfter: row.balanceAfter, note: row.note,
      })),
    };
  }),

  tool("list_enquiries", "This salon's latest customer enquiries (messages from the booking page), newest first, at most 10. status: NEW (unread), OPENED (read, not answered), RESPONDED, or null for all. phone: only this customer's, or null.", {
    status: { type: ["string", "null"], enum: ["NEW", "OPENED", "RESPONDED", null] }, phone: { type: ["string", "null"] },
  }, async (args, context) => {
    const item = args as { status: string | null; phone: string | null };
    const phone = item.phone ? toE164(item.phone, context.input.timezone) : null;
    if (item.phone && !phone) return refuse(`${item.phone} is not a valid phone number; ask the owner to check it`);
    const { rows, unread } = await context.data.enquiries({ status: item.status, phone });
    return {
      unreadTotal: unread,
      enquiries: rows.map((row) => ({
        from: `${row.firstName} ${row.lastName}`.trim(), phone: row.phone, email: row.email, status: row.status,
        received: inSalonTime(row.createdAt, context.input.timezone), ...(row.aiIntent ? { wants: row.aiIntent } : {}),
        message: row.message.length > 300 ? `${row.message.slice(0, 300)}...` : row.message,
      })),
    };
  }),
];
