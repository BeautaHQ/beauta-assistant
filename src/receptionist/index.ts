import OpenAI from "openai";

import { missingFields } from "../call/booking";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../config";
import { StreamingStringField } from "./jsonStream";
import type { CallSession } from "../call/session";
import { readTurn, type Intent } from "./intent";
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
  await absorb(session, read.filled);
  session.intentMs = Date.now() - started;

  const intent = enforce(read.intent, session);
  const step =
    intent === "BOOK" || (intent === "CONFIRM" && !session.managing)
      ? currentStep(session, intent)
      : null;
  session.lastIntent = intent;

  /*
   * A chat turn about changing a booking does not get to improvise. Chat
   * cannot prove whose booking it is, so the answer is fixed and does not come
   * from the model at all — and since the intent is known before the reply
   * is written, the reply is never written.
   */
  if (session.channel === "CHAT" && intent === "MANAGE") {
    return { say: CHAT_CANNOT_MANAGE, intent, step, endCall: false, brokePromise: false };
  }

  if (intent === "OFFLIMITS") {
    session.offLimits += 1;
    const hangUp = session.channel === "PHONE" && session.offLimits >= OFF_LIMITS_STRIKES;
    return {
      say: hangUp ? OFF_LIMITS_GOODBYE : OFF_LIMITS,
      intent,
      step,
      endCall: hangUp,
      brokePromise: false,
    };
  }

  /*
   * Saying "I'm putting you through" is the decision; the tool is only how it
   * is carried out. The model announced the transfer and called nothing, so
   * the socket closed with "done" and Twilio hung up on a caller who had just
   * been told to hold. The intent is enough.
   */
  if (session.channel === "PHONE" && intent === "TRANSFER" && session.salon.staffPhone) {
    session.transferring = true;
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(session, intent, step) },
    ...transcript,
    { role: "system", content: briefing(session) },
  ];
  const tools = toolsFor(intent, step, session);

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
          endCall: parsed.endCall === true,
          brokePromise: false,
        };
      } catch {
        // Cut short by max_tokens: what was streamed is what the caller heard,
        // so keep it rather than throwing away a half-spoken sentence.
        return { say: spoken.value, intent, step, endCall: false, brokePromise: false };
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
    messages.push({ role: "system", content: briefing(session) });
  }

  return {
    say: "Sorry, I'm having trouble with that. Can I take a message for the salon?",
    intent,
    step,
    endCall: false,
    brokePromise: false,
  };
};
