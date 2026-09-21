import OpenAI from "openai";

import { mergeBooking, type BookingState } from "../call/booking";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../config";
import { StreamingStringField } from "./jsonStream";
import type { CallSession } from "../call/session";
import { briefing, REPLY_FORMAT, systemPrompt } from "./prompt";
import { runTool, TOOLS } from "./tools";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Drop extras the chosen service does not offer, and remember which.
 *
 * Done the moment the model fills the booking in, not later when a tool
 * refuses it. The service is still what the caller asked for, so it stays; only
 * the extras that do not belong to it go, and their names are kept so the next
 * turn can say what happened and offer what is actually available.
 *
 * The price list already shows extras nested under each service, but prose is
 * not a constraint — the same extra appears under a dozen services, and a
 * model reading quickly attaches one to a service that never listed it.
 */
const pruneStrayAddons = (session: CallSession) => {
  session.rejectedAddons = [];

  const { serviceId, addonIds, addonNames } = session.booking;
  const allowed = serviceId ? session.catalogue?.addonsByService.get(serviceId) : null;
  if (!allowed || addonIds.length === 0) return;

  const ids = new Set(allowed.map((addon) => addon.id));
  const keptIds: number[] = [];
  const keptNames: string[] = [];

  addonIds.forEach((id, index) => {
    if (ids.has(id)) {
      keptIds.push(id);
      if (addonNames[index]) keptNames.push(addonNames[index]!);
      return;
    }
    session.rejectedAddons.push(addonNames[index] ?? `extra ${id}`);
  });

  session.booking.addonIds = keptIds;
  session.booking.addonNames = keptNames;
};

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

export type Intent =
  | "FAQ"
  | "CLARIFY"
  | "CHECK_AVAILABILITY"
  | "ASK_SLOT"
  | "ASK_INFO"
  | "REVIEW"
  | "CONFIRM"
  | "OTHER";

export interface Reply {
  /** What to speak. Already streamed out token by token by the time this returns. */
  say: string;
  /** What the model decided this turn was for, before it wrote a word. */
  intent: Intent;
  /** Whether to hang up once it has been spoken. */
  endCall: boolean;
  /**
   * Set when the turn claimed to be reading the diary but never did.
   *
   * Not corrected here: by the time we know, the words have already been
   * streamed and the caller has heard them. Retrying would have them hear the
   * stall and then the correction. So it is reported instead — a stall that
   * used to be invisible is now a flag on the turn.
   */
  brokePromise: boolean;
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
  session.toolsThisTurn = [];

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
          intent?: Intent;
          booking?: Partial<BookingState>;
          endCall?: boolean;
        };
        session.booking = mergeBooking(session.booking, parsed.booking);
        pruneStrayAddons(session);

        const intent = parsed.intent ?? "OTHER";

        /*
         * The right to book is earned on the turn the booking is read out, and
         * only the model knows whether it actually read it. So the turn it
         * labels REVIEW is what grants it, and the tools check for it before
         * anything reaches the diary.
         */
        if (intent === "REVIEW") session.reviewed = true;
        /*
         * Whether the turn talked about a day whose times it never looked up.
         *
         * Judged on what happened, not on the label. A turn that reads the
         * diary and then offers what it found is doing two jobs but can only
         * carry one name, and the model names it after what it is saying — so
         * a diary-reading turn often comes back labelled ASK_SLOT. Keying the
         * check to CHECK_AVAILABILITY alone let exactly the stall it exists to
         * catch go past unnoticed.
         */
        const readTheDiary = session.toolsThisTurn.some(
          (used) => used.name === "check_availability",
        );
        const aboutTimes = intent === "CHECK_AVAILABILITY" || intent === "ASK_SLOT";
        const haveTimes =
          session.offered !== null && session.offered.date === session.booking.date;

        return {
          say: parsed.say ?? spoken.value,
          intent,
          endCall: parsed.endCall === true,
          brokePromise: aboutTimes && !readTheDiary && !haveTimes,
        };
      } catch {
        // Cut short by max_tokens: what was streamed is what the caller heard,
        // so keep it rather than throwing away a half-spoken sentence.
        return {
          say: spoken.value,
          intent: "OTHER",
          endCall: false,
          brokePromise: false,
        };
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
    intent: "OTHER",
    endCall: false,
    brokePromise: false,
  };
};
