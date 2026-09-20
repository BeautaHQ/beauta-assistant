import type OpenAI from "openai";

import { checkAvailability, createBooking, joinWaitlist } from "./beautaApi";
import { mergeBooking, missingFields } from "./booking";
import { offerable } from "./slots";
import type { CallSession } from "./session";

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
          "callerConfirmed",
        ],
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
          addonIds: { type: "array", items: { type: "number" } },
        },
        required: ["serviceId", "date", "firstName", "lastName"],
      },
    },
  },
];

type Args = Record<string, any>;

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

        const result = await checkAvailability({
          organizationId: session.salon.organizationId,
          serviceId: args.serviceId,
          date: args.date,
          addonIds: args.addonIds,
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
          // The half hours, for offering. Anything on the ten-minute grid in
          // between still books, so a caller who asks for one is not refused.
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
          addonIds: args.addonIds ?? [],
          confirmed: args.callerConfirmed === true,
        });

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

        const booking = await createBooking({
          organizationId: session.salon.organizationId,
          firstName: wanted.firstName!,
          lastName: wanted.lastName!,
          phone: session.phone,
          serviceId: wanted.serviceId!,
          addonIds: wanted.addonIds,
          startTime: `${wanted.date} ${wanted.time}`,
          customerNotes: "Booked by phone with the AI receptionist.",
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
          phone: session.phone,
          serviceId: args.serviceId,
          addonIds: args.addonIds ?? [],
          slots: [{ startTime: `${args.date} 09:00`, endTime: `${args.date} 17:00` }],
          notes: "Added by the AI receptionist over the phone.",
        });

        session.waitlisted = true;
        session.booking = mergeBooking(session.booking, {
          serviceId: args.serviceId,
          date: args.date,
          firstName: args.firstName,
          lastName: args.lastName,
        });

        return JSON.stringify({ ok: true, waitlisted: true });
      }

      default:
        return refuse("no_such_tool", `There is no tool named ${name}.`);
    }
  } catch (error) {
    return refuse("call_failed", (error as Error).message);
  }
};

/**
 * Today and tomorrow, in the salon's own clock.
 *
 * Both are handed over rather than only today. Asked to work "tomorrow" out for
 * itself the model took it as the day after whatever date was last mentioned,
 * so a caller who said "put me on the waitlist for tomorrow" during a
 * conversation about Wednesday was waitlisted for Thursday. Tomorrow is
 * tomorrow, counted from today, and now it never has to do the sum.
 */
export const salonDates = (timezone: string) => {
  const format = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);

  const weekday = (date: Date) =>
    new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "long" }).format(
      date,
    );

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  return {
    today: format(now),
    todayName: weekday(now),
    tomorrow: format(tomorrow),
    tomorrowName: weekday(tomorrow),
  };
};
