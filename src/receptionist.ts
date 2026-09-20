import OpenAI from "openai";

import { BOOKING_SCHEMA, mergeBooking, type BookingState } from "./booking";
import { OPENAI_API_KEY, OPENAI_MODEL } from "./config";
import { StreamingStringField } from "./jsonStream";
import { briefing, type CallSession } from "./session";
import { runTool, salonDates, TOOLS } from "./tools";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/*
 * The reasoning models refuse function tools on chat completions unless
 * reasoning is switched off — and a phone call could not afford it anyway,
 * since every reasoning token is a caller listening to silence. The older
 * models reject the parameter outright, so it only goes where it belongs.
 */
const REASONING_MODEL = /^(o\d|gpt-[5-9])/.test(OPENAI_MODEL);

/**
 * Short on purpose. A phone caller cannot skim, so anything said has to be
 * short enough to hold in the ear — paragraphs that read fine on screen are
 * unbearable read aloud.
 *
 * The price list is pasted in whole rather than looked up. It costs about a
 * thousand tokens on a prompt that caches, and it buys back a tool round of
 * silence at the start of every call plus the ids the model used to guess at.
 */
const systemPrompt = (session: CallSession) => {
  const { today, todayName, tomorrow, tomorrowName } = salonDates(session.salon.timezone);
  const catalogue = session.catalogue?.text ?? "";

  return `You are the receptionist for ${session.salon.name}, a nail and beauty salon, answering the phone.

THE DATE
Today is ${todayName} ${today}. Tomorrow is ${tomorrowName} ${tomorrow}. The salon runs on ${session.salon.timezone}.
Every relative day is counted from today, never from a date mentioned earlier in the call. If the caller says "tomorrow" while you are discussing Wednesday, they mean ${tomorrow}, not the day after Wednesday. When it is not obvious, say the date back to them.

HOW TO SPEAK
One or two short sentences, then stop and let them reply. Never read a list aloud: offer at most two or three options and let them pick. Say times the way people say them — "two o'clock", "quarter past three" — not "14:00".

THE PRICE LIST
Every service, with its id, price and duration. Extras that can be added to a service are listed under it as id:name price. These ids are the only real ones — never use any other, and never quote a price or duration that is not here.

${catalogue}

BOOKING, IN ORDER
1. Match what they want to a service above. If they are vague ("my nails done"), ask one question to narrow it.
2. Ask which day.
3. Call check_availability for that day. Never guess or invent a time.
4. Offer two or three of the times it returns, near what they asked for. If they wanted the afternoon, offer afternoon ones.
5. If it comes back full, say so and offer two things: the waitlist, or another day. Never pretend a time exists.
6. Get their first and last name.
7. Read the whole thing back — service, day, time — and wait for them to say yes before calling create_booking.

Take one step per turn. The caller has not answered the question you are about to skip.

RULES
Everything you state comes from the price list or a tool. Never invent prices, times or staff names.
If a tool fails, say you cannot reach the diary right now and offer to take a message.
Their phone number is already known — never ask for it.
Extras are worth offering once the service is settled, not before.
Never read a booking reference out. It is a string of random characters; nobody can take it down over the phone, and the salon has their number.
Never set endCall in the same breath as a question. Ask, hear the answer, then say goodbye.

ANSWER SHAPE
"say" is the words to speak aloud, nothing else — no labels, no markdown, no stage directions.
"booking" is what you have pinned down so far. Carry forward everything already known and add what this turn established; leave a field null only while it is genuinely unknown.
"endCall" is true only once the call is finished and you have said goodbye.`;
};

/**
 * The model answers in this shape rather than free text, so the reply is
 * already structured when it arrives instead of being guessed at afterwards.
 * `strict` makes the schema a guarantee, not a request.
 */
const REPLY_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "receptionist_reply",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["say", "booking", "endCall"],
      properties: {
        say: {
          type: "string",
          description: "Exactly what to speak aloud to the caller.",
        },
        booking: BOOKING_SCHEMA,
        endCall: {
          type: "boolean",
          description: "True only after saying goodbye on a finished call.",
        },
      },
    },
  },
} as const;

export type Turn =
  | { role: "user" | "assistant"; content: string }
  | OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface Reply {
  /** What to speak. Already streamed out token by token by the time this returns. */
  say: string;
  /** Whether to hang up once it has been spoken. */
  endCall: boolean;
}

/**
 * Work out the next thing to say, running any tools the model asks for first.
 *
 * The reply streams out as it arrives so Twilio starts speaking while the model
 * is still writing; waiting for a whole reply would add a second of silence to
 * every turn, which on a phone reads as a dropped call. JSON does not get in
 * the way of that — the spoken field is lifted out of the stream as it lands.
 *
 * The transcript alone turned out not to be enough to keep a booking straight:
 * a model re-reading it each turn drifts, and drifting here means a real
 * appointment for the wrong service. So the session state goes in after the
 * transcript, where the model reads it last, and the tools hold it to it.
 *
 * The loop is for tool use: the model may want the diary before it can answer,
 * so it can go round a few times. Capped, because a model stuck calling tools
 * in a circle would leave the caller listening to nothing.
 */
export const streamReply = async (
  session: CallSession,
  history: Turn[],
  onToken: (token: string) => void,
  signal: AbortSignal,
): Promise<Reply> => {
  session.checksThisTurn = 0;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(session) },
    ...(history as OpenAI.Chat.Completions.ChatCompletionMessageParam[]),
    { role: "system", content: briefing(session) },
  ];

  for (let round = 0; round < 4; round += 1) {
    const stream = await client.chat.completions.create(
      {
        model: OPENAI_MODEL,
        messages,
        tools: TOOLS,
        response_format: REPLY_FORMAT,
        stream: true,
        temperature: 0.3,
        // The newer models reject max_tokens outright; this is the name they
        // all take, 4o included.
        max_completion_tokens: 400,
        ...(REASONING_MODEL ? { reasoning_effort: "none" as const } : {}),
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
          booking?: Partial<BookingState>;
          endCall?: boolean;
        };
        session.booking = mergeBooking(session.booking, parsed.booking);
        return { say: parsed.say ?? spoken.value, endCall: parsed.endCall === true };
      } catch {
        // Cut short by max_tokens: what was streamed is what the caller heard,
        // so keep it rather than throwing away a half-spoken sentence.
        return { say: spoken.value, endCall: false };
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
    endCall: false,
  };
};
