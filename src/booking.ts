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
  /** YYYY-MM-DD in the salon's timezone. */
  date: string | null;
  /** HH:mm, 24-hour, and only ever one check_availability returned. */
  time: string | null;
  firstName: string | null;
  lastName: string | null;
  /** The caller has heard the whole thing read back and said yes. */
  confirmed: boolean;
}

export const emptyBooking = (): BookingState => ({
  serviceId: null,
  serviceName: null,
  addonIds: [],
  date: null,
  time: null,
  firstName: null,
  lastName: null,
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
    "date",
    "time",
    "firstName",
    "lastName",
    "confirmed",
  ],
  properties: {
    serviceId: {
      type: ["integer", "null"],
      description: "An id from list_services. Never invented.",
    },
    serviceName: { type: ["string", "null"] },
    addonIds: { type: "array", items: { type: "integer" } },
    date: { type: ["string", "null"], description: "YYYY-MM-DD" },
    time: {
      type: ["string", "null"],
      description: "HH:mm, 24-hour, and only one that check_availability returned",
    },
    firstName: { type: ["string", "null"] },
    lastName: { type: ["string", "null"] },
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
    addonIds: update.addonIds?.length ? update.addonIds : current.addonIds,
    date: real(update.date) ?? current.date,
    time: real(update.time) ?? current.time,
    firstName: real(update.firstName) ?? current.firstName,
    lastName: real(update.lastName) ?? current.lastName,
    confirmed: update.confirmed ?? current.confirmed,
  };
};

/** What is still needed, in the order it should be asked for. */
export const missingFields = (booking: BookingState): string[] => {
  const gaps: string[] = [];
  if (!booking.serviceId) gaps.push("service");
  if (!booking.date) gaps.push("date");
  if (!booking.time) gaps.push("time");
  if (!booking.firstName?.trim() || !booking.lastName?.trim()) gaps.push("full name");
  if (!booking.confirmed) gaps.push("confirmation");
  return gaps;
};

const shown = (value: string | number | null) =>
  value === null || value === "" ? "not yet" : String(value);
