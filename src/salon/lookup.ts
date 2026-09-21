import { prisma } from "../clients/prisma";
import { DEFAULT_ORGANIZATION_ID, DEFAULT_TIMEZONE } from "../config";

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
}

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
  for (const [label, number] of [
    ["forwardedFrom", forwardedFrom],
    ["to", to],
  ] as const) {
    if (!number) continue;
    const digits = tail(number);
    if (digits.length < 6) continue;

    const matches = await prisma.organization.findMany({
      where: {
        OR: [
          { assistantPhone: { endsWith: digits } },
          { phone: { endsWith: digits } },
          { secondaryPhone: { endsWith: digits } },
        ],
      },
      select: {
        id: true,
        name: true,
        timezone: true,
        phone: true,
        secondaryPhone: true,
      },
      orderBy: { id: "asc" },
    });

    /*
     * Exactly one, or none. Several salons sharing a number is real in the
     * data and there is no way to tell from the call which one was meant —
     * guessing would book a stranger's customer, so it falls through to the
     * configured salon instead.
     */
    if (matches.length === 1) {
      const found = matches[0]!;
      return {
        salon: {
          organizationId: found.id,
          name: found.name ?? "the salon",
          timezone: found.timezone,
          found: true,
          staffPhone: found.secondaryPhone ?? found.phone,
        },
        matchedOn: label,
      };
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
    select: {
      id: true,
      name: true,
      timezone: true,
      phone: true,
      secondaryPhone: true,
    },
  });

  return {
    organizationId,
    name: organization?.name ?? "the salon",
    timezone: organization?.timezone ?? DEFAULT_TIMEZONE,
    found: Boolean(organization),
    staffPhone: organization?.secondaryPhone ?? organization?.phone ?? null,
  };
};

/** The salon this instance is set up for, when nothing else names one. */
const configuredSalon = () => salonById(DEFAULT_ORGANIZATION_ID);
