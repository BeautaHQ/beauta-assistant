import { randomUUID } from "node:crypto";

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { missingFields } from "../call/booking";
import { closeCall, openCall } from "../call/callLog";
import { newSession, record, type CallSession } from "../call/session";
import { GREETING } from "../config";
import { streamReply, type Turn } from "../receptionist";
import { getCatalogue } from "../salon/catalogue";
import { openingLine } from "../salon/greeting";
import { salonById, salonForCall } from "../salon/lookup";

/**
 * A conversation over HTTP: text in, text out.
 *
 * ConversationRelay hands us text and speaks our text back, so a call is
 * already text in and text out — Twilio's half is speech, and none of the
 * booking lives there. That makes a call reproducible from a text box: the
 * session, the tools, the guards and the `voice_call` row are the same objects
 * a real caller reaches.
 *
 * It is behind a flag because it is not a mock. A booking made here is a real
 * booking in a real diary, and the salon's customers will be sent the real
 * confirmation email.
 */

/** Calls in progress, by their id. Same lifetime as a socket on the real route. */
const calls = new Map<string, { session: CallSession; history: Turn[]; at: number }>();

/*
 * A simulated call has no socket to close, so nothing tells us the tester
 * walked away. Without this the map is a slow leak of whole conversations.
 */
const IDLE_MS = 60 * 60 * 1000;

const sweep = () => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, call] of calls) {
    if (call.at < cutoff) calls.delete(id);
  }
};

const errorResponses = {
  404: Type.Object({ success: Type.Boolean(), message: Type.String() }),
};

export const conversationRouter = (app: FastifyInstance) => {
  app.post<{
    Body: {
      channel?: "PHONE" | "CHAT";
      from?: string;
      to?: string;
      forwardedFrom?: string;
      organizationId?: number;
    };
  }>(
    "",
    {
      schema: {
        tags: ["Conversations"],
        summary: "Start a conversation",
        description:
          "A phone call and a chat run the same conversation: Twilio only turns speech into text at one end and text back into speech at the other. So this starts either, and `channel` is the only thing that differs. On PHONE the caller's number is known from the start; on CHAT it is not, so the receptionist will ask for it before booking. `to` or `forwardedFrom` decides which salon answers, exactly as the dialled number does on a real call; a chat can name `organizationId` instead.",
        operationId: "conversationStartCall",
        body: Type.Object({
          channel: Type.Optional(
            Type.Union([Type.Literal("PHONE"), Type.Literal("CHAT")], {
              description: "PHONE knows their number already; CHAT has to ask",
              default: "PHONE",
            }),
          ),
          organizationId: Type.Optional(
            Type.Integer({ description: "Which salon, when no number identifies one" }),
          ),
          from: Type.Optional(
            Type.String({
              description: "The caller's number on PHONE; ignored on CHAT",
              default: "+61400111222",
            }),
          ),
          to: Type.Optional(
            Type.String({ description: "The number they rang, e.g. +641111111" }),
          ),
          forwardedFrom: Type.Optional(
            Type.String({ description: "The salon's own line, on a forwarded call" }),
          ),
        }),
        response: {
          404: Type.Object({ success: Type.Boolean(), message: Type.String() }),
          200: Type.Object({
            conversationId: Type.String(),
            greeting: Type.String(),
            channel: Type.String(),
            salon: Type.Object({
              organizationId: Type.Integer(),
              name: Type.String(),
              timezone: Type.String(),
            }),
            matchedOn: Type.String({
              description:
                "Which number identified the salon: forwardedFrom, to, to:ambiguous, or fallback",
            }),
            services: Type.Integer({ description: "How many services it can talk about" }),
          }),
        },
      },
    },
    async (request, reply) => {
      sweep();

      const channel = request.body?.channel ?? "PHONE";
      // A chat has no caller ID, so nothing is assumed about who they are.
      const from = channel === "CHAT" ? "" : (request.body?.from ?? "+61400111222");

      const { salon, matchedOn } = request.body?.organizationId
        ? { salon: await salonById(request.body.organizationId), matchedOn: "organizationId" }
        : await salonForCall(
            request.body?.to ?? null,
            request.body?.forwardedFrom ?? null,
          );

      /*
       * No salon, no conversation.
       *
       * Without one there is no price list, no diary and nothing to answer
       * with — and the record of the call has nowhere to hang, which surfaced
       * as a foreign key violation rather than as the plain refusal it should
       * be. /incoming turns such calls away too, so the two agree.
       */
      if (!salon.found) {
        return reply.status(404).send({
          success: false,
          message:
            "No salon matches that number. Set the salon's assistantPhone, or pass an organizationId that exists.",
        });
      }

      const conversationId = `cnv_${randomUUID()}`;
      const session = newSession(conversationId, from, salon, channel);
      session.toNumber = request.body?.to ?? null;
      session.forwardedFrom = request.body?.forwardedFrom ?? null;
      session.catalogue = await getCatalogue(salon.organizationId).catch(() => null);

      await openCall(session);
      calls.set(conversationId, { session, history: [], at: Date.now() });

      return reply.send({
        conversationId,
        channel,
        greeting: openingLine(channel, salon.name),
        salon,
        matchedOn,
        services: session.catalogue?.serviceIds.size ?? 0,
      });
    },
  );

  app.post<{ Params: { conversationId: string }; Body: { text: string } }>(
    "/:conversationId/say",
    {
      schema: {
        tags: ["Conversations"],
        summary: "Say something to the receptionist",
        description:
          "One thing the caller says, and what comes back. `tools` shows what was actually run against the diary — on a real call that is invisible, and it is where the interesting failures are. `booking` is what has been pinned down so far; a field stays null until the caller has genuinely said it.",
        operationId: "conversationSay",
        params: Type.Object({ conversationId: Type.String() }),
        body: Type.Object({
          text: Type.String({
            minLength: 1,
            description: "What the caller says",
            default: "Hi, I'd like to book a gel nail removal tomorrow afternoon",
          }),
        }),
        response: {
          200: Type.Object({
            say: Type.String({ description: "What Twilio would speak aloud" }),
            intent: Type.String({
              description:
                "What the turn was for: FAQ, CLARIFY, ADDONS, CHECK_AVAILABILITY, ASK_SLOT, ASK_INFO, REVIEW, CONFIRM, MANAGE, TRANSFER, OTHER. Nothing books before REVIEW has happened.",
            }),
            brokePromise: Type.Boolean({
              description:
                "True when the turn talked about times on a day whose availability it never looked up — the caller was left in silence, or told something unchecked",
            }),
            endCall: Type.Boolean({ description: "Whether it hung up after saying that" }),
            booking: Type.Any({ description: "The booking as it now stands" }),
            missing: Type.Array(Type.String(), {
              description: "What it still needs, in the order it will ask",
            }),
            /*
             * Objects, so the trace reads as JSON rather than as a wall of
             * escaped quotes. `additionalProperties` is what lets arbitrary
             * tool arguments and results through: Fastify's response schema is
             * also its serializer, and it writes only what the schema admits.
             */
            tools: Type.Array(
              Type.Object({
                name: Type.String(),
                args: Type.Object({}, { additionalProperties: true }),
                result: Type.Object({}, { additionalProperties: true }),
              }),
            ),
            bookingPublicId: Type.Union([Type.String(), Type.Null()]),
            waitlisted: Type.Boolean(),
            ms: Type.Integer({ description: "How long the whole turn took" }),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const call = calls.get(request.params.conversationId);
      if (!call) {
        return reply
          .status(404)
          .send({ success: false, message: "No such call. Start one first." });
      }

      call.at = Date.now();
      const { session, history } = call;

      history.push({ role: "user", content: request.body.text });
      record(session, "caller", request.body.text);

      const started = Date.now();
      /*
       * Failures are answered, not thrown, the same way the phone route
       * answers them. A dropped connection to OpenAI left this returning a 500
       * while a real caller in the same moment would have heard "sorry, I
       * didn't catch that" — the tester should see the call the caller gets.
       */
      let answer;
      try {
        // Nothing to stream to, so the tokens are collected rather than spoken.
        answer = await streamReply(session, history, () => {}, AbortSignal.timeout(60_000));
      } catch (error) {
        request.log.error(
          { event: "reply_failed", errorMessage: (error as Error).message },
          "LLM failed",
        );
        answer = {
          say: "Sorry, I didn't catch that. Could you say it again?",
          intent: "OTHER" as const,
          endCall: false,
          brokePromise: false,
        };
      }

      history.push({ role: "assistant", content: answer.say });
      record(session, "salon", answer.say, {
        intent: answer.intent,
        brokePromise: answer.brokePromise,
      });

      return reply.send({
        say: answer.say,
        intent: answer.intent,
        brokePromise: answer.brokePromise,
        endCall: answer.endCall,
        booking: session.booking,
        missing: missingFields(session.booking),
        tools: session.toolsThisTurn.map((used) => ({
          name: used.name,
          args: used.args as Record<string, unknown>,
          result: asObject(used.result),
        })),
        bookingPublicId: session.bookingPublicId,
        waitlisted: session.waitlisted,
        ms: Date.now() - started,
      });
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    "/:conversationId",
    {
      schema: {
        tags: ["Conversations"],
        summary: "Where the call is up to",
        operationId: "conversationGetCall",
        params: Type.Object({ conversationId: Type.String() }),
        response: {
          200: Type.Object({
            conversationId: Type.String(),
            salon: Type.Any(),
            booking: Type.Any(),
            bookingPublicId: Type.Union([Type.String(), Type.Null()]),
            waitlisted: Type.Boolean(),
            transcript: Type.Array(
              Type.Object({
                role: Type.String(),
                text: Type.String(),
                at: Type.String(),
              }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const call = calls.get(request.params.conversationId);
      if (!call) {
        return reply.status(404).send({ success: false, message: "No such call." });
      }

      const { session } = call;
      return reply.send({
        conversationId: session.conversationId,
        salon: session.salon,
        booking: session.booking,
        bookingPublicId: session.bookingPublicId,
        waitlisted: session.waitlisted,
        transcript: session.transcript,
      });
    },
  );

  app.delete<{ Params: { conversationId: string } }>(
    "/:conversationId",
    {
      schema: {
        tags: ["Conversations"],
        summary: "Hang up",
        description:
          "Finishes the voice_call row the same way the socket closing does. Worth doing rather than abandoning the call, because the row is only completed on hang-up.",
        operationId: "conversationHangUp",
        params: Type.Object({ conversationId: Type.String() }),
        response: {
          200: Type.Object({
            conversationId: Type.String(),
            outcome: Type.String(),
            turns: Type.Integer(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const call = calls.get(request.params.conversationId);
      if (!call) {
        return reply.status(404).send({ success: false, message: "No such call." });
      }

      await closeCall(call.session);
      calls.delete(request.params.conversationId);

      return reply.send({
        conversationId: call.session.conversationId,
        outcome: call.session.bookingPublicId
          ? "BOOKED"
          : call.session.waitlisted
            ? "WAITLISTED"
            : "NO_ACTION",
        turns: call.session.transcript.length,
      });
    },
  );
};

/** Tool results travel as JSON text; the trace shows them as what they are. */
const asObject = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { raw: value };
  }
};
