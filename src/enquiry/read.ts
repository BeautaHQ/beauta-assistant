import OpenAI from "openai";

import { OPENAI_API_KEY, OPENAI_MODEL } from "../config";
import { nameKey, type Catalogue } from "../salon/catalogue";
import { salonDates } from "../salon/clock";
import type { Salon } from "../salon/lookup";
import { ACTION_SCHEMA, type EnquiryAction, type EnquiryIntent } from "./action";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/* See the note in receptionist/index.ts: the reasoning models refuse function
 * tools and cost a caller silence. Nothing is streamed here, but reasoning
 * tokens are still paid for, and an enquiry is one short message. */
const REASONING_MODEL = /^(o\d|gpt-[5-9])/.test(OPENAI_MODEL);

/**
 * The enquiry, as the assistant reads it.
 *
 * One pass, no conversation: an enquiry is a single message from someone who
 * is not waiting on the line, so there is nothing to ask them and nothing to
 * stream. That is why this is nothing to do with the receptionist — it shares
 * the price list and the clock, and not one line else.
 */
export interface Reading {
  intent: EnquiryIntent;
  /** A reply the salon may send as it stands, or edit. Never sent for them. */
  draft: string;
  action: EnquiryAction;
}

const prompt = (salon: Salon, catalogue: string) => {
  const { today, todayName, tomorrow } = salonDates(salon.timezone);

  return `You read messages customers send to ${salon.name}, a nail salon.

TODAY
${todayName} ${today}. Tomorrow is ${tomorrow}. Timezone ${salon.timezone}.
Dates as YYYY-MM-DD, counted from today.

PRICE LIST
Services, then extras. These ids are the only real ones. Any extra goes with any service.

${catalogue}

INTENT
BOOKING     an appointment they do not have yet.
RESCHEDULE  move one they have.
CANCEL      call one off.
FAQ         a question you can answer - price, duration, what is offered, hours.
OTHER       anything else.
ERROR       the message makes no sense at all.

THE ACTION
Only what the message says. Nothing mentioned, the field stays null.
Exactly one service - the first thing they ask for, id from SERVICES. Everything else goes in addonNames in their own words, even when the price list has no such thing; give its id from EXTRAS where it does.
serviceId is null only when the wording pins down no service at all.
RESCHEDULE: date and time are the appointment they have, newDate and newTime where it goes.
CANCEL: date and time are the appointment to call off.

THE DRAFT
As the salon, to the customer, ready to send. Warm, three or four sentences, no subject line, no signature.
Answer what they asked. If one thing is missing, ask for that one thing.
Never promise a time. Never invent a price or a service.`;
};

const REPLY_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "enquiry_reading",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "draft", "action"],
      properties: {
        intent: {
          type: "string",
          enum: ["BOOKING", "RESCHEDULE", "CANCEL", "FAQ", "OTHER", "ERROR"],
        },
        draft: { type: "string" },
        action: ACTION_SCHEMA,
      },
    },
  },
} as const;

/**
 * The service the message named, as an id the diary will accept.
 *
 * The name it wrote wins over the number it wrote. Reading a service out of a
 * sentence is what the model is for; finding that name's row in a price list is
 * not, and it gets the second wrong often enough to matter — naming DELUXE
 * PEDICURE and handing back the id sitting next to it. A name matching nothing
 * falls back to the id, which is still checked for being real.
 */
const resolveService = (
  action: Partial<EnquiryAction> | undefined,
  catalogue: Catalogue | null,
): number | null => {
  const byName = action?.serviceName
    ? catalogue?.serviceIdByName.get(nameKey(action.serviceName))
    : undefined;
  if (byName !== undefined) return byName;

  return action?.serviceId && catalogue?.serviceIds.has(action.serviceId)
    ? action.serviceId
    : null;
};

/**
 * The extras it named, split into the ones this salon sells and the ones it does not.
 *
 * Nothing here cares which service an extra is listed under: somebody asking
 * for a manicure and a pedicure extra in one message is asking for exactly
 * that, and whether the salon does the two together is their business.
 *
 * What does matter is a name that matches nothing. That is a second service the
 * salon does not also sell as an extra, so no single appointment covers what
 * was asked. Dropping it silently would book half the message and say nothing,
 * so it comes back by name and the reading is marked ERROR.
 */
const resolveAddons = (
  action: Partial<EnquiryAction> | undefined,
  catalogue: Catalogue | null,
): { addonIds: number[]; addonNames: string[]; unavailable: string[] } => {
  const names = action?.addonNames ?? [];
  const ids = action?.addonIds ?? [];

  const addonIds: number[] = [];
  const addonNames: string[] = [];
  const unavailable: string[] = [];

  names.forEach((name, index) => {
    const paired = ids[index];
    const id =
      catalogue?.addonIdByName.get(nameKey(name)) ??
      (paired !== undefined && catalogue?.addonIds.has(paired) ? paired : null);

    if (id === null || id === undefined) {
      unavailable.push(name);
      return;
    }
    if (addonIds.includes(id)) return;

    addonIds.push(id);
    // The salon's own spelling, not the customer's. These two lists are read
    // side by side and have to line up.
    addonNames.push(catalogue?.addonNameById.get(id) ?? name);
  });

  return { addonIds, addonNames, unavailable };
};

export const readEnquiry = async (
  salon: Salon,
  catalogue: Catalogue | null,
  enquiry: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    message: string;
  },
): Promise<Reading> => {
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: prompt(salon, catalogue?.flatText ?? "") },
      {
        role: "user",
        content: `From ${enquiry.firstName} ${enquiry.lastName}:\n\n${enquiry.message}`,
      },
    ],
    response_format: REPLY_FORMAT,
    max_completion_tokens: 700,
    ...(REASONING_MODEL
      ? { reasoning_effort: "none" as const }
      : { temperature: 0.3 }),
  });

  const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
    intent?: EnquiryIntent;
    draft?: string;
    action?: Partial<EnquiryAction>;
  };

  const { addonIds, addonNames, unavailable } = resolveAddons(
    parsed.action,
    catalogue,
  );

  return {
    /*
     * Something on the price list is missing, so whatever the model decided the
     * message was, the salon cannot act on it in one click. Saying BOOKING here
     * would put a green button in front of them that books the wrong thing.
     */
    intent: unavailable.length > 0 ? "ERROR" : (parsed.intent ?? "OTHER"),
    draft: parsed.draft ?? "",
    action: {
      serviceId: resolveService(parsed.action, catalogue),
      serviceName: parsed.action?.serviceName ?? null,
      /*
       * Only what the salon actually sells. A name that matched nothing is not
       * an extra of theirs, so it has no id and no business in either list —
       * it goes in unavailable, where it is the reason this reads as ERROR.
       */
      addonIds,
      addonNames,
      unavailable,
      quantity: parsed.action?.quantity && parsed.action.quantity > 0
        ? parsed.action.quantity
        : 1,
      date: parsed.action?.date ?? null,
      time: parsed.action?.time ?? null,
      newDate: parsed.action?.newDate ?? null,
      newTime: parsed.action?.newTime ?? null,
      // From the enquiry's own fields. The message is not asked for these:
      // whoever typed it already filled the form in.
      firstName: enquiry.firstName,
      lastName: enquiry.lastName,
      email: enquiry.email,
      phone: enquiry.phone,
    },
  };
};
