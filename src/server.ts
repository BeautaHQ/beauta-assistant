import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import {
  CHAT_ORIGINS,
  OPENAI_API_KEY,
  PORT,
  PUBLIC_URL,
  TWILIO_AUTH_TOKEN,
  VERIFY_TWILIO_SIGNATURE,
} from "./config";
import { incomingCallRouter } from "./routes/IncomingCallRoute";
import { conversationRelayRouter } from "./routes/ConversationRelayRoute";
import { conversationRouter } from "./routes/ConversationRoute";
import { enquiryRouter } from "./routes/EnquiryRoute";
import { handoffRouter } from "./routes/HandoffRoute";

/**
 * Beauta's phone line.
 *
 * A customer rings the salon, the salon's carrier forwards that call to a
 * Twilio number, and Twilio asks this service what to do with it. The answer
 * opens a WebSocket carrying the call's audio both ways, and an AI
 * receptionist talks to the caller through it.
 *
 * Deliberately not part of beauta-api: a call is a socket that lives for
 * minutes, and beauta-api deploys with --force-new-deployment, which would cut
 * every conversation in progress. Bookings are still made by beauta-api — this
 * service calls it rather than writing to the database, so a call goes through
 * the same availability and conflict rules as any other booking.
 */
export const buildServer = () => {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  /*
   * Twilio posts webhooks as application/x-www-form-urlencoded, not JSON.
   * Without this Fastify answers 415 before the handler runs, and every call
   * fails — invisibly, because the caller just hears nothing.
   */
  /*
   * Only the sites named in CHAT_ORIGINS. Twilio's webhooks are server to
   * server and need none of this; the chat widget is the only thing here a
   * browser ever calls.
   */
  if (CHAT_ORIGINS.length > 0) {
    app.register(cors, { origin: CHAT_ORIGINS, methods: ["GET", "POST", "DELETE"] });
  }

  app.register(formbody);
  app.register(websocket);

  app.register(swagger, {
    openapi: {
      info: {
        title: "Beauta Voice",
        version: "1.0.0",
        description:
          "The salon's phone line. Twilio drives /incoming and /stream; neither is callable by hand, so the interesting endpoints here are the simulator's, which hold the same conversation over HTTP.",
      },
    },
  });

  app.register(swaggerUI, {
    routePrefix: "/api-docs",
    uiConfig: { docExpansion: "list", deepLinking: false },
  });

  app.get(
    "/health",
    {
      schema: { tags: ["Service"], summary: "Liveness", operationId: "health" },
      /*
       * Silent on purpose. The load balancer polls this every few seconds, so
       * two lines per check drown everything worth reading — and a call that
       * went wrong is found by reading back, not by scrolling past health
       * checks. A failing task stops answering, which the balancer notices
       * without needing it written down here.
       */
      logLevel: "silent",
    },
    async () => ({ ok: true }),
  );

  app.register(async (instance) => {
    incomingCallRouter(instance);
    handoffRouter(instance);
    conversationRelayRouter(instance);
  });

  app.register(async (instance) => conversationRouter(instance), {
    prefix: "/api/v1/conversations",
  });

  /*
   * Enquiries are a separate job from conversations and share none of their
   * machinery — only the price list and the salon's clock.
   */
  app.register(async (instance) => enquiryRouter(instance), {
    prefix: "/api/v1/enquiries",
  });

  return app;
};

/**
 * Refuses to start misconfigured rather than answering calls badly: a missing
 * PUBLIC_URL means Twilio is handed a stream address that does not exist, and
 * an unverified webhook means anyone can drive this service.
 */
const assertConfigured = () => {
  if (!PUBLIC_URL) {
    throw new Error("PUBLIC_URL is required, e.g. https://voice.beauta.co");
  }
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required — the receptionist needs it to answer");
  }
  if (VERIFY_TWILIO_SIGNATURE && !TWILIO_AUTH_TOKEN) {
    throw new Error(
      "TWILIO_AUTH_TOKEN is required unless VERIFY_TWILIO_SIGNATURE=false",
    );
  }
};

if (require.main === module) {
  assertConfigured();
  const app = buildServer();
  app
    .listen({ port: PORT, host: "0.0.0.0" })
    .then(() =>
      app.log.info(
        { event: "voice_started", port: PORT, PUBLIC_URL },
        `Swagger on ${PUBLIC_URL || `http://localhost:${PORT}`}/api-docs`,
      ),
    )
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}
