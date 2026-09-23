import type { Prisma } from "@prisma/client";

import { prisma } from "../clients/prisma";
import type { CallSession } from "./session";

/**
 * The record of a conversation, as the salon will read it back.
 *
 * Written as it happens, not once at the end. A call that drops, a chat whose
 * tab is closed, a process that restarts mid-sentence — all of them would
 * otherwise leave an empty row, and those are exactly the conversations worth
 * reading. The row appears when the conversation starts, is brought up to date
 * after every turn, and is finished when it ends. Chat has no hang-up to end
 * on, which is why the per-turn write is not optional there.
 */
export const openCall = async (session: CallSession): Promise<void> => {
  await prisma.conversation.upsert({
    where: { publicId: session.conversationId },
    create: {
      organizationId: session.salon.organizationId,
      publicId: session.conversationId,
      channel: session.channel,
      callSid: session.callSid,
      fromNumber: session.phone,
      toNumber: session.toNumber,
      forwardedFrom: session.forwardedFrom,
    },
    // A reconnecting socket carries the same id; it is the same conversation.
    update: {},
  });
};

const outcomeOf = (session: CallSession) => {
  if (session.bookingPublicId) return "BOOKED" as const;
  if (session.waitlisted) return "WAITLISTED" as const;
  // Worth its own outcome: a salon reading the log needs to tell a call it was
  // handed cleanly from one where the caller simply went away.
  if (session.transferring) return "TRANSFERRED" as const;
  return "NO_ACTION" as const;
};

/** Everything the row learns from the session. Same fields mid-way and at the end. */
const progress = (session: CallSession) => ({
  outcome: outcomeOf(session),
  // Prisma's Json input wants an index signature; our own shapes are the
  // documentation, so they are asserted at the boundary rather than loosened.
  transcript: session.transcript as unknown as Prisma.InputJsonValue,
  // Kept even when nothing was booked: a conversation that fell over at
  // "which day?" is exactly the one worth looking at.
  bookingState: session.booking as unknown as Prisma.InputJsonValue,
  bookingPublicId: session.bookingPublicId,
});

/**
 * Bring the row up to date after a turn.
 *
 * Never allowed to fail the turn: the caller is waiting on a sentence, and a
 * database hiccup is the salon's problem to read about later, not theirs to
 * hear now.
 */
export const saveProgress = async (session: CallSession): Promise<void> => {
  try {
    await prisma.conversation.update({
      where: { publicId: session.conversationId },
      data: progress(session),
    });
  } catch {
    // The next turn writes the same fields again; nothing is lost for long.
  }
};

export const closeCall = async (session: CallSession): Promise<void> => {
  await prisma.conversation.update({
    where: { publicId: session.conversationId },
    data: { ...progress(session), endedAt: new Date() },
  });
};
