import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { missingFields } from "../call/booking";
import { closeCall, openCall } from "../call/callLog";
import { newSession, record, type CallSession } from "../call/session";
import { GREETING } from "../config";
import { streamReply, type Turn } from "../receptionist";
import { getCatalogue } from "../salon/catalogue";
import { salonForCall } from "../salon/lookup";

/**
 * The phone line, without the phone.
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

export const simulatorRouter = (app: FastifyInstance) => {
  app.post<{ Body: { from?: string; to?: string; forwardedFrom?: string } }>(
    "/calls",
    {
      schema: {
        tags: ["Simulator"],
        summary: "Start a call",
        description:
          "Stands in for Twilio's setup message. `to` or `forwardedFrom` decides which salon answers, exactly as the dialled number does on a real call; leave them out to get the salon in ORGANIZATION_ID. Returns the greeting Twilio would speak before the caller says anything.",
        operationId: "simulatorStartCall",
        body: Type.Object({
          from: Type.Optional(
            Type.String({ description: "The caller's number", default: "+61400111222" }),
          ),
          to: Type.Optional(
            Type.String({ description: "The number they rang, e.g. +641111111" }),
          ),
          forwardedFrom: Type.Optional(
            Type.String({ description: "The salon's own line, on a forwarded call" }),
          ),
        }),
        response: {
          200: Type.Object({
            callSid: Type.String(),
            greeting: Type.String(),
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

      const from = request.body?.from ?? "+61400111222";
      const { salon, matchedOn } = await salonForCall(
        request.body?.to ?? null,
        request.body?.forwardedFrom ?? null,
      );

      const callSid = `SIM_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      const session = newSession(callSid, from, salon);
      session.toNumber = request.body?.to ?? null;
      session.forwardedFrom = request.body?.forwardedFrom ?? null;
      session.catalogue = await getCatalogue(salon.organizationId).catch(() => null);

      await openCall(session);
      calls.set(callSid, { session, history: [], at: Date.now() });

      return reply.send({
        callSid,
        greeting: GREETING,
        salon,
        matchedOn,
        services: session.catalogue?.serviceIds.size ?? 0,
      });
    },
  );

  app.post<{ Params: { callSid: string }; Body: { text: string } }>(
    "/calls/:callSid/say",
    {
      schema: {
        tags: ["Simulator"],
        summary: "Say something to the receptionist",
        description:
          "One thing the caller says, and what comes back. `tools` shows what was actually run against the diary — on a real call that is invisible, and it is where the interesting failures are. `booking` is what has been pinned down so far; a field stays null until the caller has genuinely said it.",
        operationId: "simulatorSay",
        params: Type.Object({ callSid: Type.String() }),
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
                "What the turn was for: FAQ, CHECK_AVAILABILITY, ASK_SLOT, ASK_INFO, REVIEW, CONFIRM, OTHER. Nothing books before REVIEW has happened.",
            }),
            brokePromise: Type.Boolean({
              description:
                "True when the turn said it was reading the diary and then did not — the caller was left in silence",
            }),
            endCall: Type.Boolean({ description: "Whether it hung up after saying that" }),
            booking: Type.Any({ description: "The booking as it now stands" }),
            missing: Type.Array(Type.String(), {
              description: "What it still needs, in the order it will ask",
            }),
            /*
             * Strings, not objects. Fastify's response schema doubles as the
             * serializer, and it would not write these as free-form objects —
             * the field came back as an empty list while the server log showed
             * the tools running perfectly well. Arguments and results are
             * arbitrary JSON, so they are handed over as JSON text, which
             * always survives the trip.
             */
            tools: Type.Array(
              Type.Object({
                name: Type.String(),
                args: Type.String({ description: "JSON the model passed in" }),
                result: Type.String({ description: "JSON the tool answered with" }),
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
      const call = calls.get(request.params.callSid);
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
          args: JSON.stringify(used.args),
          result: used.result,
        })),
        bookingPublicId: session.bookingPublicId,
        waitlisted: session.waitlisted,
        ms: Date.now() - started,
      });
    },
  );

  app.get<{ Params: { callSid: string } }>(
    "/calls/:callSid",
    {
      schema: {
        tags: ["Simulator"],
        summary: "Where the call is up to",
        operationId: "simulatorGetCall",
        params: Type.Object({ callSid: Type.String() }),
        response: {
          200: Type.Object({
            callSid: Type.String(),
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
      const call = calls.get(request.params.callSid);
      if (!call) {
        return reply.status(404).send({ success: false, message: "No such call." });
      }

      const { session } = call;
      return reply.send({
        callSid: session.callSid,
        salon: session.salon,
        booking: session.booking,
        bookingPublicId: session.bookingPublicId,
        waitlisted: session.waitlisted,
        transcript: session.transcript,
      });
    },
  );

  app.delete<{ Params: { callSid: string } }>(
    "/calls/:callSid",
    {
      schema: {
        tags: ["Simulator"],
        summary: "Hang up",
        description:
          "Finishes the voice_call row the same way the socket closing does. Worth doing rather than abandoning the call, because the row is only completed on hang-up.",
        operationId: "simulatorHangUp",
        params: Type.Object({ callSid: Type.String() }),
        response: {
          200: Type.Object({
            callSid: Type.String(),
            outcome: Type.String(),
            turns: Type.Integer(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const call = calls.get(request.params.callSid);
      if (!call) {
        return reply.status(404).send({ success: false, message: "No such call." });
      }

      await closeCall(call.session);
      calls.delete(request.params.callSid);

      return reply.send({
        callSid: call.session.callSid,
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
