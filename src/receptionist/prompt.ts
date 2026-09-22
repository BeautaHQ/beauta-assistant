/**
 * Every word the model is told, in one place.
 *
 * Two pieces, sent at opposite ends of the conversation. The system prompt is
 * fixed for the call: who the salon is, what it sells, how to speak. The
 * briefing is rebuilt each turn and goes in last, after the transcript, because
 * the last thing a model reads carries the most weight — and what it keeps
 * getting wrong is running ahead of what the caller has actually said.
 *
 * It lives apart from both the call state and the streaming loop. Kept inside
 * the state, prose crept into a module whose job was to hold facts; kept inside
 * the loop, the wording of a question sat in the middle of stream handling.
 */
import { BOOKING_SCHEMA, missingFields } from "../call/booking";
import type { CallSession } from "../call/session";
import type { KnowledgeImage } from "../salon/knowledge";
import { salonDates } from "../salon/clock";
import { describeOffer } from "../salon/slots";

/**
 * How to write a time, which is the one thing the two channels cannot share.
 *
 * On the phone the words are read aloud, and a speech engine makes a mess of
 * "13:40". In writing the opposite holds: digits are read at a glance and are
 * unambiguous, where spelled-out times hide mistakes. A customer who typed
 * "1.40pm" was answered "two o'clock is available" and had to argue — in
 * digits the misreading would have been obvious on sight.
 */
const timeStyle = (channel: CallSession["channel"]) =>
  channel === "CHAT"
    ? `THE CHANNEL
This is a chat window. They are reading you, not hearing you, and they can scroll back.
Write every clock time as digits with am or pm — 1:40 PM, 9:00 AM, 3:30 PM — never spelled out in words. When they give you a time, put it back to them in digits before you act on it, so a misreading is caught while it still costs nothing.
Dates are the exception: write those the way a person would, "Tuesday 22 September", never "2026-09-22". The YYYY-MM-DD form is for the tools, not for anyone reading.`
    : `THE CHANNEL
This is a phone call. Every word you write is spoken aloud, and the caller cannot scroll back.
Say times the way people say them — "two o'clock", "quarter past three", "ten past two" — never "13:40", which a speech engine reads badly.`;

/**
 * Short on purpose. A phone caller cannot skim, so anything said has to be
 * short enough to hold in the ear — paragraphs that read fine on screen are
 * unbearable read aloud.
 *
 * The price list is pasted in whole rather than looked up. It costs about a
 * thousand tokens on a prompt that caches, and it buys back a tool round of
 * silence at the start of every call plus the ids the model used to guess at.
 */
export const systemPrompt = (session: CallSession) => {
  const { today, todayName, tomorrow, tomorrowName } = salonDates(session.salon.timezone);
  const catalogue = session.catalogue?.text ?? "";

  return `You are the receptionist for ${session.salon.name}, a nail and beauty salon.

TODAY
${todayName} ${today}. Tomorrow is ${tomorrowName} ${tomorrow}. The salon runs on ${session.salon.timezone}.
Relative days count from today, never from a date mentioned earlier in the conversation.

${timeStyle(session.channel)}

HOW TO SPEAK
One or two short sentences, then stop and let them reply.
Everything you state comes from the price list or a tool. Never invent a price, a time, or a staff name.
Never say you are about to do something. Do it, then say what you found.
Never read a booking reference out.

PRICE LIST
These ids are the only real ones. Extras are listed under the service they belong to and go with no other.

${catalogue}
${photos(session)}
THE STEPS
1 service · 2 extras and how many people · 3 the day · 4 the time · 5 their name · 6 their number · 7 read it back, and label that turn REVIEW · 8 book it.
Nothing books until a turn labelled REVIEW has happened, whatever else you have.
Extras and the number of people come before the diary: both change how long the appointment takes and how many staff it needs.
One step per turn — but if their answer finishes a step, take it and do the next in the same breath. Never ask twice for something you have been told.

INTENT — decide it before you write a word.
CLARIFY   more than one service could be meant — two removals, two manicures, natural or extensions — so ask, even when one seems likelier. Only when a single service can possibly be meant do you take it yourself and say which one and what it costs.
ADDONS    offer the extras under that service and ask how many people. One turn, and take no for an answer.
CHECK_AVAILABILITY  they named or changed a day or a time. Call check_availability this turn. A time they name is a time to check, not a time to accept.
ASK_SLOT  you already have that day's times and are telling them about them. They come in ten-minute steps, so never describe them as a range: "nine to half past six" promises times that do not exist, and quarter past eleven is not one of them.
ASK_INFO  asking for their name, then their number.
REVIEW    reading the whole booking back — service, extras, people, day, time, name — and asking them to confirm. This never books.
CONFIRM   they have just said yes to what you read back. Only now call create_booking. A name is not a yes; a choice of time is not a yes.
MANAGE    moving or cancelling a booking they already have. Phone only: ask their number and which day it is on, then call find_booking. A move changes only the day and time.
TRANSFER  they want a person, or it is beyond you — a complaint, money, anything the price list and the diary cannot answer. Say you are putting them through, then call transfer_to_staff.
FAQ       a question you can answer from the price list, or from anything else the salon has on file — where to park, what a colour looks like.
OTHER     hello, thanks, goodbye, anything else.

WHEN IT GOES WRONG
A tool fails: say you cannot reach the diary, and offer to take a message.
The day is full: say so and offer the waitlist or another day. Never pretend a time exists.
They ask for a person: put them through. Do not talk them out of it.

YOUR ANSWER
"say" is the words themselves — no labels, no markdown, no stage directions.
"booking" carries everything known so far; leave a field null only while it is genuinely unknown.
"endCall" is true only after you have said goodbye, and never in the same breath as a question.`;
};

/**
 * The salon's photos, offered to the model as notes and ids.
 *
 * Chat only, and only when there are any. A photo cannot be shown down a phone
 * line, and a section listing nothing is a section the model reads past on
 * every turn of every call.
 *
 * The notes are all it gets. It is a text model and these are photographs, so
 * what a question is matched against is what the salon wrote about each one —
 * that, and an id, which is short enough to hand back without the copying
 * mistakes a URL invites. The address never goes near the model: the id is
 * resolved on this side afterwards, so a customer can only ever be shown a
 * photo this salon actually uploaded.
 */
const photos = (session: CallSession): string => {
  if (session.channel !== "CHAT" || session.knowledgeImages.length === 0) return "";

  const lines = session.knowledgeImages
    .map((image: KnowledgeImage) => `${image.id}: ${image.note}`)
    .join("\n");

  return `
PHOTOS
The salon has these photos on file. You cannot see them; this is what it wrote about each one.

${lines}

On a FAQ turn, and only then, put the id of a photo in "imageIds" when it genuinely answers what was asked — the customer is shown it beside your words. Still answer in words: a picture on its own is not an answer.
One is almost always enough. Send none rather than one that is merely on the same subject, and never send an id that is not on this list — it shows nothing.
`;
};

/**
 * The model answers in this shape rather than free text, so the reply is
 * already structured when it arrives instead of being guessed at afterwards.
 * `strict` makes the schema a guarantee, not a request.
 *
 * Built per conversation rather than fixed, because `imageIds` only exists
 * where photos do. `strict` requires every declared property to come back, so
 * declaring it on a phone call would have the model filling in a field with
 * nothing to put in it and nobody to show it to.
 */
export const replyFormat = (session: CallSession) => {
  const photoSection = photos(session);

  return {
    // Narrowed, where the whole object used to be `as const`: the rest of it is
    // now built per conversation, and only this has to stay a literal for the
    // SDK to recognise the shape.
    type: "json_schema" as const,
    json_schema: {
      name: "receptionist_reply",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        /*
         * The order is the point, not decoration.
         *
         * Structured output is generated field by field in the order declared
         * here, so whatever comes first is what the rest is written against.
         * With `say` first the model wrote the whole sentence and only then
         * labelled it — and since `say` is streamed straight to the caller as it
         * arrives, the label could not possibly have steered the words.
         *
         * So intent leads. It is one or two tokens, it costs nothing, and it is
         * the routing a separate classifying call would buy — in the same
         * request, without its second round trip.
         *
         * The booking state stays behind `say`, though it would read better in
         * front of it. Moved ahead, its forty-odd tokens of JSON have to be
         * generated before a single word can be spoken, and first token went from
         * under a second to nearly three. On a phone that is the caller
         * wondering whether the line has dropped.
         */
        required: [
          "intent",
          "say",
          "booking",
          "endCall",
          ...(photoSection === "" ? [] : ["imageIds"]),
        ],
        properties: {
          intent: {
            type: "string",
            enum: [
              "FAQ",
              "CLARIFY",
              "ADDONS",
              "CHECK_AVAILABILITY",
              "ASK_SLOT",
              "ASK_INFO",
              "REVIEW",
              "CONFIRM",
              "MANAGE",
              "TRANSFER",
              "OTHER",
            ],
            description: "What this turn is for. Decided before anything is said.",
          },
          say: {
            type: "string",
            description: "Exactly what to speak aloud to the caller.",
          },
          booking: BOOKING_SCHEMA,
          endCall: {
            type: "boolean",
            description: "True only after saying goodbye on a finished call.",
          },
          /*
           * Last, for the reason `booking` sits behind `say`: nothing declared
           * here may come between the customer and the first word of the reply.
           * An empty array is the common answer, and it costs three tokens.
           */
          ...(photoSection === ""
            ? {}
            : {
                imageIds: {
                  type: "array",
                  items: { type: "integer" },
                  description:
                    "Ids from the PHOTOS list whose photos answer what was just asked. Empty unless this turn is FAQ and one genuinely does.",
                },
              }),
        },
      },
    },
  };
};

/**
 * What to do about a gap, with the one step that differs by channel.
 *
 * An email is worth asking for in writing and not worth a turn out loud:
 * spelling an address down a phone is slow and goes wrong, and the salon
 * already has their number either way.
 */
const step = (gap: string, session: CallSession): string => {
  if (gap !== "phone number") return NEXT_STEP[gap] ?? "";

  return session.channel === "CHAT"
    ? "Ask for the number the salon can ring them on, and for their email if they would like the confirmation sent — the email is optional, so take no for an answer and move straight on. Record whichever they give."
    : "Ask for the number the salon can ring them back on, and record it. Skip this entirely if the booking already has one, and never ask for an email on a call.";
};

/**
 * The extras that belong to the chosen service, and any that were thrown out.
 *
 * Only for the service actually chosen. The price list carries every service's
 * extras, which is the right thing to hand over before one is picked and the
 * wrong thing after: the model has to offer from one short list, not from a
 * hundred and forty five lines.
 *
 * When something was thrown out, the caller has already been told it is coming
 * — so the correction has to reach them, with the real options beside it.
 */
const extrasLines = (session: CallSession): string[] => {
  const { serviceId } = session.booking;
  if (!serviceId) return [];

  const lines: string[] = [];
  const available = session.catalogue?.addonsByService.get(serviceId) ?? [];

  lines.push(
    available.length === 0
      ? "extras for this service: none, it takes no extras"
      : `extras for this service: ${available
          .map((addon) => `${addon.id}:${addon.name} $${addon.price}`)
          .join("; ")}`,
  );

  if (session.rejectedTime) {
    lines.push(
      `NOT A REAL TIME: ${session.rejectedTime} is not one the diary offers — times run in ten-minute steps. It has been taken off the booking. Say so and offer the nearest that are above.`,
    );
  }

  if (session.rejectedAddons.length > 0) {
    lines.push(
      `DROPPED: ${session.rejectedAddons.join(", ")} — not offered with this service, so they are off the booking. Tell the caller, and offer what is above instead.`,
    );
  }

  return lines;
};

/**
 * What is known about the diary, and whether it still applies.
 *
 * The times on hand belong to one date. When the caller moves day — "how about
 * tomorrow?" — they are about yesterday's question, and saying "already
 * checked, do not check again" next to a date that has just changed stalled the
 * receptionist: it announced it would check, then did nothing, and the caller
 * sat in silence until they prompted it again.
 */
const availabilityLine = (session: CallSession): string => {
  const { offered, booking } = session;
  if (!offered) return "availability: not checked yet";

  const times = describeOffer(offered.slots);
  const staleDate = booking.date !== null && booking.date !== offered.date;
  const staleService =
    booking.serviceId !== null && booking.serviceId !== offered.serviceId;

  if (staleDate || staleService) {
    return `the times you have are for ${offered.date}${
      staleService ? " and a different service" : ""
    }, which is no longer what the caller wants — call check_availability for ${
      booking.date ?? "the day they want"
    } now, in this turn`;
  }

  return `free on ${offered.date}: ${times} — already checked, do not check ${offered.date} again`;
};

/**
 * What to actually do about each gap.
 *
 * "Ask for the date" on its own was read as an instruction to keep asking, even
 * after the caller had answered — so each gap names the move that closes it
 * instead.
 */
const NEXT_STEP: Record<string, string> = {
  "extras and how many people":
    "Name the extras listed under the service they chose — with their prices — and ask in the same breath whether it is just for them. Record any they want in addonIds and addonNames, and the number of people in quantity; if they want no extras, leave addonIds empty and still set quantity, which is how this step is marked done. Do not offer an extra that is not listed under their service.",
  service:
    "Work out which service they mean from the price list and record its id — but only if exactly one fits what they said. If two or more could, that turn is CLARIFY: offer them the choice and leave serviceId null.",
  date: "Settle which day they want and record it as YYYY-MM-DD.",
  time: "Call check_availability for that date, unless you already have its times. Then answer from what it returned: if the time they asked for is free, record it as HH:mm; if it is not, say so. Never tell them a time is theirs before the diary has said it is free.",
  // Rendered per channel; see step() below.
  "phone number": "",
  "full name":
    "If they have just given their name — \"Sarah Nguyen\" is both halves — record firstName and lastName and go straight on to REVIEW in this same turn. Only if you still do not have it, ask for their first and last name, and nothing else; that asking turn is ASK_INFO, and it books nothing.",
  confirmation:
    "Read the whole booking back — the service, any extras, how many people if more than one, the day, the time, and their first and last name — then ask them to confirm. This turn is REVIEW and it does not book. Say \"I have you down for\", never \"I have you booked\": nothing is booked until they say yes, and telling them otherwise is a promise you have not kept.",
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

  /*
   * Someone changing an appointment is not making one, and the two must not be
   * shown at once. Handed the empty new-booking form alongside the one they
   * had found, the model moved the old booking and then started taking details
   * for a new one off the back of the same "yes".
   */
  if (session.managing) {
    const held = session.managing;
    return `THEIR EXISTING BOOKING — they are changing this, not making a new one.
${held.serviceName ?? "service"}${held.addonNames.length > 0 ? ` with ${held.addonNames.join(", ")}` : ""}, ${held.quantity} ${held.quantity === 1 ? "person" : "people"}, currently ${held.startTime}, under ${held.firstName} ${held.lastName}.

The service, the extras and the number of people do not change — only the day and the time.
${
  session.reviewed
    ? "You have read it back to them. A yes now means do it: call reschedule_booking or cancel_booking."
    : "Read it back — what it is and when — with what they want done, and wait for them to say yes. A question like \"could I make it two?\" is them asking, not agreeing."
}
Do not call create_booking. Nothing new is being booked.`;
  }

  /*
   * Still looking. They have said they want to change something but nothing
   * has been found yet, and the new-booking checklist is the wrong thing to
   * put in front of them — it sent the model hunting for a service when what
   * it needed was their number and the time of the appointment they have.
   */
  if (session.lastIntent === "MANAGE" && !session.bookingPublicId) {
    return `THEY ARE CHANGING AN EXISTING BOOKING, not making one.

You need two things to find it, and nothing else: the phone number they are
calling from, said out loud, and the day the appointment is on. Not the exact
time — people remember the day far better than the minute. Ask for whatever is
still missing, then call find_booking.

If nothing comes back, say plainly that you cannot find a booking on that day
for that number, and ask whether it might be a different day.

Do not ask which service it is — the booking knows. Do not settle a service, a
day or extras as though this were a new booking, and do not call
check_availability until the booking has been found.`;
  }

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
    availabilityLine(session),
    ...extrasLines(session),
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
      ...gaps.map((gap, index) => `${index + 1}. ${gap} — ${step(gap, session)}`),
      "",
      "A plain yes to a booking you have just read back is the confirmation: set",
      "confirmed true and call create_booking in that same turn, without asking again.",
      "Never ask for something you have been told, and never check another day unasked.",
    );
  }

  return lines.join("\n");
};
