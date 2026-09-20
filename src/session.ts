import { emptyBooking, missingFields, type BookingState } from "./booking";
import type { Catalogue } from "./catalogue";
import type { Salon } from "./salon";
import { describeOffer } from "./slots";

/** One line of what was actually said, kept for the salon to read back later. */
export interface TranscriptLine {
  role: "caller" | "salon";
  text: string;
  at: string;
}

/**
 * Everything one phone call knows about itself.
 *
 * Per-connection rather than module-level: two people can ring the salon at the
 * same moment, and a diary shared between them would book one caller into the
 * other's slot.
 */
export interface CallSession {
  callSid: string;
  /** Worked out from the number dialled, once, when the call connects. */
  salon: Salon;
  /** Caller ID from Twilio. Never asked for, never taken from the model. */
  phone: string;
  toNumber: string | null;
  forwardedFrom: string | null;
  catalogue: Catalogue | null;
  booking: BookingState;
  /** The last thing check_availability returned — the only times that exist. */
  offered: { serviceId: number; date: string; slots: string[] } | null;
  /** Set once the booking is made, so a second attempt cannot go through. */
  bookingPublicId: string | null;
  waitlisted: boolean;
  /**
   * How many days this turn has looked at. Reset per turn: a model left to
   * itself checks tomorrow, then the next day, then the one after, and the
   * caller hears three seconds of nothing for two answers they did not ask for.
   */
  checksThisTurn: number;
  transcript: TranscriptLine[];
}

export const newSession = (
  callSid: string,
  phone: string,
  salon: Salon,
): CallSession => ({
  callSid,
  salon,
  phone,
  toNumber: null,
  forwardedFrom: null,
  catalogue: null,
  booking: emptyBooking(),
  offered: null,
  bookingPublicId: null,
  waitlisted: false,
  checksThisTurn: 0,
  transcript: [],
});

export const record = (
  session: CallSession,
  role: TranscriptLine["role"],
  text: string,
) => {
  session.transcript.push({ role, text, at: new Date().toISOString() });
};

/**
 * What to actually do about each gap.
 *
 * "Ask for the date" on its own was read as an instruction to keep asking, even
 * after the caller had answered — so each gap names the move that closes it
 * instead.
 */
const NEXT_STEP: Record<string, string> = {
  service: "Work out which service they mean from the price list and record its id.",
  date: "Settle which day they want and record it as YYYY-MM-DD.",
  time: "If they have named a time, record it as HH:mm. Otherwise call check_availability for that date, then offer two or three of the times it returns, near what they asked for.",
  "full name":
    "Ask for their first and last name. If they have given both at once, like \"Sarah Nguyen\", record firstName Sarah and lastName Nguyen and do not ask again.",
  confirmation:
    "Read the whole booking back — service, day, time — and ask them to confirm.",
};

/**
 * The state, written out for the model, fed in fresh every turn.
 *
 * It goes after the transcript rather than into the opening instructions
 * because the last thing a model reads carries the most weight — and what it
 * keeps getting wrong is running ahead of what the caller has actually said.
 */
export const briefing = (session: CallSession): string => {
  const { booking } = session;

  if (session.bookingPublicId) {
    return `BOOKING SO FAR
Booked already, reference ${session.bookingPublicId}. It is done — never book again.
Answer anything else they ask, then say goodbye and set endCall.`;
  }

  /*
   * Printed as the very object the model has to send back, rather than as
   * prose. Written out in words it read "time: not yet" and dutifully returned
   * "not yet" as the time — a placeholder meant for a human went into the
   * booking as a value. JSON with nulls in it has nothing to misread.
   */
  const lines = [
    "BOOKING SO FAR — this is your `booking` object. Send it back with the nulls",
    "you can now fill in, and never with a field emptied that already had a value.",
    JSON.stringify(booking),
    `caller's phone (already known, never ask): ${session.phone}`,
    session.offered
      ? `free on ${session.offered.date}: ${describeOffer(session.offered.slots)} — already checked, do not check this date again`
      : "availability: not checked yet",
  ];

  if (session.waitlisted) lines.push("they are already on the waitlist");

  /*
   * Listed in full rather than one at a time. The state is a turn behind what
   * the caller just said, so naming only the first gap had it asking for a name
   * in the same breath as writing that name down. Given the whole list it can
   * cross off what it just heard and move to the next one itself.
   */
  const gaps = missingFields(booking);
  lines.push("");
  if (gaps.length === 0) {
    lines.push("Nothing is missing. Call create_booking now.");
  } else if (gaps.length === 1 && gaps[0] === "confirmation") {
    /*
     * Worth its own case. Buried in a list this step got read as "read it back
     * again", and the caller who had already said yes was asked a third time.
     */
    lines.push(
      "Everything is settled and you have already read it back. The only thing",
      "left is their yes.",
      "If their last message is a yes of any kind — \"yes\", \"that's right\",",
      "\"please book it\", \"go ahead\", \"perfect\" — then set confirmed true and call",
      "create_booking NOW, in this turn. Do not read the booking back again.",
      "Only if they changed something do you deal with that instead.",
    );
  } else {
    lines.push(
      "WHAT IS LEFT, in order. This list is one turn behind: record whatever the",
      "caller has just said, then do the first of these still undone, and only that.",
      ...gaps.map((gap, index) => `${index + 1}. ${gap} — ${NEXT_STEP[gap]!}`),
      "",
      "A plain yes to a booking you have just read back is the confirmation: set",
      "confirmed true and call create_booking in that same turn, without asking again.",
      "Never ask for something you have been told, and never check another day unasked.",
    );
  }

  return lines.join("\n");
};
