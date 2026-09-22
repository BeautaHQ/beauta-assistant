import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

import { prisma } from "../clients/prisma";
import { readEnquiry } from "../enquiry/read";
import type { EnquiryAction, EnquiryIntent } from "../enquiry/action";
import { getCatalogue } from "../salon/catalogue";
import { salonById } from "../salon/lookup";

/**
 * What the assistant makes of a customer's enquiry.
 *
 * Nothing to do with the receptionist. An enquiry is one message from someone
 * who is not waiting: there is no conversation to hold, nothing to stream, and
 * nobody to ask a follow-up. What the salon wants is a reply they could send
 * and a note of what the message actually asks for.
 *
 * Called once, by beauta-api, the moment an enquiry lands — never by a browser.
 * The reading is kept on the enquiry row, and the salon's app reads it from
 * there along with the rest of the enquiry.
 *
 * It says nothing about whether the salon can act. That is a question about the
 * diary, not about the message: the answer changes by the hour, the salon's own
 * app is already asking beauta-api that question for its calendar, and a second
 * opinion computed here would only be a slower way to disagree with it.
 *
 * It never acts. The salon books, moves or cancels from their own screen, with
 * their own hands.
 */
export const enquiryRouter = (app: FastifyInstance) => {
  app.post<{ Params: { enquiryId: number } }>(
    "/:enquiryId/review",
    {
      schema: {
        tags: ["Enquiries"],
        summary: "Read an enquiry, and keep what it asks for",
        description:
          "Called in the background when an enquiry is submitted. Reads the message once and stores the intent, a draft reply and what was asked for on the enquiry row. Reading it again is a no-op: the message does not change. Nothing is booked, moved or cancelled here.",
        operationId: "reviewEnquiry",
        params: Type.Object({ enquiryId: Type.Integer() }),
        response: {
          200: Type.Object({
            enquiryId: Type.Integer(),
            intent: Type.String(),
            draft: Type.String(),
            action: Type.Object({}, { additionalProperties: true }),
            /** False when the reading was already on file. */
            readNow: Type.Boolean(),
          }),
          404: Type.Object({ success: Type.Boolean(), message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const enquiry = await prisma.customerEnquiry.findUnique({
        where: { id: request.params.enquiryId },
      });

      if (!enquiry) {
        return reply.status(404).send({ success: false, message: "No such enquiry." });
      }

      const salon = await salonById(enquiry.organizationId);
      if (!salon.found) {
        return reply
          .status(404)
          .send({ success: false, message: "That enquiry belongs to no salon." });
      }

      let intent = enquiry.aiIntent as EnquiryIntent | null;
      let draft = enquiry.aiDraft;
      let action = enquiry.aiAction as EnquiryAction | null;
      let readNow = false;

      if (!intent || !action) {
        /*
         * Read once. The message does not change, and neither does what it
         * asks for — re-reading it would spend a model call to arrive at the
         * same answer, and might not.
         */
        const catalogue = await getCatalogue(salon.organizationId).catch(() => null);
        const reading = await readEnquiry(salon, catalogue, {
          firstName: enquiry.firstName,
          lastName: enquiry.lastName,
          email: enquiry.email,
          phone: enquiry.phone,
          message: enquiry.message,
        });

        intent = reading.intent;
        draft = reading.draft;
        action = reading.action;
        readNow = true;

        await prisma.customerEnquiry.update({
          where: { id: enquiry.id },
          data: {
            aiIntent: reading.intent,
            aiDraft: reading.draft,
            aiAction: reading.action as unknown as object,
            aiReadAt: new Date(),
          },
        });
      }

      return reply.send({
        enquiryId: enquiry.id,
        intent,
        draft: draft ?? "",
        action: action as unknown as Record<string, unknown>,
        readNow,
      });
    },
  );
};
