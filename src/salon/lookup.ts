import { prisma } from "../clients/prisma";
import { BOOKING_SITE_URL, DEFAULT_ORGANIZATION_ID, DEFAULT_TIMEZONE } from "../config";

/** The salon this call belongs to, worked out once when the call connects. */
export interface Salon {
  organizationId: number;
  name: string;
  timezone: string;
  /**
   * Whether a real organization was found.
   *
   * False means the number belongs to no salon and the configured fallback is
   * not a salon either — there is no catalogue, no diary and nothing to answer
   * with. The name reads "the salon" in that case, which is a placeholder and
   * not evidence of anything.
   */
  found: boolean;
  /**
   * The salon's own line, for a caller who asks to speak to someone.
   *
   * Its second number when it has one, otherwise the main line. A salon that
   * forwards its main line here unconditionally will send a transfer straight
   * back to this service and round again — the second number is the way out
   * of that, which is why it is preferred when set.
   */
  staffPhone: string | null;
  /**
   * What the salon has written about itself, for a caller asking about the
   * salon rather than about a booking. Null where the owner left it blank —
   * and then the receptionist says it has not been told, rather than guessing.
   */
  phone: string | null;
  addressNote: string | null;
  website: string | null;
  /** The salon's own booking page, when the site address is configured. */
  bookingUrl: string | null;
  /** The week's opening hours as one line, from the salon's working-hour table. */
  hours: string | null;
  /**
   * What the salon sells as gift cards, one per line, or null when it sells
   * none. Read-only knowledge: a card is bought on the website, never here.
   */
  giftCards: string | null;
  /** The page where a customer buys one. */
  giftCardUrl: string | null;
  localKnowledge: string | null;
  /** The owner's own instructions to the receptionist, verbatim. */
  aiRules: string | null;
}

/** Every column a salon is read with, in one place for both lookups. */
const SALON_COLUMNS = {
  id: true,
  name: true,
  timezone: true,
  phone: true,
  secondaryPhone: true,
  addressNote: true,
  website: true,
  slug: true,
  localKnowledge: true,
  aiRules: true,
} as const;

type SalonRow = {
  id: number;
  name: string | null;
  timezone: string;
  phone: string | null;
  secondaryPhone: string | null;
  addressNote: string | null;
  website: string | null;
  slug: string | null;
  localKnowledge: string | null;
  aiRules: string | null;
};

const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** How far ahead special days are read. A caller planning further out than this is rare. */
const SPECIAL_DAYS_HORIZON = 21;

const dayHours = (day: { openTime: string; closeTime: string; isClosed: boolean }) =>
  day.isClosed ? "closed" : `${day.openTime}-${day.closeTime}`;

/**
 * "YYYY-MM-DD" in the salon's own clock, some days from now. Special days are
 * stored as plain dates, so the window has to be cut in the salon's day, not
 * the server's.
 */
const salonDatePlus = (timezone: string, days: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + days * 24 * 60 * 60 * 1000));

/**
 * The salon's week as one line, plus any day in the next three weeks that
 * departs from it: "Mon 09:00-18:00, … Sun closed. Special: Fri 2026-10-09
 * closed, Sat 2026-10-10 10:00-14:00". Read once per conversation.
 *
 * Special days are the salon's own overrides — a public holiday, a short day —
 * and beat the week. Without them the receptionist would say "open nine till
 * six" on a day the owner has marked closed.
 */
const weeklyHours = async (organizationId: number, timezone: string): Promise<string | null> => {
  const [week, specialDays] = await Promise.all([
    prisma.workingHour.findMany({
      where: { organizationId },
      orderBy: { dayOfWeek: "asc" },
      select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true },
    }),
    prisma.workingHourOverride.findMany({
      where: {
        organizationId,
        deletedAt: null,
        date: { gte: salonDatePlus(timezone, 0), lte: salonDatePlus(timezone, SPECIAL_DAYS_HORIZON) },
      },
      orderBy: { date: "asc" },
      select: { date: true, openTime: true, closeTime: true, isClosed: true },
    }),
  ]);
  if (week.length === 0) return null;

  const weekLine = week
    .map((day) => `${DAYS[day.dayOfWeek] ?? day.dayOfWeek} ${dayHours(day)}`)
    .join(", ");
  if (specialDays.length === 0) return weekLine;

  // A plain date has no zone, so it is named in UTC to stop the server's own
  // clock shifting a Friday into a Thursday.
  const weekdayOf = (date: string) =>
    new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short" }).format(
      new Date(`${date}T00:00:00Z`),
    );
  const specialLine = specialDays
    .map((day) => `${weekdayOf(day.date)} ${day.date} ${dayHours(day)}`)
    .join(", ");
  return `${weekLine}. Special days, which replace the usual hours: ${specialLine}`;
};

/**
 * "Name — $80 (worth $100, valid 365 days)" per card. Public cards only; a
 * card the owner has hidden is not for sale, so the receptionist must not
 * know it exists.
 */
const giftCardList = async (organizationId: number): Promise<string | null> => {
  const cards = await prisma.giftCard.findMany({
    where: { organizationId, status: "PUBLIC" },
    orderBy: { price: "asc" },
    select: { name: true, price: true, redeemValue: true, duration: true, currency: true, description: true },
  });
  if (cards.length === 0) return null;
  return cards
    .map((card) => {
      const worth = card.redeemValue !== card.price ? `, worth $${card.redeemValue}` : "";
      const note = card.description?.trim() ? ` — ${card.description.trim()}` : "";
      return `${card.name}: $${card.price} ${card.currency}${worth}, valid ${card.duration} days${note}`;
    })
    .join("\n");
};

const asSalon = async (row: SalonRow): Promise<Salon> => ({
  organizationId: row.id,
  name: row.name ?? "the salon",
  timezone: row.timezone,
  found: true,
  staffPhone: row.secondaryPhone ?? row.phone,
  phone: row.phone,
  addressNote: row.addressNote?.trim() || null,
  website: row.website?.trim() || null,
  bookingUrl: BOOKING_SITE_URL && row.slug ? `${BOOKING_SITE_URL}/booking/${row.slug}` : null,
  hours: await weeklyHours(row.id, row.timezone),
  giftCards: await giftCardList(row.id),
  giftCardUrl:
    BOOKING_SITE_URL && row.slug ? `${BOOKING_SITE_URL}/booking/${row.slug}/gift-card` : null,
  localKnowledge: row.localKnowledge?.trim() || null,
  aiRules: row.aiRules?.trim() || null,
});

/**
 * Phone numbers arrive in whatever shape each system likes — +61 4 1234 5678,
 * 0412345678, (04) 1234 5678. Comparing the last nine digits gets a match
 * across all of them without pretending to know the dialling plan.
 */
const tail = (phone: string) => phone.replace(/\D/g, "").slice(-9);

/**
 * Which salon was dialled.
 *
 * Two arrangements, and both are read. A salon can publish a Twilio number
 * that only this service answers — `assistantPhone` — and keep its own line
 * free to be rung when a caller asks for a person. Or it can forward its
 * existing number here, in which case `forwardedFrom` names it; that works,
 * but a transfer then risks looping back through the forward.
 *
 * Done once at setup and kept on the session. Looking it up again mid-call
 * would be a database round trip in the middle of a sentence, and the answer
 * cannot change while the phone is off the hook.
 */
export const salonForCall = async (
  to: string | null,
  forwardedFrom: string | null,
): Promise<{ salon: Salon; matchedOn: string }> => {
  /*
   * `to` first, and matched only against assistantPhone.
   *
   * Each salon has its own Twilio number, so the number dialled says which
   * salon this is and nothing else has to be guessed at. forwardedFrom is
   * tried afterwards, for a salon that forwards an old number instead — but
   * only afterwards, because a forwarded number is the salon's own line, and
   * one salon's old number can be another's `phone`. Reading that first meant
   * a forward could name the wrong salon.
   */
  const attempts = [
    { label: "to", number: to, fields: ["assistantPhone"] },
    { label: "forwardedFrom", number: forwardedFrom, fields: ["assistantPhone", "phone", "secondaryPhone"] },
  ] as const;

  for (const { label, number, fields } of attempts) {
    if (!number) continue;
    const digits = tail(number);
    if (digits.length < 6) continue;

    const matches = await prisma.organization.findMany({
      where: {
        OR: fields.map((field) => ({ [field]: { endsWith: digits } })),
      },
      select: SALON_COLUMNS,
      orderBy: { id: "asc" },
    });

    /*
     * Exactly one, or none. Several salons sharing a number is real in the
     * data and there is no way to tell from the call which one was meant —
     * guessing would book a stranger's customer, so it falls through to the
     * configured salon instead.
     */
    if (matches.length === 1) {
      return { salon: await asSalon(matches[0]!), matchedOn: label };
    }
    if (matches.length > 1) {
      return { salon: await configuredSalon(), matchedOn: `${label}:ambiguous` };
    }
  }

  return { salon: await configuredSalon(), matchedOn: "fallback" };
};

/**
 * One salon, by id.
 *
 * What a chat uses: there is no number to work backwards from, but the app
 * that opened the conversation already knows whose salon it is.
 */
export const salonById = async (organizationId: number): Promise<Salon> => {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: SALON_COLUMNS,
  });

  if (organization) return asSalon(organization);

  return {
    organizationId,
    name: "the salon",
    timezone: DEFAULT_TIMEZONE,
    found: false,
    staffPhone: null,
    phone: null,
    addressNote: null,
    website: null,
    bookingUrl: null,
    hours: null,
    giftCards: null,
    giftCardUrl: null,
    localKnowledge: null,
    aiRules: null,
  };
};

/** The salon this instance is set up for, when nothing else names one. */
const configuredSalon = () => salonById(DEFAULT_ORGANIZATION_ID);
