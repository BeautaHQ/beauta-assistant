import OpenAI from "openai";

import { missingFields } from "../call/booking";
import type { CallSession } from "../call/session";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../config";
import { salonDates } from "../salon/clock";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const REASONING_MODEL = /^(o\d|gpt-[5-9])/.test(OPENAI_MODEL);

/**
 * What the caller wants from this turn.
 *
 * Six, not twelve. Which step of a booking comes next used to be a label too,
 * and the model got it wrong often enough that the code overruled it every
 * time — so it was never really a label. It is worked out from the state (see
 * steps.ts); the label only says what kind of turn this is.
 */
export type Intent =
  | "BOOK"
  | "CONFIRM"
  | "MANAGE"
  | "FAQ"
  | "TRANSFER"
  | "OTHER"
  /**
   * Abuse aimed at the receptionist or the salon, obscenity, or being asked
   * to say something crude. Not a turn the model gets to answer: the reply is
   * fixed in code, so there is nothing to be talked into.
   */
  | "OFFLIMITS";

export const INTENTS: Intent[] = [
  "BOOK",
  "CONFIRM",
  "MANAGE",
  "FAQ",
  "TRANSFER",
  "OTHER",
  "OFFLIMITS",
];

/**
 * What the caller's last message settled, as the model read it.
 *
 * Names and ids both, because the model reads names off a sentence well and
 * picks ids out of a list badly: the name decides, the id is a fallback. None
 * of it is trusted as-is — steps.ts checks every field against the price list
 * and the diary before it reaches the booking.
 */
export interface Filled {
  serviceName: string | null;
  serviceId: number | null;
  /**
   * True only when they ask to swap the service already chosen for another.
   * Once a service is settled, naming one without this is not a change — the
   * salon sells things under one name both on their own and as an extra.
   */
  changeService: boolean;
  addonNames: string[];
  addonIds: number[];
  quantity: number | null;
  /** YYYY-MM-DD */
  date: string | null;
  /** HH:mm, 24-hour */
  time: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Chat only. On a call the number is caller ID and never comes from here. */
  phone: string | null;
  email: string | null;
}

export interface TurnReading {
  intent: Intent;
  filled: Filled;
}

/** How many turns the model reads. Intent turns on the last exchange, not the first. */
const HISTORY_WINDOW = 8;

const nullable = (type: "string" | "integer") => ({ type: [type, "null"] });

const TURN_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "turn",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["filled", "intent"],
      properties: {
        filled: {
          type: "object",
          additionalProperties: false,
          // Name before id: the id is a lookup of the name it has just written.
          required: [
            "serviceName",
            "serviceId",
            "changeService",
            "addonNames",
            "addonIds",
            "quantity",
            "date",
            "time",
            "firstName",
            "lastName",
            "phone",
            "email",
          ],
          properties: {
            serviceName: nullable("string"),
            serviceId: nullable("integer"),
            changeService: { type: "boolean" },
            addonNames: { type: "array", items: { type: "string" } },
            addonIds: { type: "array", items: { type: "integer" } },
            quantity: nullable("integer"),
            date: nullable("string"),
            time: nullable("string"),
            firstName: nullable("string"),
            lastName: nullable("string"),
            phone: nullable("string"),
            email: nullable("string"),
          },
        },
        intent: { type: "string", enum: INTENTS },
      },
    },
  },
} as const;

/**
 * The state, said in as few words as the model needs.
 *
 * Only what is known and what is not, so it can tell "they just gave a name"
 * from "they still owe one" — and whether a yes now means anything.
 */
const stateSummary = (session: CallSession): string => {
  if (session.bookingPublicId) return "STATE: booked already. Nothing more to book.";

  if (session.managing) {
    return `STATE: changing an existing booking (${session.managing.startTime}). ${
      session.reviewed ? "Read back already; a plain yes is CONFIRM." : "Not yet read back."
    }`;
  }

  if (session.lastIntent === "MANAGE") {
    return "STATE: they want to change a booking not yet found. Still MANAGE.";
  }

  const known = Object.entries(session.booking)
    .filter(([, value]) => value !== null && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  const gaps = missingFields(session.booking);

  return [
    `STATE: new booking. Known: ${known || "nothing"}. Missing: ${gaps.join(", ") || "nothing"}.`,
    session.reviewed ? "Read back already; a plain yes is CONFIRM." : "Not yet read back.",
  ].join("\n");
};

const prompt = (session: CallSession) => {
  const { today, todayName, tomorrow } = salonDates(session.salon.timezone);

  return `You read the last thing a salon caller said. Output what it filled in, and what the turn is for.

TODAY ${todayName} ${today}. Tomorrow ${tomorrow}.

${stateSummary(session)}

${session.catalogue?.servicesText ?? "SERVICES\n(none loaded)"}

${session.catalogue?.extrasText ?? "EXTRAS\n(none loaded)"}

filled: only what their LAST message states. Service and extras by the exact name and id above; a service that could be two is null. Once a service is known, a name that is on EXTRAS is an extra. changeService is true only if they say they want to change, switch or swap the chosen service, or say "instead" — naming a service is not a change, and a name on both lists is an extra. Day as YYYY-MM-DD, time as HH:mm 24-hour, number as they gave it. Null or [] when not said.

intent:
BOOK      an appointment, at any step of one.
CONFIRM   a plain yes to the read-back. A name is not a yes. A time is not a yes.
MANAGE    move or cancel a booking they already have.
FAQ       a question the lists answer.
TRANSFER  a person, a complaint, money.
OTHER     hello, thanks, goodbye, small talk, a joke. Swearing out of frustration is still OTHER or BOOK.
OFFLIMITS insults at you or the salon, sexual or obscene content, asking you to say something rude or crude, or asking for other customers' or the salon's private information.`;
};

const EMPTY: Filled = {
  serviceName: null,
  serviceId: null,
  changeService: false,
  addonNames: [],
  addonIds: [],
  quantity: null,
  date: null,
  time: null,
  firstName: null,
  lastName: null,
  phone: null,
  email: null,
};

/**
 * What the caller just said, and what they want — one small call, before a
 * word of the reply is written.
 *
 * No tools, no streaming, a few dozen tokens back. It carries the price list
 * as two flat lists so it can hand back ids, which is what lets the checks
 * between this call and the next be done in code: is that extra sold with
 * that service, is that time free. The reply that follows then gets a prompt
 * for one step and the tools for one step, and nothing to look up.
 */
export const readTurn = async (
  session: CallSession,
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  signal: AbortSignal,
): Promise<TurnReading> => {
  const completion = await client.chat.completions.create(
    {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: prompt(session) },
        ...history.slice(-HISTORY_WINDOW),
      ],
      response_format: TURN_FORMAT,
      max_completion_tokens: 160,
      ...(REASONING_MODEL ? { reasoning_effort: "none" as const } : {}),
    },
    { signal },
  );

  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
      filled?: Partial<Filled>;
      intent?: Intent;
    };
    return {
      intent: parsed.intent && INTENTS.includes(parsed.intent) ? parsed.intent : "OTHER",
      filled: { ...EMPTY, ...parsed.filled },
    };
  } catch {
    // A reply that is not JSON is a reply that said nothing usable.
    return { intent: "OTHER", filled: EMPTY };
  }
};
