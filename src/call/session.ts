import type { FoundBooking } from "../clients/beautaApi";
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
  /** Which step of a booking the turn was, when it was one. */
  step?: string;
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
  /**
   * Ours, and the identity of the conversation.
   *
   * Not Twilio's call id: a phone call is one channel this can arrive on and
   * chat is another, and hanging the identity on the phone system would leave
   * every chat needing a fake one.
   */
  conversationId: string;
  channel: "PHONE" | "CHAT";
  /** Twilio's id, when there was a call. A link back to their records. */
  callSid: string | null;
  /** Worked out from the number dialled, once, when the call connects. */
  salon: Salon;
  /** Caller ID from Twilio. Never asked for, never taken from the model. */
  phone: string;
  toNumber: string | null;
  forwardedFrom: string | null;
  catalogue: Catalogue | null;
  booking: BookingState;
  /**
   * The last thing the diary returned — the only times that exist.
   *
   * `key` names the appointment they were fetched for: service, day, extras,
   * head count. Any of those changing makes the list stale, and the code that
   * reads the diary compares the key rather than guessing which field moved.
   */
  offered: { serviceId: number; date: string; slots: string[]; key?: string } | null;
  /**
   * Whether the whole booking has been read back to the caller: the service,
   * its extras, the day, the time and their name.
   *
   * Set by the turn that read it out, which the model reports on its reply.
   * Enforced rather than asked for: told in words to read it back first, the
   * model booked a caller who had done no more than say their name.
   */
  reviewed: boolean;
  /**
   * Extras the caller asked for that their service does not offer.
   *
   * Stripped from the booking as they arrive rather than refused later: the
   * service is still what they wanted, so it is kept, and only the extras that
   * do not belong to it are dropped. Held here so the next turn can say which
   * ones went and what is actually on offer.
   */
  rejectedAddons: string[];
  /** A time the caller asked for that the diary never offered. */
  rejectedTime: string | null;
  /**
   * An existing booking this caller has proved is theirs, when they rang to
   * change or cancel one. Null until the day and time they gave matched a
   * booking against their own caller ID.
   */
  managing: FoundBooking | null;
  /**
   * What the last turn was for.
   *
   * Without this the next turn cannot tell a caller who is halfway through
   * changing a booking from one who has said nothing yet. It offered the
   * new-booking checklist to someone asking to move an appointment, which sent
   * the model looking for a service instead of for their booking.
   */
  lastIntent: string | null;
  /**
   * Set when the receptionist has agreed to put the caller through.
   *
   * The tool cannot do it itself: handing over means closing the socket with a
   * reason, which only the connection holding it can do.
   */
  transferring: boolean;
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
  /** How long the turn spent reading and checking before the reply began. For the simulator. */
  intentMs: number;
  /** How many turns this call has been abusive or obscene. Two on a call ends it. */
  offLimits: number;
  transcript: TranscriptLine[];
}

export const newSession = (
  conversationId: string,
  phone: string,
  salon: Salon,
  channel: CallSession["channel"] = "PHONE",
): CallSession => ({
  conversationId,
  channel,
  callSid: null,
  salon,
  phone,
  toNumber: null,
  forwardedFrom: null,
  catalogue: null,
  // Caller ID is the one thing a call knows before a word is said. A chat
  // starts with nothing and has to ask.
  booking: { ...emptyBooking(), phone: channel === "PHONE" ? phone : null },
  offered: null,
  reviewed: false,
  rejectedAddons: [],
  rejectedTime: null,
  managing: null,
  lastIntent: null,
  transferring: false,
  bookingPublicId: null,
  waitlisted: false,
  checksThisTurn: 0,
  toolsThisTurn: [],
  intentMs: 0,
  offLimits: 0,
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
