/**
 * What an enquiry is asking for, in fields rather than prose.
 *
 * Written once when the message is first read, and never rewritten: it is what
 * the customer said, and that does not change. Whether it can still be acted on
 * is a separate question with a different answer every hour — the salon's app
 * asks beauta-api that, against this, each time someone opens the enquiry.
 */
/**
 * What an enquiry turned out to be.
 *
 * ERROR is the honest answer, not a failure to give one: the message made no
 * sense, or it asked for something this salon cannot put on one appointment.
 * Without it both kinds came back as a confident BOOKING with a field quietly
 * missing, and the salon had no way to tell that from a good reading.
 */
export type EnquiryIntent =
  | "BOOKING"
  | "RESCHEDULE"
  | "CANCEL"
  | "FAQ"
  | "OTHER"
  | "ERROR";

export interface EnquiryAction {
  /** Ids from the salon's own price list, resolved from whatever they called it. */
  serviceId: number | null;
  serviceName: string | null;
  addonIds: number[];
  addonNames: string[];
  /**
   * Things they asked for that this salon cannot put on the appointment.
   *
   * A booking is one service and a set of extras. Ask for two services and the
   * second one only fits if the salon also sells it as an extra — plenty do,
   * for exactly this. Where it does not, there is no appointment that covers
   * what was asked, and saying so is the whole job: dropping the name quietly
   * would book half of what they wanted and tell nobody.
   *
   * Worked out here, never by the model.
   */
  unavailable: string[];
  quantity: number;
  /** YYYY-MM-DD in the salon's timezone, when the message names a day. */
  date: string | null;
  /** HH:mm, 24-hour. */
  time: string | null;
  /** For a move: where they want it to go. The booking itself is found by date+time. */
  newDate: string | null;
  newTime: string | null;
  /** Taken from the enquiry's own fields, not from the message. */
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

/** The shape the model fills in. Strict, so every field comes back. */
export const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  /*
   * The order is the order the model writes them in, and it cannot revise what
   * it has already written. So each thing is named before it is turned into an
   * id: asked for addonIds first it has nothing to map from yet and answers
   * with an empty array, then names the extra in the next field and cannot go
   * back. Naming first, the id is a lookup it has already done in words.
   */
  required: [
    "serviceName",
    "serviceId",
    "addonNames",
    "addonIds",
    "quantity",
    "date",
    "time",
    "newDate",
    "newTime",
  ],
  properties: {
    serviceName: {
      type: ["string", "null"],
      description: "The service they asked for, named as the price list names it.",
    },
    serviceId: {
      type: ["integer", "null"],
      description: "The id of that service, or null if the message names none.",
    },
    addonNames: {
      type: "array",
      items: { type: "string" },
      description: "Every extra they asked for, named as the price list names it.",
    },
    addonIds: {
      type: "array",
      items: { type: "integer" },
      description:
        "One id for each name above, in the same order. Never leave this empty when addonNames is not.",
    },
    quantity: { type: "integer", description: "How many people. 1 unless they say." },
    date: { type: ["string", "null"], description: "YYYY-MM-DD" },
    time: { type: ["string", "null"], description: "HH:mm, 24-hour" },
    newDate: {
      type: ["string", "null"],
      description: "For a move: the day they want to move to.",
    },
    newTime: { type: ["string", "null"] },
  },
} as const;
