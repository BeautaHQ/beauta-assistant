import type OpenAI from "openai";

import {
  cancelBooking,
  checkAvailability,
  createBooking,
  findBookings,
  isSlotFree,
  joinWaitlist,
  rescheduleBooking,
} from "../clients/beautaApi";
import { mergeBooking, missingFields } from "../call/booking";
import { offerable } from "../salon/slots";
import type { CallSession } from "../call/session";

/**
 * What the receptionist can actually do, as opposed to talk about.
 *
 * There is no tool for the price list any more — the whole catalogue is in the
 * opening instructions, so the only things left here are the three that change
 * the world.
 */
export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Free start times for a service on one date. Call before offering or confirming any time — never guess what is free. An empty list means the day is full.",
      parameters: {
        type: "object",
        properties: {
          serviceId: { type: "number", description: "An id from the price list" },
          date: { type: "string", description: "YYYY-MM-DD in the salon's timezone" },
          addonIds: { type: "array", items: { type: "number" } },
        },
        required: ["serviceId", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_booking",
      description:
        "Make the booking. Only after the caller has heard the whole thing read back — service, day, time — and said yes. The time must be one check_availability returned.",
      parameters: {
        type: "object",
        properties: {
          serviceId: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string", description: "HH:mm, 24-hour" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          phone: { type: "string", description: "The number to ring them back on" },
          addonIds: { type: "array", items: { type: "number" } },
          callerConfirmed: {
            type: "boolean",
            description:
              "True only if the caller has just said yes to the booking read back to them.",
          },
        },
        required: [
          "serviceId",
          "date",
          "time",
          "firstName",
          "lastName",
          "phone",
          "callerConfirmed",
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_booking",
      description:
        "Find the caller's existing booking so it can be moved or cancelled. Ask them to say their phone number and which day the appointment is on — not the exact time. Phone calls only.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "The number the caller said out loud" },
          date: { type: "string", description: "YYYY-MM-DD the appointment is on" },
        },
        required: ["phone", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_booking",
      description:
        "Cancel the booking found by find_booking. Only after reading it back and hearing them say yes. Takes no arguments: it cancels the one that was found.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_booking",
      description:
        "Move the booking found by find_booking to a new day and time. The service, extras and number of people do not change. Check the new time with check_availability first, as for a new booking.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD they want to move to" },
          time: { type: "string", description: "HH:mm they want to move to" },
        },
        required: ["date", "time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "join_waitlist",
      description:
        "Put the caller on the waitlist for a day that is full, so the salon can ring them if something frees up. Offer this when check_availability comes back empty.",
      parameters: {
        type: "object",
        properties: {
          serviceId: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD they want" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          phone: { type: "string" },
          addonIds: { type: "array", items: { type: "number" } },
        },
        required: ["serviceId", "date", "firstName", "lastName", "phone"],
      },
    },
  },
];

type Args = Record<string, any>;

/**
 * Nothing is moved or cancelled before the caller has heard what it is.
 *
 * Requiring merely a separate turn was not enough: asked "could I make it two
 * o'clock?", the model treated the question as agreement and moved the
 * appointment on the spot. So the same gate the new bookings use applies here
 * — a turn the model itself labelled REVIEW, where it said out loud what it
 * was about to do.
 */
const notReadBackYet = (session: CallSession, verb: string): string | null => {
  if (session.reviewed) return null;
  return refuse(
    "not_read_back",
    `Read the booking out first — what it is, when it is, and what you are about to do to it — and wait for them to say yes. "Could I make it two?" is a question, not a yes, and nothing is ${verb} until they have agreed.`,
  );
};

/**
 * Changing an existing booking happens on the phone or not at all.
 *
 * A call carries caller ID, which is the only evidence here that the person
 * asking is the person who booked. A chat window carries nothing: whoever
 * types a number would be treated as its owner, and cancelling a stranger's
 * appointment would take one lucky guess at a time. So chat is told where to
 * go instead, which is a real answer rather than a refusal.
 */
const onlyOnACall = (session: CallSession, what: string): string | null => {
  if (session.channel === "PHONE") return null;
  return refuse(
    "chat_cannot_manage_bookings",
    `Bookings can only be changed over the phone, so you cannot ${what} here. Tell them to ring the salon, or to use the link in their confirmation email, and offer to help with anything else.`,
  );
};

/** Two numbers written differently. The last nine digits settle it. */
const sameNumber = (a: string | undefined, b: string | undefined) => {
  const digits = (value: string | undefined) => (value ?? "").replace(/\D/g, "").slice(-9);
  const left = digits(a);
  return left.length >= 6 && left === digits(b);
};

/**
 * Extras only exist against the service that lists them.
 *
 * The price list shows them nested under each service, but prose is not a
 * constraint: the same extra appears under a dozen services, and nothing in
 * the wording stops one being attached to a service that does not offer it.
 * beauta-api takes the ids as given, so the booking would simply come out
 * wrong — a price and a duration for something the salon does not do.
 */
const strayAddons = (
  session: CallSession,
  serviceId: number,
  addonIds: number[] | undefined,
): number[] => {
  const allowed = session.catalogue?.addonsByService.get(serviceId);
  if (!allowed) return [];
  const ids = new Set(allowed.map((addon) => addon.id));
  return (addonIds ?? []).filter((id) => !ids.has(id));
};

/** A refusal the model can act on: what was wrong, and what to do instead. */
const refuse = (error: string, note: string, extra: Args = {}) =>
  JSON.stringify({ ok: false, error, note, ...extra });

/**
 * Runs one tool and returns what the model should see.
 *
 * Two things happen here that a prompt alone could not do. Arguments are
 * checked against what the call has actually established — a model that says
 * "gel removal" and books an acrylic full set is stopped here rather than
 * apologised for afterwards. And what a tool learns is written back into the
 * session, so the next turn is briefed on it.
 *
 * Failures come back as text rather than thrown: the caller is on the line, and
 * a receptionist that says it cannot reach the diary and offers to take a
 * message is far better than one that goes silent mid-sentence.
 */
export const runTool = async (
  name: string,
  args: Args,
  session: CallSession,
): Promise<string> => {
  const answer = await dispatch(name, args, session);
  session.toolsThisTurn.push({ name, args, result: answer });
  if (process.env.VOICE_DEBUG) {
    console.error(`  -> ${name}(${JSON.stringify(args)})`);
    console.error(`     ${answer.slice(0, 300)}`);
  }
  return answer;
};

const dispatch = async (
  name: string,
  args: Args,
  session: CallSession,
): Promise<string> => {
  try {
    switch (name) {
      case "check_availability": {
        if (session.catalogue && !session.catalogue.serviceIds.has(args.serviceId)) {
          return refuse(
            "unknown_service",
            "That service id is not on the price list. Use one from the list you were given.",
          );
        }

        /*
         * One day per turn, unless the last one was full. The caller named a
         * day; looking at the two after it is the model running ahead, and it
         * costs a real second of silence each time.
         */
        if (session.checksThisTurn > 0 && session.offered) {
          const sameDay =
            session.offered.date === args.date &&
            session.offered.serviceId === args.serviceId;
          if (sameDay || session.offered.slots.length > 0) {
            return refuse(
              "already_checked",
              sameDay
                ? `You already have the times for ${args.date}. Say them to the caller now — asking again returns the same answer.`
                : `You already have times for ${session.offered.date}. Offer those and let the caller ask for another day.`,
            );
          }
        }
        session.checksThisTurn += 1;

        const stray = strayAddons(session, args.serviceId, session.booking.addonIds);
        if (stray.length > 0) {
          return refuse(
            "addon_not_for_service",
            `Extras ${stray.join(", ")} are not listed under that service. Offer only the ones under it in the price list.`,
          );
        }

        const result = await checkAvailability({
          organizationId: session.salon.organizationId,
          serviceId: args.serviceId,
          date: args.date,
          // From the booking, not from the arguments: the extras and the number
          // of people were settled before the diary was asked anything, and a
          // model that forgets to repeat them would get times for a shorter
          // appointment than the one it is about to make.
          addonIds: session.booking.addonIds,
          quantity: session.booking.quantity ?? 1,
        });

        // Remembered so create_booking can be held to it.
        session.offered = {
          serviceId: args.serviceId,
          date: result.date,
          slots: result.availableSlots,
        };

        return JSON.stringify({
          ok: true,
          date: result.date,
          full: result.availableSlots.length === 0,
          // Every free time, grouped by part of day. Which two or three to
          // actually say is the model's call, not this function's.
          offer: offerable(result.availableSlots),
        });
      }

      case "create_booking": {
        if (session.bookingPublicId) {
          return refuse(
            "already_booked",
            "This caller is already booked. Tell them it is done rather than booking again.",
            { reference: session.bookingPublicId },
          );
        }

        const wanted = mergeBooking(session.booking, {
          serviceId: args.serviceId,
          date: args.date,
          time: args.time,
          firstName: args.firstName,
          lastName: args.lastName,
          phone: args.phone,
          addonIds: args.addonIds ?? [],
          confirmed: args.callerConfirmed === true,
        });

        const strayOnBooking = strayAddons(session, wanted.serviceId!, wanted.addonIds);
        if (strayOnBooking.length > 0) {
          return refuse(
            "addon_not_for_service",
            `Extras ${strayOnBooking.join(", ")} are not listed under that service. Drop them or pick ones that are.`,
          );
        }

        const gaps = missingFields(wanted);
        if (gaps.length > 0) {
          // Keep what the arguments did establish; only the gap is the problem.
          session.booking = wanted;
          return refuse(
            "not_ready",
            `Ask the caller for the ${gaps[0]} first, then book. Do not book yet.`,
            { missing: gaps },
          );
        }

        if (!session.reviewed) {
          return refuse(
            "not_reviewed",
            "Nothing has been read back yet. Take one REVIEW turn first — the service, any extras, the day, the time, their first and last name — and wait for them to say yes. Their name alone is not a yes.",
          );
        }

        /*
         * The check worth the most: the time has to be one the diary gave us,
         * for the service we asked the diary about. It is what stops a
         * plausible-sounding slot the model half-remembers from becoming a real
         * appointment nobody is staffed for.
         */
        const offered = session.offered;
        if (!offered || offered.date !== wanted.date) {
          return refuse(
            "availability_not_checked",
            `Call check_availability for ${wanted.date} first and offer a time it returns.`,
          );
        }
        if (offered.serviceId !== wanted.serviceId) {
          return refuse(
            "service_changed",
            "Availability was checked for a different service. Check it again for this one.",
          );
        }
        if (!offered.slots.includes(wanted.time!)) {
          return refuse(
            "time_not_free",
            `${wanted.time} is not free. Offer one of the times that are, or the waitlist.`,
            { available: offered.slots },
          );
        }

        /*
         * One last look before committing. The list this was checked against
         * may be minutes old by now, and beauta-api would reject the booking
         * anyway — but as an error, which the receptionist can only relay as
         * not being able to reach the diary. Asking first turns that into a
         * sentence the caller can act on.
         */
        const stillFree = await isSlotFree({
          organizationId: session.salon.organizationId,
          serviceId: wanted.serviceId!,
          date: wanted.date!,
          time: wanted.time!,
          addonIds: wanted.addonIds,
          quantity: wanted.quantity ?? 1,
        });

        if (!stillFree?.isAvailable) {
          // The day has moved on, so throw away what we thought we knew.
          session.offered = null;
          return refuse(
            "just_taken",
            `${wanted.time} has gone since you offered it. Say so, check ${wanted.date} again, and offer what is left.`,
          );
        }

        const booking = await createBooking({
          organizationId: session.salon.organizationId,
          firstName: wanted.firstName!,
          lastName: wanted.lastName!,
          phone: wanted.phone!,
          serviceId: wanted.serviceId!,
          addonIds: wanted.addonIds,
          quantity: wanted.quantity ?? 1,
          startTime: `${wanted.date} ${wanted.time}`,
          customerNotes:
            session.channel === "CHAT"
              ? "Booked in chat with the AI receptionist."
              : "Booked by phone with the AI receptionist.",
          source: session.channel === "CHAT" ? "AI_CHAT" : "AI_CALL",
        });

        session.booking = wanted;
        session.bookingPublicId = booking?.bookingPublicId ?? null;

        return JSON.stringify({
          ok: true,
          booked: true,
          reference: session.bookingPublicId,
        });
      }

      case "join_waitlist": {
        if (!args.firstName || !args.lastName) {
          return refuse("not_ready", "Get their first and last name before adding them.");
        }

        // The salon rings back, so the whole day stands for "that day".
        await joinWaitlist({
          organizationId: session.salon.organizationId,
          firstName: args.firstName,
          lastName: args.lastName,
          phone: args.phone ?? session.booking.phone ?? session.phone,
          serviceId: args.serviceId,
          addonIds: args.addonIds ?? [],
          slots: [{ startTime: `${args.date} 09:00`, endTime: `${args.date} 17:00` }],
          notes:
            session.channel === "CHAT"
              ? "Added by the AI receptionist in chat."
              : "Added by the AI receptionist over the phone.",
        });

        session.waitlisted = true;
        session.booking = mergeBooking(session.booking, {
          serviceId: args.serviceId,
          date: args.date,
          firstName: args.firstName,
          lastName: args.lastName,
          phone: args.phone,
        });

        return JSON.stringify({ ok: true, waitlisted: true });
      }

      case "find_booking": {
        const barred = onlyOnACall(session, "find an existing booking");
        if (barred) return barred;

        /*
         * Two locks, and neither is the model's to open.
         *
         * The number they read out has to be the number they are calling from,
         * which is the part that proves who they are; then the day and time
         * have to match a real booking, which is the part that proves they know
         * which one. The query uses caller ID, never the spoken number, so a
         * model that mishears cannot widen the search to someone else.
         */
        if (!sameNumber(args.phone, session.phone)) {
          return refuse(
            "phone_mismatch",
            "That is not the number this call is coming from. Say you can only change a booking from the number it was made on, and offer to take a message.",
          );
        }

        const found = await findBookings({
          organizationId: session.salon.organizationId,
          phone: session.phone,
          date: args.date,
        });

        if (found.length === 0) {
          return refuse(
            "not_found",
            `No booking on ${args.date} for that number. Say so plainly — do not search around it or guess another day. Ask whether the day might be a different one, or offer to take a message.`,
          );
        }

        // A fresh booking to talk about, so the right to act on it starts again.
        session.reviewed = false;

        if (found.length > 1) {
          // Their own day, so listing it is safe, and only they can tell the
          // two apart.
          session.managing = null;
          return JSON.stringify({
            ok: true,
            several: found.map((one) => ({
              at: one.startTime,
              service: one.serviceName,
            })),
            note: "More than one that day. Ask which, then call find_booking again once they have said.",
          });
        }

        session.managing = found[0]!;
        return JSON.stringify({ ok: true, booking: found[0] });
      }

      case "cancel_booking": {
        const barred = onlyOnACall(session, "cancel a booking");
        if (barred) return barred;
        if (!session.managing) {
          return refuse("nothing_found", "Find the booking first with find_booking.");
        }
        const tooSoon = notReadBackYet(session, "cancelled");
        if (tooSoon) return tooSoon;

        await cancelBooking({
          organizationId: session.salon.organizationId,
          bookingPublicId: session.managing.bookingPublicId,
        });

        const cancelled = session.managing;
        session.managing = null;
        return JSON.stringify({ ok: true, cancelled: true, was: cancelled.startTime });
      }

      case "reschedule_booking": {
        const barred = onlyOnACall(session, "move a booking");
        if (barred) return barred;

        const moving = session.managing;
        if (!moving) {
          return refuse("nothing_found", "Find the booking first with find_booking.");
        }
        const early = notReadBackYet(session, "moved");
        if (early) return early;

        /*
         * The same check a new booking gets, for the same reason: the service,
         * its extras and the number of people are unchanged, so the new time
         * has to be free for exactly that much work. Asked here rather than
         * trusted, because the times offered may be minutes old.
         */
        const free = await isSlotFree({
          organizationId: session.salon.organizationId,
          serviceId: moving.serviceId!,
          date: args.date,
          time: args.time,
          addonIds: moving.addonIds,
          quantity: moving.quantity,
        });

        if (!free?.isAvailable) {
          return refuse(
            "time_not_free",
            `${args.time} on ${args.date} is not free for that appointment. Offer what is, or another day.`,
          );
        }

        await rescheduleBooking({
          organizationId: session.salon.organizationId,
          bookingPublicId: moving.bookingPublicId,
          newStartTime: `${args.date} ${args.time}`,
        });

        session.managing = { ...moving, startTime: `${args.date} ${args.time}` };
        return JSON.stringify({
          ok: true,
          moved: true,
          from: moving.startTime,
          to: `${args.date} ${args.time}`,
        });
      }

      default:
        return refuse("no_such_tool", `There is no tool named ${name}.`);
    }
  } catch (error) {
    return refuse("call_failed", (error as Error).message);
  }
};
