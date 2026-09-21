import type { FastifyInstance } from "fastify";

import { isValidTwilioSignature } from "../auth/twilioSignature";
import { FORWARD_UNKNOWN_TO, LANGUAGE, handoffUrl, relayUrl } from "../config";
import { openingLine } from "../salon/greeting";
import { salonForCall } from "../salon/lookup";
import {
  conversationRelayTwiml,
  sayAndDialTwiml,
  sayAndHangUpTwiml,
} from "../utils/twiml";

/** What Twilio posts when a call arrives. Only the fields we read are listed. */
interface IncomingCallBody {
  CallSid?: string;
  /** The caller. On a forwarded call this may be the salon's number instead — worth checking on the first real forward. */
  From?: string;
  /** The number dialled — our Twilio number. Identifies which salon was called. */
  To?: string;
  ForwardedFrom?: string;
}

/**
 * Twilio's first contact with us: a call has arrived and it is asking what to
 * do about it. The answer is TwiML, and ours says "open a socket and let us
 * talk to them".
 */
export const incomingCallRouter = (app: FastifyInstance) => {
  app.post<{ Body: IncomingCallBody }>(
    "/incoming",
    {
      schema: {
        tags: ["Twilio"],
        summary: "A call has arrived",
        description:
          "Twilio's webhook. Posted as form-urlencoded and signed, so it is not callable from this page — it is documented so the shape Twilio sends is written down somewhere. The reply is TwiML handing the call to the /stream socket.",
        operationId: "incomingCall",
        // No body schema on purpose: Twilio decides what it sends, and a
        // stricter contract here would reject a call rather than answer it.
        response: { 200: { type: "string" }, 403: { type: "string" } },
      },
    },
    async (request, reply) => {
      if (!isValidTwilioSignature(request, "/incoming")) {
        request.log.warn(
          { event: "twilio_signature_rejected" },
          "Rejected webhook",
        );
        return reply.status(403).send("Forbidden");
      }

      const body = request.body ?? {};
      request.log.info(
        {
          event: "incoming_call",
          callSid: body.CallSid,
          from: body.From,
          to: body.To,
          forwardedFrom: body.ForwardedFrom,
        },
        "Call received",
      );

      reply.header("Content-Type", "text/xml");

      /*
       * A call with nowhere to stream is worse than a busy signal — the caller
       * would sit on silence — so say something and hang up cleanly instead.
       */
      if (!relayUrl().startsWith("ws")) {
        request.log.error(
          { event: "public_url_missing" },
          "PUBLIC_URL not set",
        );
        return reply.send(
          sayAndHangUpTwiml("Sorry, we cannot take your call right now."),
        );
      }

      /*
       * The salon is looked up here, before the call is even connected,
       * because Twilio speaks this greeting itself from the TwiML — the
       * socket does not exist yet, so nothing later can put the salon's name
       * into the first thing the caller hears.
       *
       * A failure is not worth dropping a call over: the generic greeting
       * still answers the phone.
       */
      const salon = await salonForCall(body.To ?? null, body.ForwardedFrom ?? null)
        .then((result) => result.salon)
        .catch((error: Error) => {
          request.log.error(
            { event: "salon_lookup_failed", errorMessage: error.message },
            "Could not work out which salon was called",
          );
          return null;
        });

      /*
       * A number belonging to no salon gets a person, or nothing.
       *
       * The receptionist would have no price list, no diary and no salon to
       * speak for; letting it answer anyway means an assistant improvising
       * about a business it knows nothing about, on a line somebody is paying
       * for. Better to put the caller through, or tell them plainly.
       */
      if (!salon?.found) {
        request.log.warn(
          {
            event: "unknown_salon",
            to: body.To,
            forwardedFrom: body.ForwardedFrom,
            forwardingTo: FORWARD_UNKNOWN_TO || null,
          },
          "Call to a number that matches no salon",
        );

        return reply.send(
          FORWARD_UNKNOWN_TO
            ? sayAndDialTwiml("One moment, I'll put you through.", FORWARD_UNKNOWN_TO)
            : sayAndHangUpTwiml(
                "Sorry, this number is not connected to a salon. Please check the number and try again.",
              ),
        );
      }

      return reply.send(
        conversationRelayTwiml({
          url: relayUrl(),
          welcomeGreeting: openingLine("PHONE", salon.name),
          language: LANGUAGE,
          action: handoffUrl(),
        }),
      );
    },
  );
};
