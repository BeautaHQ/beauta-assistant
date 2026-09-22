import type { FastifyInstance } from "fastify";

import { isValidTwilioSignature } from "../auth/twilioSignature";
import { salonForCall } from "../salon/lookup";
import { sayAndDialTwiml } from "../utils/twiml";

/** What Twilio posts when a ConversationRelay session ends. */
interface HandoffBody {
  CallSid?: string;
  To?: string;
  ForwardedFrom?: string;
  /** Whatever the socket sent with its end message, as a JSON string. */
  HandoffData?: string;
}

/**
 * What happens after the receptionist lets go of the call.
 *
 * Every ConversationRelay session ends here, which is the point: a goodbye at
 * the end of a booking and a caller asking for a person both close the socket,
 * and only the reason tells them apart. TwiML placed after </Connect> would
 * run for both, so a transfer written that way would also ring the salon every
 * time someone finished booking.
 */
export const handoffRouter = (app: FastifyInstance) => {
  app.post<{ Body: HandoffBody }>(
    "/handoff",
    {
      schema: {
        tags: ["Twilio"],
        summary: "Decide what happens when the receptionist hands the call back",
        description:
          "Twilio posts here when the ConversationRelay session ends, carrying whatever the socket sent as handoffData. A request to speak to someone is put through to the salon's second number; anything else hangs up.",
        operationId: "handoff",
        response: { 200: { type: "string" }, 403: { type: "string" } },
      },
    },
    async (request, reply) => {
      if (!isValidTwilioSignature(request, "/handoff")) {
        request.log.warn({ event: "twilio_signature_rejected" }, "Rejected handoff");
        return reply.status(403).send("Forbidden");
      }

      const body = request.body ?? {};

      let reason = "done";
      try {
        reason = (JSON.parse(body.HandoffData ?? "{}") as { reason?: string }).reason ?? "done";
      } catch {
        // Malformed handoff data is not worth dropping a call over; treat it
        // as an ordinary ending.
      }

      if (reason !== "staff") {
        request.log.info({ event: "handoff_hangup", callSid: body.CallSid }, "Call ended");
        return reply.send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      }

      const salon = await salonForCall(body.To ?? null, body.ForwardedFrom ?? null)
        .then((result) => result.salon)
        .catch(() => null);

      if (!salon?.staffPhone) {
        request.log.warn(
          {
            event: "handoff_no_staff_number",
            callSid: body.CallSid,
            organizationId: salon?.organizationId ?? null,
          },
          "Asked for a person, but the salon has no number to dial",
        );
        return reply.send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, there is no one available to take the call right now. Please try again later.</Say><Hangup/></Response>',
        );
      }

      /*
       * The number goes in the log. Without it a dropped transfer says only
       * "putting the caller through" and then silence, and there is no way to
       * tell a wrong number in the salon's record from a Twilio account that
       * is not allowed to dial it.
       */
      request.log.info(
        {
          event: "handoff_to_staff",
          callSid: body.CallSid,
          organizationId: salon.organizationId,
          dialling: salon.staffPhone,
        },
        "Putting the caller through",
      );
      return reply.send(
        sayAndDialTwiml("Putting you through now.", salon.staffPhone),
      );
    },
  );
};
