/**
 * Every word the model is told, in one place.
 *
 * Two pieces, sent at opposite ends of the conversation. The system prompt is
 * built for the turn: who the salon is, how to speak, the roadmap, and what
 * this one turn is for — nothing about the other kinds of turn it is not. The
 * briefing is rebuilt each turn and goes in last, after the transcript,
 * because the last thing a model reads carries the most weight.
 *
 * The model no longer writes the booking; it only reads it. What the caller
 * said is taken down and checked in code before this prompt is built (see
 * steps.ts), so the briefing is current, not a turn behind, and the reply has
 * nothing to look up and nothing to record — only the next question to ask.
 */
import { missingFields } from "../call/booking";
import type { CallSession } from "../call/session";
import { salonDates } from "../salon/clock";
import { describeOffer } from "../salon/slots";
import type { Intent } from "./intent";
import type { Step } from "./steps";

/**
 * How to write a time, which is the one thing the two channels cannot share.
 *
 * On the phone the words are read aloud, and a speech engine makes a mess of
 * "13:40". In writing the opposite holds: digits are read at a glance and are
 * unambiguous, where spelled-out times hide mistakes.
 */
const timeStyle = (channel: CallSession["channel"]) =>
  channel === "CHAT"
    ? `THE CHANNEL
Chat. They read you and can scroll back. Clock times as digits with am/pm — 1:40 PM, never words. Dates the way a person says them, "Tuesday 22 September".`
    : `THE CHANNEL
A phone call, spoken aloud, no scrolling back. Times the way people say them — "two o'clock", "quarter past three" — never "13:40".`;

/**
 * The steps, in order, for the channel.
 *
 * A phone call already knows the number — it is the caller ID — so there is no
 * step for it. Listed anyway, the model asked for it.
 */
const roadmap = (channel: CallSession["channel"]) =>
  channel === "CHAT"
    ? "1 service · 2 extras and how many people · 3 day · 4 time · 5 name · 6 number · 7 read it all back · 8 book, only after their yes."
    : "1 service · 2 extras and how many people · 3 day · 4 time · 5 name · 6 read it all back · 7 book, only after their yes.";

/**
 * What one step of a booking asks for. One block per step, nothing about the
 * others. Written as the move to make, not as a rule to obey.
 */
const STEP: Record<Step, string> = {
  SERVICE: `THIS TURN
Settle the service. If what they said could be two on the list, offer the two. If they named none, ask what they would like.`,

  ADDONS: `THIS TURN
Name two or three of this service's extras (in the briefing) with prices, and ask how many people it is for. One question.`,

  DAY: `THIS TURN
Ask which day suits them.`,

  TIME: `THIS TURN
Every free time for the day is in the briefing. Read it and tell them what the day looks like — where it is open, where it is taken — then ask what time suits. If the time they asked for was not free, say so and say what is near it. A run of free times may be said as a range; a gap must not be. Day full: offer the waitlist or another day.`,

  INFO: `THIS TURN
Ask for the first thing STILL MISSING in the briefing, and only that.`,

  REVIEW: `THIS TURN
Read the booking back exactly as the briefing has it — service, extras, people, day, time, name; nothing from the conversation that is not there — and ask them to confirm. "I have you down for", never "booked". Set readBack true.`,

  BOOK: `THIS TURN
They said yes. Call create_booking now. Then say it is done and say goodbye.`,
};

/** What a turn that is not a booking step does. */
const TURN: Record<Exclude<Intent, "BOOK">, string> = {
  CONFIRM: `THIS TURN
They said yes. Call the tool. Then say it is done.`,

  MANAGE: `THIS TURN
They are changing a booking they have. The briefing says what is found and what to do next. Only the day and time change; for a new time, check_availability first.`,

  TRANSFER: `THIS TURN
Say you are putting them through, then call transfer_to_staff.`,

  FAQ: `THIS TURN
Answer from the price list in one or two sentences. If it leads to a booking, offer it.`,

  OTHER: `THIS TURN
Hello, thanks, goodbye, small talk, a joke. One line, warm, then back to the step the briefing is on. On goodbye, say it back and set endCall true.`,

  // Never reaches the model: the reply to an off-limits turn is fixed in code.
  OFFLIMITS: `THIS TURN
Keep it about the salon.`,
};

/**
 * Short on purpose. A phone caller cannot skim, so anything said has to be
 * short enough to hold in the ear.
 *
 * The roadmap is stated once and the briefing says where on it the call is;
 * the model works out the question from the two. The price list goes in only
 * where it is read: the services alone to settle which, the whole list to
 * answer a question.
 */
export const systemPrompt = (session: CallSession, intent: Intent, step: Step | null) => {
  const { today, todayName, tomorrow, tomorrowName } = salonDates(session.salon.timezone);

  const list =
    step === "SERVICE"
      ? `\n${session.catalogue?.servicesText ?? ""}\n`
      : intent === "FAQ"
        ? `\nPRICE LIST\n${session.catalogue?.flatText ?? ""}\n`
        : "";

  const turn = step ? STEP[step] : TURN[intent as Exclude<Intent, "BOOK">];

  return `You are the receptionist for ${session.salon.name}, a nail and beauty salon.

TODAY
${todayName} ${today}. Tomorrow is ${tomorrowName} ${tomorrow}. Timezone ${session.salon.timezone}. Relative days count from today.

${timeStyle(session.channel)}

HOW TO SPEAK
One or two short sentences, then stop. Only facts from the briefing, the price list or a tool. Do things, never announce them. Never read a reference out. Never ask for anything the briefing already has.
If the briefing says DROPPED or NOT FREE, say that first.

THE ROADMAP — in this order; the briefing says where you are.
${roadmap(session.channel)}
${list}
${turn}

ANSWER
say: the words only. readBack: true only if you read the whole booking back this turn. endCall: true only after goodbye.`;
};

/**
 * The model answers in this shape rather than free text. `strict` makes the
 * schema a guarantee, not a request. `say` leads because it is streamed to
 * the caller as it arrives.
 */
export const REPLY_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "receptionist_reply",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["say", "readBack", "endCall"],
      properties: {
        say: { type: "string", description: "Exactly what to speak aloud to the caller." },
        readBack: {
          type: "boolean",
          description: "True only if this turn read the whole booking back to them.",
        },
        endCall: {
          type: "boolean",
          description: "True only after saying goodbye on a finished call.",
        },
      },
    },
  },
} as const;

/** What to do about a gap, one line each. */
const NEXT_STEP: Record<string, string> = {
  service: "ask which, offering the choice if two fit",
  "extras and how many people": "offer the extras above with prices and ask how many people",
  date: "ask which day",
  time: "describe the free times above and ask what suits",
  "full name": "first and last name",
  "phone number": "",
  confirmation: "read it all back and ask them to confirm; set readBack true",
};

const step = (gap: string, session: CallSession): string => {
  if (gap !== "phone number") return NEXT_STEP[gap] ?? "";
  return session.channel === "CHAT"
    ? "the number to reach them on, and their email if they want the confirmation — email optional"
    : "the number to reach them on";
};

/**
 * What the diary said, if it has been asked.
 *
 * It is asked in code, only once the service and its extras are settled, so
 * the line says which of those it is: not yet, unreachable, full, this time is
 * free, or here are the free times.
 */
const diaryLine = (session: CallSession): string => {
  const { booking, offered } = session;
  if (!booking.serviceId || booking.quantity === null || !booking.date) {
    return "diary: not asked yet — the service and extras come first";
  }
  if (!offered) return "diary: could not be reached — say so and offer to take a message";
  if (offered.slots.length === 0) return `diary: ${offered.date} is full — offer the waitlist or another day`;
  if (booking.time && offered.slots.includes(booking.time)) {
    return `diary: ${booking.time} on ${offered.date} is free`;
  }
  return `diary: free on ${offered.date} — ${describeOffer(offered.slots)}`;
};

/**
 * The state, written out for the model, fed in fresh every turn.
 *
 * Current, not a turn behind: what the caller just said has already been
 * taken down and checked by the time this is built.
 */
export const briefing = (session: CallSession): string => {
  const { booking } = session;

  if (session.managing) {
    const held = session.managing;
    return `THEIR EXISTING BOOKING — they are changing this, not making a new one.
${held.serviceName ?? "service"}${held.addonNames.length > 0 ? ` with ${held.addonNames.join(", ")}` : ""}, ${held.quantity} ${held.quantity === 1 ? "person" : "people"}, currently ${held.startTime}, under ${held.firstName} ${held.lastName}.
Only the day and the time change.
${
  session.reviewed
    ? "Read back already. A yes now means do it: call reschedule_booking or cancel_booking."
    : "Read it back — what it is, when, and what they want done — set readBack true, and wait for their yes. A question is not a yes."
}
Never call create_booking.`;
  }

  if (session.lastIntent === "MANAGE" && !session.bookingPublicId) {
    return `THEY ARE CHANGING AN EXISTING BOOKING, not making one.
To find it you need two things only: the number they are calling from, said aloud, and the day it is on. Ask for whichever is missing, then call find_booking.
Nothing found: say so plainly and ask if it might be another day.
Do not ask which service, do not settle a service or day, and do not call check_availability until it is found.`;
  }

  if (session.bookingPublicId) {
    return `BOOKING SO FAR
Booked already, reference ${session.bookingPublicId}. Done — never book again. Answer anything else, then say goodbye and set endCall.`;
  }

  const service = booking.serviceId
    ? session.catalogue?.serviceById.get(booking.serviceId)
    : undefined;
  const extrasOnOffer = booking.serviceId
    ? (session.catalogue?.addonsByService.get(booking.serviceId) ?? [])
    : [];

  const lines = [
    "BOOKING SO FAR",
    `service: ${service ? `${service.name} $${service.price}, ${service.durationMinutes} min` : "not settled"}`,
    `extras: ${booking.addonNames.length > 0 ? booking.addonNames.join(", ") : booking.quantity === null ? "not asked yet" : "none"}`,
    `people: ${booking.quantity ?? "not asked yet"}`,
    `day: ${booking.date ?? "not settled"} · time: ${booking.time ?? "not settled"}`,
    `name: ${[booking.firstName, booking.lastName].filter(Boolean).join(" ") || "not given"}`,
    session.channel === "PHONE"
      ? `phone: ${session.phone} (caller ID, never ask)`
      : `phone: ${booking.phone ?? "not given"} · email: ${booking.email ?? "not given"}`,
  ];

  if (booking.serviceId) {
    lines.push(
      extrasOnOffer.length === 0
        ? "extras for this service: none"
        : `extras for this service: ${extrasOnOffer.map((a) => `${a.name} $${a.price}`).join("; ")}`,
    );
  }
  if (session.rejectedAddons.length > 0) {
    lines.push(
      `DROPPED: ${session.rejectedAddons.join(", ")} — not offered with this service. Say so and offer what is above.`,
    );
  }

  lines.push(diaryLine(session));
  if (session.rejectedTime) {
    lines.push(`NOT FREE: ${session.rejectedTime}. Say so and offer the nearest of the times above.`);
  }
  if (session.waitlisted) lines.push("they are already on the waitlist");

  const gaps = missingFields(booking);
  lines.push("");
  if (gaps.length === 0) {
    lines.push("Nothing is missing. Call create_booking now.");
  } else if (session.reviewed && gaps.length === 1 && gaps[0] === "confirmation") {
    lines.push("Read back already; only their yes is missing. Do not read it back again.");
  } else {
    lines.push(
      "STILL MISSING, in order — ask for the first:",
      ...gaps.map((gap, index) => `${index + 1}. ${gap}: ${step(gap, session)}`),
    );
  }

  return lines.join("\n");
};
