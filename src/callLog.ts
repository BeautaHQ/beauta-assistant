import type { Prisma } from "@prisma/client";

import { prisma } from "./client";
import type { CallSession } from "./session";

/**
 * The record of a call, as the salon will read it back.
 *
 * Two writes rather than one at the end: a call that drops, or a process that
 * restarts mid-sentence, would otherwise leave nothing at all — and the calls
 * worth reading are exactly the ones that went wrong. The row appears when the
 * phone is answered and is finished when it is put down.
 */
export const openCall = async (session: CallSession): Promise<void> => {
  await prisma.voiceCall.upsert({
    where: { callSid: session.callSid },
    create: {
      organizationId: session.salon.organizationId,
      callSid: session.callSid,
      fromNumber: session.phone,
      toNumber: session.toNumber,
      forwardedFrom: session.forwardedFrom,
    },
    // A reconnecting socket carries the same callSid; it is the same call.
    update: {},
  });
};

const outcomeOf = (session: CallSession) => {
  if (session.bookingPublicId) return "BOOKED" as const;
  if (session.waitlisted) return "WAITLISTED" as const;
  return "NO_ACTION" as const;
};

export const closeCall = async (session: CallSession): Promise<void> => {
  await prisma.voiceCall.update({
    where: { callSid: session.callSid },
    data: {
      endedAt: new Date(),
      outcome: outcomeOf(session),
      // Prisma's Json input wants an index signature; our own shapes are the
      // documentation, so they are asserted at the boundary rather than loosened.
      transcript: session.transcript as unknown as Prisma.InputJsonValue,
      // Kept even when nothing was booked: a call that fell over at "which
      // day?" is exactly the one worth looking at.
      bookingState: session.booking as unknown as Prisma.InputJsonValue,
      bookingPublicId: session.bookingPublicId,
    },
  });
};
