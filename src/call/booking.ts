/**
 * What the receptionist has pinned down so far.
 *
 * The model fills this in on every reply, which is the difference between a
 * conversation and a form being completed out loud: without it the model
 * re-derives the whole booking from the transcript each turn and quietly drifts
 * — booking one service while talking about another, or asking for a name it
 * has already been given.
 */
export interface BookingState {
  serviceId: number | null;
  serviceName: string | null;
  addonIds: number[];
  /** What the extras are called, so they can be read back without a lookup. */
  addonNames: string[];
  /**
   * How many people the booking is for.
   *
   * Null until asked, and that is what marks the extras turn as still to come:
   * the same turn settles both, so one of them standing in for the pair saves
   * carrying a second flag. It is not bookkeeping — two people need two staff
   * free at once, so the diary must be asked about the right number.
   */
  quantity: number | null;
  /** YYYY-MM-DD in the salon's timezone. */
  date: string | null;
  /** HH:mm, 24-hour, and only ever one check_availability returned. */
  time: string | null;
  firstName: string | null;
  lastName: string | null;
  /**
   * Where the salon rings them back.
   *
   * Part of the booking rather than of the channel, because that is what it is.
   * A phone call happens to know it before a word is spoken; a chat has to ask.
   */
  phone: string | null;
  /**
   * Optional, and only ever asked for in chat.
   *
   * It buys them a confirmation they can keep, but it is not worth a turn on a
   * phone call — spelling an address out loud is slow and goes wrong. Never in
   * missingFields: a booking is complete without it.
   */
  email: string | null;
  /** The caller has heard the whole thing read back and said yes. */
  confirmed: boolean;
}

export const emptyBooking = (): BookingState => ({
  serviceId: null,
  serviceName: null,
  addonIds: [],
  addonNames: [],
  quantity: null,
  date: null,
  time: null,
  firstName: null,
  lastName: null,
  phone: null,
  email: null,
  confirmed: false,
});

/** The `booking` half of the reply schema. Strict mode wants every key present. */
export const BOOKING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "serviceId",
    "serviceName",
    "addonIds",
    "addonNames",
    "quantity",
    "date",
    "time",
    "firstName",
    "lastName",
    "phone",
    "email",
    "confirmed",
  ],
  properties: {
    serviceId: {
      type: ["integer", "null"],
      description: "An id from list_services. Never invented.",
    },
    serviceName: { type: ["string", "null"] },
    addonIds: {
      type: "array",
      items: { type: "integer" },
      description: "Extra ids from the price list. Empty when they want none.",
    },
    addonNames: { type: "array", items: { type: "string" } },
    quantity: {
      type: ["integer", "null"],
      description: "How many people. 1 unless they said otherwise.",
    },
    date: { type: ["string", "null"], description: "YYYY-MM-DD" },
    time: {
      type: ["string", "null"],
      description: "HH:mm, 24-hour, and only one that check_availability returned",
    },
    firstName: { type: ["string", "null"] },
    lastName: { type: ["string", "null"] },
    phone: {
      type: ["string", "null"],
      description: "The number the salon would ring them on",
    },
    email: {
      type: ["string", "null"],
      description: "Optional, chat only. Null unless they gave one.",
    },
    confirmed: {
      type: "boolean",
      description: "True only after the caller has said yes to the booking read back to them",
    },
  },
} as const;

/**
 * Fold a reply's view of the booking into the running one.
 *
 * Only filled-in fields overwrite: a model that omits the name it was told two
 * turns ago should not erase it.
 */
/*
 * A model handed a state to carry forward will sometimes hand back a word from
 * the surrounding instructions instead of a value. Anything that is not a real
 * answer is treated as still unknown.
 */
const PLACEHOLDERS = new Set(["", "not yet", "unknown", "none", "null", "n/a", "tbd"]);

const real = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return PLACEHOLDERS.has(value.trim().toLowerCase()) ? null : value;
};

export const mergeBooking = (
  current: BookingState,
  update: Partial<BookingState> | null | undefined,
): BookingState => {
  if (!update) return current;
  return {
    serviceId: update.serviceId ?? current.serviceId,
    serviceName: real(update.serviceName) ?? current.serviceName,
    // An empty array is an answer here — "no extras" — so it only counts once
    // the extras turn has happened, which is what quantity marks.
    addonIds: update.addonIds?.length
      ? update.addonIds
      : update.quantity != null
        ? (update.addonIds ?? [])
        : current.addonIds,
    addonNames: update.addonNames?.length ? update.addonNames : current.addonNames,
    quantity: update.quantity ?? current.quantity,
    date: real(update.date) ?? current.date,
    time: real(update.time) ?? current.time,
    firstName: real(update.firstName) ?? current.firstName,
    lastName: real(update.lastName) ?? current.lastName,
    phone: real(update.phone) ?? current.phone,
    email: real(update.email) ?? current.email,
    confirmed: update.confirmed ?? current.confirmed,
  };
};

/** What is still needed, in the order it should be asked for. */
export const missingFields = (booking: BookingState): string[] => {
  const gaps: string[] = [];
  if (!booking.serviceId) gaps.push("service");
  if (booking.quantity === null) gaps.push("extras and how many people");
  if (!booking.date) gaps.push("date");
  if (!booking.time) gaps.push("time");
  if (!booking.firstName?.trim() || !booking.lastName?.trim()) gaps.push("full name");
  if (!booking.phone?.trim()) gaps.push("phone number");
  if (!booking.confirmed) gaps.push("confirmation");
  return gaps;
};
