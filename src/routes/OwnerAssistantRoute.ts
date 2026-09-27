import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { askOwnerAssistant, type OwnerAssistantRequest } from "../owner-assistant";

export const ownerAssistantRouter = (app: FastifyInstance) => {
  app.post("/ask", {
    schema: {
      tags: ["Owner Assistant"],
      body: Type.Object({
        organizationId: Type.Integer({ minimum: 1 }),
        message: Type.String({ minLength: 1, maxLength: 5000 }),
        history: Type.Array(Type.Object({
          role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), content: Type.String({ maxLength: 5000 }),
        }), { maxItems: 200 }),
        timezone: Type.String(),
        today: Type.String(),
        pageGuides: Type.Array(Type.Object({ key: Type.String(), page: Type.String(), summary: Type.String(), instructions: Type.String() })),
      }),
      response: {
        200: Type.Object({
          answer: Type.String(),
          details: Type.Array(Type.String()),
          // The action shapes are defined in owner-assistant/types.ts; passed through as they are.
          actions: Type.Array(Type.Object({ type: Type.String() }, { additionalProperties: true })),
        }),
      },
    },
  }, async (request, reply) => reply.send(await askOwnerAssistant(request.body as OwnerAssistantRequest)));
};
