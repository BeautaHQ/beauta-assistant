import { prisma } from "../clients/prisma";

/**
 * The salon's current data, read straight from beauta-api's database.
 *
 * Read only, and every query is scoped to one organization: the id comes from
 * beauta-api, which resolved it from the signed-in owner. Writes never happen
 * here; they go through beauta-api when the owner confirms.
 *
 * Loaded lazily and kept for the length of one request, so the agent's reads
 * and the checks on its proposals see the same picture.
 */
export const createSalonData = (organizationId: number) => {
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>) => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key) as Promise<T>;
  };

  return {
    organizationId,

    salonHours: () => once("salonHours", async () => {
      const rows = await prisma.workingHour.findMany({ where: { organizationId }, orderBy: { dayOfWeek: "asc" } });
      return rows.map(({ dayOfWeek, openTime, closeTime, isClosed }) => ({ dayOfWeek, openTime, closeTime, isClosed }));
    }),

    /** A customer by their E.164 phone; phone is unique within a salon. */
    customerByPhone: (phone: string) => once(`customer:${phone}`, async () => {
      const customer = await prisma.customer.findUnique({
        where: { organizationId_phone: { organizationId, phone } },
        select: { id: true, firstName: true, lastName: true, email: true, isBlocked: true, preferences: true, _count: { select: { bookings: true } } },
      });
      return customer && {
        id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email,
        isBlocked: customer.isBlocked, preferences: customer.preferences, bookings: customer._count.bookings,
      };
    }),

    /** Up to 10 of this salon's customers whose name contains the text, or whose phone contains the digits. */
    searchCustomers: (text: string) => once(`search:${text}`, async () => {
      const words = text.trim().split(/\s+/).filter(Boolean);
      const digits = text.replace(/\D/g, "").replace(/^0/, "");
      const rows = await prisma.customer.findMany({
        where: {
          organizationId,
          OR: [
            ...(words.length ? [{ AND: words.map((word) => ({ OR: [
              { firstName: { contains: word, mode: "insensitive" as const } },
              { lastName: { contains: word, mode: "insensitive" as const } },
            ] })) }] : []),
            ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
          ],
        },
        select: { id: true, firstName: true, lastName: true, phone: true, email: true, _count: { select: { bookings: true } } },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        take: 10,
      });
      return rows.map((row) => ({ id: row.id, name: `${row.firstName} ${row.lastName}`.trim(), phone: row.phone, email: row.email, bookings: row._count.bookings }));
    }),

    /**
     * One customer's bookings at this salon, newest first, with what was done
     * and by whom. Null when the id is not a customer of this salon.
     */
    customerBookings: (customerId: number) => once(`bookings:${customerId}`, async () => {
      const customer = await prisma.customer.findFirst({ where: { id: customerId, organizationId }, select: { id: true } });
      if (!customer) return null;
      const rows = await prisma.booking.findMany({
        where: { organizationId, customerId },
        orderBy: { startTime: "desc" },
        take: 200,
        select: {
          id: true, startTime: true, status: true, finalPrice: true, quantity: true, notes: true, customerNotes: true,
          bookingTasks: {
            where: { deletedAt: null },
            orderBy: [{ participantIndex: "asc" }, { orderIndex: "asc" }],
            select: { service: { select: { name: true } }, addon: { select: { name: true } }, staff: { select: { name: true } } },
          },
        },
      });
      return rows.map((row) => ({
        id: row.id, startTime: row.startTime, status: row.status, finalPrice: row.finalPrice, people: row.quantity,
        notes: row.notes, customerNotes: row.customerNotes,
        services: [...new Set(row.bookingTasks.map((task) => task.service?.name).filter((name): name is string => Boolean(name)))],
        addons: [...new Set(row.bookingTasks.map((task) => task.addon?.name).filter((name): name is string => Boolean(name)))],
        staff: [...new Set(row.bookingTasks.map((task) => task.staff.name))],
      }));
    }),

    /** How the salon's loyalty points work; the database defaults when it has never set them. */
    loyaltySettings: () => once("loyalty", async () => {
      const setting = await prisma.organizationLoyaltySetting.findUnique({ where: { organizationId } });
      return {
        enabled: setting?.enabled ?? false,
        spendPerPoint: Number(setting?.spendPerPoint ?? 1),
        pointValue: Number(setting?.pointValue ?? 0),
      };
    }),

    /** A customer's point balance and latest point movements. Null when the id is not a customer of this salon. */
    customerPoints: (customerId: number) => once(`points:${customerId}`, async () => {
      const customer = await prisma.customer.findFirst({
        where: { id: customerId, organizationId },
        select: {
          pointBalance: { select: { balance: true } },
          pointTransactions: { orderBy: { createdAt: "desc" }, take: 10, select: { type: true, points: true, balanceAfter: true, note: true, createdAt: true } },
        },
      });
      return customer && { balance: customer.pointBalance?.balance ?? 0, transactions: customer.pointTransactions };
    }),

    /** This salon's latest customer enquiries, newest first, optionally only one status or one phone number. */
    enquiries: (filter: { status: string | null; phone: string | null }) => once(`enquiries:${filter.status}:${filter.phone}`, async () => {
      const where = { organizationId, ...(filter.status ? { status: filter.status } : {}), ...(filter.phone ? { phone: filter.phone } : {}) };
      const [rows, unread] = await Promise.all([
        prisma.customerEnquiry.findMany({
          where, orderBy: { createdAt: "desc" }, take: 10,
          select: { firstName: true, lastName: true, phone: true, email: true, message: true, status: true, createdAt: true, respondedAt: true, aiIntent: true },
        }),
        prisma.customerEnquiry.count({ where: { organizationId, status: "NEW" } }),
      ]);
      return { rows, unread };
    }),

    /**
     * One booking of this salon with what it holds, for rescheduling or
     * cancelling. Null when it is not this salon's booking.
     */
    booking: (bookingId: number) => once(`booking:${bookingId}`, async () => {
      const row = await prisma.booking.findFirst({
        where: { id: bookingId, organizationId },
        select: {
          id: true, startTime: true, endTime: true, status: true, firstName: true, lastName: true, phone: true, email: true,
          quantity: true, finalPrice: true, amountPaid: true,
          bookingTasks: { where: { deletedAt: null }, select: { serviceId: true, addonId: true, staffId: true, service: { select: { name: true } }, addon: { select: { name: true } }, staff: { select: { name: true } } } },
        },
      });
      if (!row) return null;
      // Paid online and settled: cancelling (not a no-show) refunds it through Stripe.
      const payment = await prisma.bookingPaymentDetails.findUnique({ where: { bookingId }, select: { paymentStatus: true, stripePaymentIntentId: true } });
      return {
        id: row.id, startTime: row.startTime, endTime: row.endTime, status: row.status,
        customer: `${row.firstName} ${row.lastName}`.trim(), phone: row.phone, hasEmail: Boolean(row.email), people: row.quantity, price: row.finalPrice,
        serviceId: row.bookingTasks.find((task) => task.serviceId)?.serviceId ?? null,
        addonIds: [...new Set(row.bookingTasks.map((task) => task.addonId).filter((id): id is number => id !== null))],
        services: [...new Set(row.bookingTasks.map((task) => task.service?.name).filter((name): name is string => Boolean(name)))],
        addons: [...new Set(row.bookingTasks.map((task) => task.addon?.name).filter((name): name is string => Boolean(name)))],
        staff: [...new Map(row.bookingTasks.map((task) => [task.staffId, task.staff.name])).entries()].map(([id, name]) => ({ id, name })),
        refundOnCancel: payment?.paymentStatus === "SUCCEEDED" && payment.stripePaymentIntentId ? row.amountPaid ?? row.finalPrice : null,
      };
    }),

    /** This salon's bookings starting on one date (salon time), earliest first. */
    bookingsOn: (date: string, timezone: string) => once(`bookingsOn:${date}`, async () => {
      // A day in the salon's time zone sits inside this UTC window; the exact day is filtered below.
      const from = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000);
      const to = new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86_400_000);
      const rows = await prisma.booking.findMany({
        where: { organizationId, startTime: { gte: from, lt: to } },
        orderBy: { startTime: "asc" },
        select: {
          id: true, startTime: true, endTime: true, status: true, firstName: true, lastName: true, phone: true, quantity: true,
          bookingTasks: { where: { deletedAt: null }, select: { staffId: true, service: { select: { name: true } }, staff: { select: { name: true } } } },
        },
      });
      const dayOf = (when: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
      return rows.filter((row) => dayOf(row.startTime) === date).map((row) => ({
        id: row.id, startTime: row.startTime, endTime: row.endTime, status: row.status,
        customer: `${row.firstName} ${row.lastName}`.trim(), phone: row.phone, people: row.quantity,
        services: [...new Set(row.bookingTasks.map((task) => task.service?.name).filter((name): name is string => Boolean(name)))],
        staff: [...new Map(row.bookingTasks.map((task) => [task.staffId, task.staff.name])).entries()].map(([id, name]) => ({ id, name })),
      }));
    }),

    currency: () => once("currency", async () =>
      (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { currency: true } })).currency),

    staff: () => once("staff", async () => {
      const rows = await prisma.staff.findMany({
        where: { organizationId, isLegacy: false, deletedAt: null },
        include: { services: true, addons: true, workingHours: { orderBy: { dayOfWeek: "asc" } } },
        orderBy: { id: "asc" },
      });
      return rows.map((staff) => ({
        id: staff.id, name: staff.name, phone: staff.phone, isActive: staff.isActive,
        serviceIds: staff.services.map((item) => item.serviceId),
        addonIds: staff.addons.map((item) => item.addonId),
        workingHours: staff.workingHours.map(({ dayOfWeek, startTime, endTime, isOff }) => ({ dayOfWeek, startTime, endTime, isOff })),
      }));
    }),

    services: () => once("services", async () => {
      const rows = await prisma.service.findMany({
        where: { organizationId, status: { notIn: ["LEGACY", "DELETED"] } },
        include: { serviceGroup: { select: { name: true } } },
        orderBy: { id: "asc" },
      });
      return rows.map((service) => ({
        id: service.id, name: service.name, price: service.price, durationMinutes: service.durationMinutes,
        status: service.status, group: service.serviceGroup?.name ?? null,
      }));
    }),

    /** The commission rates in force now. Closed (superseded or removed) rates are history and are left out. */
    commissionRules: () => once("commissionRules", async () => {
      const rows = await prisma.commissionRule.findMany({
        where: { organizationId, effectiveTo: null },
        orderBy: [{ staffId: "asc" }, { itemType: "asc" }, { itemId: "asc" }],
      });
      return rows.map((rule) => ({
        id: rule.id, staffId: rule.staffId, itemType: rule.itemType, itemId: rule.itemId, percentage: Number(rule.percentage),
      }));
    }),

    addons: () => once("addons", async () => {
      const rows = await prisma.addon.findMany({
        where: { organizationId, status: { not: "DELETED" } },
        include: { services: true },
        orderBy: [{ priorityOrder: "asc" }, { id: "asc" }],
      });
      return rows.map((addon) => ({
        id: addon.id, name: addon.name, price: addon.price, durationMinutes: addon.duration, status: addon.status,
        serviceIds: addon.services.map((item) => item.serviceId),
      }));
    }),
  };
};

export type SalonData = ReturnType<typeof createSalonData>;
export type StaffRow = Awaited<ReturnType<SalonData["staff"]>>[number];
export type ServiceRow = Awaited<ReturnType<SalonData["services"]>>[number];
export type AddonRow = Awaited<ReturnType<SalonData["addons"]>>[number];
