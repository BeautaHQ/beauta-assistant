import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { askOwnerAssistant } from "../owner-assistant";
import { OWNER_DOMAINS } from "../owner-assistant/types";

export const ownerAssistantRouter = (app: FastifyInstance) => {
  app.post("/ask", {
    schema: {
      tags: ["Owner Assistant"],
      body: Type.Object({
        message: Type.String({ minLength: 1, maxLength: 1000 }),
        timezone: Type.String(), today: Type.String(), tomorrow: Type.String(),
        pageGuides: Type.Array(Type.Object({ key: Type.String(), page: Type.String(), summary: Type.String(), instructions: Type.String() })),
        ownerContext: Type.Object({
          services: Type.Array(Type.Object({ id: Type.Number(), name: Type.String() })),
          addons: Type.Array(Type.Object({ id: Type.Number(), name: Type.String() })),
          salonWorkingHours: Type.Array(Type.Object({ dayOfWeek: Type.Number(), openTime: Type.String(), closeTime: Type.String(), isClosed: Type.Boolean() })),
        }),
      }),
      response: {
        200: Type.Object({
          intent: Type.Union([Type.Literal("FAQ"), Type.Literal("ACTION"), Type.Literal("CLARIFICATION")]),
          domain: Type.Union(OWNER_DOMAINS.map((value) => Type.Literal(value))),
          action: Type.Union([Type.Literal("CREATE_STAFF"), Type.Literal("CREATE_STAFF_BLOCK"), Type.Literal("CREATE_WORKING_HOUR_OVERRIDE"), Type.Literal("CREATE_SERVICE"), Type.Literal("NONE")]),
          status: Type.Union([Type.Literal("READY"), Type.Literal("NEEDS_CLARIFICATION"), Type.Literal("ANSWERED")]),
          answer: Type.String(), steps: Type.Array(Type.String()),
          pageKey: Type.Union([Type.String(), Type.Null()]), confidence: Type.Number(),
          parameters: Type.Object({
            staffName: Type.Union([Type.String(), Type.Null()]), startDate: Type.Union([Type.String(), Type.Null()]),
            endDate: Type.Union([Type.String(), Type.Null()]), startTime: Type.Union([Type.String(), Type.Null()]),
            endTime: Type.Union([Type.String(), Type.Null()]), allDay: Type.Union([Type.Boolean(), Type.Null()]),
            reason: Type.Union([Type.String(), Type.Null()]),
            services: Type.Array(Type.Object({
              name: Type.Union([Type.String(), Type.Null()]),
              description: Type.Union([Type.String(), Type.Null()]),
              durationMinutes: Type.Union([Type.Number(), Type.Null()]),
              price: Type.Union([Type.Number(), Type.Null()]),
              status: Type.Union([Type.Literal("PUBLIC"), Type.Literal("PRIVATE")]),
            })),
            workingHourOverride: Type.Union([Type.Object({
              startDate: Type.Union([Type.String(), Type.Null()]), endDate: Type.Union([Type.String(), Type.Null()]),
              isClosed: Type.Boolean(), openTime: Type.Union([Type.String(), Type.Null()]), closeTime: Type.Union([Type.String(), Type.Null()]),
            }), Type.Null()]),
            staff: Type.Array(Type.Object({
              name: Type.Union([Type.String(), Type.Null()]), phone: Type.Union([Type.String(), Type.Null()]), isActive: Type.Boolean(),
              serviceNames: Type.Array(Type.String()), addonNames: Type.Array(Type.String()),
              workingHours: Type.Array(Type.Object({ dayOfWeek: Type.Number(), startTime: Type.String(), endTime: Type.String(), isOff: Type.Boolean() })),
            })),
          }),
          confirmationRequired: Type.Boolean(),
        }),
      },
    },
  }, async (request, reply) => reply.send(await askOwnerAssistant(request.body as Parameters<typeof askOwnerAssistant>[0])));
};
