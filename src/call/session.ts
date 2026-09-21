import { emptyBooking, type BookingState } from "./booking";
import type { Catalogue } from "../salon/catalogue";
import type { Salon } from "../salon/lookup";

/** One line of what was actually said, kept for the salon to read back later. */
export interface TranscriptLine {
  role: "caller" | "salon";
  text: string;
  at: string;
  /** What the receptionist decided the turn was for. Absent on caller lines. */
  intent?: string;
  /** True when the turn said it would read the diary and then did not. */
  brokePromise?: boolean;
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
  /**
   * Whether the whole booking has been read back to the caller: the service,
   * its extras, the day, the time and their name.
   *
   * Set only by a turn the model itself labelled REVIEW, which is the turn on
   * which it gets read out. Inferred before from the state having nothing
   * outstanding but a yes, which was close but not the same thing — a turn can
   * have everything on file without a word of it reaching the caller.
   * Enforced rather than asked for: told in words to read it back first, the
   * model booked a caller who had done no more than say their name.
   */
  reviewed: boolean;
  /** Set once the booking is made, so a second attempt cannot go through. */
  bookingPublicId: string | null;
  waitlisted: boolean;
  /**
   * How many days this turn has looked at. Reset per turn: a model left to
   * itself checks tomorrow, then the next day, then the one after, and the
   * caller hears three seconds of nothing for two answers they did not ask for.
   */
  checksThisTurn: number;
  /**
   * What the tools did on the current turn, kept so the simulator can show it.
   * A real call hides this entirely: the caller hears a sentence, and whether
   * the diary was read to produce it is invisible.
   */
  toolsThisTurn: { name: string; args: unknown; result: string }[];
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
  reviewed: false,
  bookingPublicId: null,
  waitlisted: false,
  checksThisTurn: 0,
  toolsThisTurn: [],
  transcript: [],
});

export const record = (
  session: CallSession,
  role: TranscriptLine["role"],
  text: string,
  extra: Omit<TranscriptLine, "role" | "text" | "at"> = {},
) => {
  session.transcript.push({ role, text, at: new Date().toISOString(), ...extra });
};
