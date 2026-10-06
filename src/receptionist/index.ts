import { resolveSpokenDate, resolveSpokenTime } from "../salon/spokenDate";
import OpenAI from "openai";

import { missingFields } from "../call/booking";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../config";
import { StreamingStringField } from "./jsonStream";
import { startAnotherBooking, type CallSession } from "../call/session";
import { readTurn, type FaqTopic, type Intent } from "./intent";
import { briefing, REPLY_FORMAT, systemPrompt } from "./prompt";
import { absorb, currentStep, enforce, type Step } from "./steps";
import { runTool, toolsFor } from "./tools";

export type { Intent } from "./intent";
export type { Step } from "./steps";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * What chat says instead of changing a booking.
 *
 * Written here rather than left to the model: the rule is about what this
 * channel can prove, not about what sounds reasonable, so it should read the
 * same every time and never be talked around.
 */
const CHAT_CANNOT_MANAGE =
  "I can't change or cancel a booking over chat — we can only do that over the phone, " +
  "where we can see the number you're calling from. Please ring the salon, or use the link " +
  "in your confirmation email. Is there anything else I can help you with?";

/**
 * What is said to abuse, and how many times before the call ends.
 *
 * Fixed in code for the same reason as the line above: a turn like this is
 * not one the model answers. Handed "say something dirty" it might, and
 * handed an insult it might argue. So it never sees the turn at all — the
 * words are the same every time, and the second time on a call is goodbye.
 * Chat has no line to put down, so it gets the same words again.
 */
/**
 * What is said to a request outside the job — a taxi, the weather, another
 * shop. Fixed in code so the model cannot invent a way to help; it says what
 * it does do and hands the turn back.
 */
const unsupported = (salonName: string) =>
  `Sorry, that's not something I can help with. I can book an appointment at ${salonName}, or answer questions about our services, prices, hours and how to find us. What would you like?`;

/**
 * What is said when there is nobody to put them through to: on chat, or on a
 * call to a salon with no number on file. The salon's own number when there
 * is one, so the turn still ends with something they can do.
 */
const cannotTransfer = (session: CallSession) => {
  const where = session.salon.phone
    ? `You can reach the salon directly on ${session.salon.phone}`
    : "You can reach the salon through the contact details on the booking page";
  return session.channel === "CHAT"
    ? `I can't put you through to someone over chat. ${where}. Is there anything else I can help with here?`
    : `I'm not able to put you through right now. ${where}. Is there anything else I can help with?`;
};

const OFF_LIMITS_STRIKES = 2;
const OFF_LIMITS = "That's not something I can help with. Shall we carry on with your booking?";
const OFF_LIMITS_GOODBYE = "I'm going to leave it there. Goodbye.";

/*
 * The reasoning models refuse function tools on chat completions unless
 * reasoning is switched off — and a phone call could not afford it anyway,
 * since every reasoning token is a caller listening to silence. The older
 * models reject the parameter outright, so it only goes where it belongs.
 */
const REASONING_MODEL = /^(o\d|gpt-[5-9])/.test(OPENAI_MODEL);

export type Turn =
  | { role: "user" | "assistant"; content: string }
  | OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface Reply {
  /** What to speak. Already streamed out token by token by the time this returns. */
  say: string;
  /** What the caller wanted from this turn. */
  intent: Intent;
  /** Which step of a booking the turn was, when it was one. */
  step: Step | null;
  /** What a question was about, when the turn was one. */
  topic: FaqTopic | null;
  /** Whether to hang up once it has been spoken. */
  endCall: boolean;
  /**
   * Kept for the shape the routes expect. It used to flag a turn that talked
   * about times on a day it never looked up; the diary is now read in code
   * before the reply is written, so a reply cannot promise a look it did not
   * take.
   */
  brokePromise: boolean;
}

/**
 * Work out the next thing to say, in two calls with the checks between them.
 *
 * The first reads what the caller just said and what they want. The code
 * then takes that down — checked against the price list, and against the
 * diary once there is enough to ask it about — and works out which step of
 * the booking is next. The second call writes the reply for that one step,
 * with a prompt for it and the tools for it, and nothing to look up.
 *
 * The reply streams out as it arrives so Twilio starts speaking while the
 * model is still writing. The loop is for the tools that remain — booking,
 * changing, handing over — and is capped so a model stuck calling one in a
 * circle cannot leave the caller listening to nothing.
 */
export const streamReply = async (
  session: CallSession,
  history: Turn[],
  onToken: (token: string) => void,
  signal: AbortSignal,
): Promise<Reply> => {
  session.checksThisTurn = 0;
  session.toolsThisTurn = [];

  const transcript = history as OpenAI.Chat.Completions.ChatCompletionMessageParam[];

  const started = Date.now();
  const read = await readTurn(session, transcript, signal);

  // The day is worked out in code from the customer's own words, not left to
  // the model: "Friday" is this Friday, "9/10" is 9 October. When they name a
  // day, it overrides whatever the model made of it.
  const lastSaid = [...history].reverse().find((turn) => turn.role === "user")?.content;
  const spoken = typeof lastSaid === "string" ? resolveSpokenDate(lastSaid, session.salon.timezone) : null;
  if (spoken) read.filled.date = spoken;
  // An exact clock time, when the model missed it. Ranges ("after 5pm") are left to the model.
  const spokenTime = typeof lastSaid === "string" ? resolveSpokenTime(lastSaid) : null;
  if (spokenTime && !read.filled.time && read.filled.times.length === 0) read.filled.time = spokenTime;

  // A phone number or email in anything they say is kept for the booking,
  // whatever the turn was about; the model only sometimes picked them out.
  if (typeof lastSaid === "string") {
    const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(lastSaid)?.[0];
    if (email && !read.filled.email) read.filled.email = email;
    const phone = /(?<![\d/.:])\+?\d[\d\s-]{6,16}\d(?![\d/.:])/.exec(lastSaid)?.[0];
    const digits = phone?.replace(/\D/g, "") ?? "";
    if (phone && digits.length >= 8 && digits.length <= 15 && !read.filled.phone) read.filled.phone = phone.replace(/[\s-]/g, "");
  }

  /*
   * Booked, and booking again with something new — another day, another
   * time, another service — is a second booking, not a slip. Without this
   * every turn after a booking was answered with "it's done".
   */
  const newDetails =
    read.filled.date || read.filled.time || read.filled.times.length > 0 || read.filled.serviceName || read.filled.serviceId;
  if (session.bookingPublicId && read.intent === "BOOK" && newDetails) {
    startAnotherBooking(session, { keepService: !read.filled.serviceName && !read.filled.serviceId });
  }

  await absorb(session, read.filled, read.intent);
  session.intentMs = Date.now() - started;

  const intent = enforce(read.intent, session);
  const step =
    intent === "BOOK" || (intent === "CONFIRM" && !session.managing)
      ? currentStep(session, intent)
      : null;
  const topic = intent === "FAQ" ? read.topic : null;
  session.lastIntent = intent;
  if (intent === "BOOK") session.wantsToBook = true;
  session.askStreak = intent === "FAQ" || intent === "OTHER" ? session.askStreak + 1 : 0;

  // The same step with the same booking, turn after turn, is a question being
  // repeated. Counted here, read in the briefing.
  // Only a booking turn moves the count; a "yes" or an aside in between does
  // not reset it, or three repeats could never be seen.
  if (intent === "BOOK" && step) {
    const key = `${step}|${JSON.stringify(session.booking)}`;
    session.stuck = session.stuck.key === key ? { key, turns: session.stuck.turns + 1 } : { key, turns: 1 };
  }

  /*
   * A chat turn about changing a booking does not get to improvise. Chat
   * cannot prove whose booking it is, so the answer is fixed and does not come
   * from the model at all — and since the intent is known before the reply
   * is written, the reply is never written.
   */
  if (session.channel === "CHAT" && intent === "MANAGE") {
    return { say: CHAT_CANNOT_MANAGE, intent, step, topic, endCall: false, brokePromise: false };
  }

  if (intent === "UNSUPPORTED") {
    return {
      say: unsupported(session.salon.name),
      intent,
      step,
      topic,
      endCall: false,
      brokePromise: false,
    };
  }

  if (intent === "OFFLIMITS") {
    session.offLimits += 1;
    const hangUp = session.channel === "PHONE" && session.offLimits >= OFF_LIMITS_STRIKES;
    return {
      say: hangUp ? OFF_LIMITS_GOODBYE : OFF_LIMITS,
      intent,
      step,
      topic,
      endCall: hangUp,
      brokePromise: false,
    };
  }

  /*
   * Saying "I'm putting you through" is the decision; the tool is only how it
   * is carried out. The model announced the transfer and called nothing, so
   * the socket closed with "done" and Twilio hung up on a caller who had just
   * been told to hold. The intent is enough.
   *
   * And where there is no line to put them through on — a chat, or a salon
   * with no number on file — the model must not say it at all. On chat it
   * announced a transfer, then explained a chat cannot be transferred. The
   * reply is fixed here instead, with the number they can ring.
   */
  if (intent === "TRANSFER") {
    if (session.channel === "PHONE" && session.salon.staffPhone) {
      session.transferring = true;
    } else {
      return {
        say: cannotTransfer(session),
        intent,
        step,
        topic,
        endCall: false,
        brokePromise: false,
      };
    }
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(session, intent, step, topic) },
    ...transcript,
    { role: "system", content: briefing(session, intent) },
  ];
  // This reply is the one that offers the extras; later briefings say they were.
  if (session.booking.serviceId && step && step !== "REVIEW" && step !== "BOOK") session.extrasOffered = session.booking.serviceId;
  const tools = toolsFor(intent, step, session, topic);

  for (let round = 0; round < 4; round += 1) {
    const stream = await client.chat.completions.create(
      {
        model: OPENAI_MODEL,
        messages,
        ...(tools ? { tools } : {}),
        response_format: REPLY_FORMAT,
        stream: true,
        // The newer models reject max_tokens outright; this is the name they
        // all take, 4o included.
        max_completion_tokens: 300,
        ...(REASONING_MODEL ? { reasoning_effort: "none" as const } : { temperature: 0.3 }),
      },
      { signal },
    );

    let raw = "";
    const spoken = new StreamingStringField("say", onToken);
    const calls: { id: string; name: string; args: string }[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        raw += delta.content;
        spoken.push(delta.content);
      }

      // Tool calls arrive in fragments too, indexed so they can be reassembled.
      for (const part of delta.tool_calls ?? []) {
        const slot = (calls[part.index] ??= { id: "", name: "", args: "" });
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.name = part.function.name;
        if (part.function?.arguments) slot.args += part.function.arguments;
      }
    }

    if (calls.length === 0) {
      try {
        const parsed = JSON.parse(raw) as {
          say?: string;
          readBack?: boolean;
          endCall?: boolean;
        };

        /*
         * The right to book is earned on the turn the booking is read out, and
         * the model says which turn that was. Believed only when there was a
         * whole booking to read: claimed while the number was still missing,
         * the next message — the caller giving that number — was taken for
         * their yes and booked on the spot.
         */
        if (parsed.readBack === true) {
          const outstanding = missingFields(session.booking);
          if (session.managing || outstanding.every((gap) => gap === "confirmation")) {
            session.reviewed = true;
          }
        }

        return {
          say: parsed.say ?? spoken.value,
          intent,
          step,
          topic,
          endCall: parsed.endCall === true,
          brokePromise: false,
        };
      } catch {
        // Cut short by max_tokens: what was streamed is what the caller heard,
        // so keep it rather than throwing away a half-spoken sentence.
        return { say: spoken.value, intent, step, topic, endCall: false, brokePromise: false };
      }
    }

    messages.push({
      role: "assistant",
      content: raw || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args || "{}" },
      })),
    });

    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.args || "{}");
      } catch {
        // Malformed arguments are the model's mistake; let it see the result
        // and try again rather than crashing the call.
      }
      const result = await runTool(c.name, args, session);
      messages.push({ role: "tool", tool_call_id: c.id, content: result });
    }

    // A tool may have changed what is known — re-brief before the next round.
    messages.push({ role: "system", content: briefing(session, intent) });
  }

  return {
    say: "Sorry, I'm having trouble with that. Can I take a message for the salon?",
    intent,
    step,
    topic,
    endCall: false,
    brokePromise: false,
  };
};
