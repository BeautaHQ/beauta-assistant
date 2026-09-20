import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import {
  OPENAI_API_KEY,
  PORT,
  PUBLIC_URL,
  TWILIO_AUTH_TOKEN,
  VERIFY_TWILIO_SIGNATURE,
} from "./config";
import { incomingCallRouter } from "./routes/IncomingCallRoute";
import { conversationRelayRouter } from "./routes/ConversationRelayRoute";

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
  app.register(formbody);
  app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  app.register(async (instance) => {
    incomingCallRouter(instance);
    conversationRelayRouter(instance);
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
    .then(() => app.log.info({ event: "voice_started", port: PORT, PUBLIC_URL }))
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}
