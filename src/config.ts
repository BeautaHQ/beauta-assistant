/*
 * Loaded here, not in server.ts: imports run before the importing module's own
 * body, so an env file read there would land after this file had already read
 * process.env and found it empty.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // No .env — the environment itself must carry the settings.
}

/** Settings read once, so a missing one fails at boot rather than mid-call. */

export const PORT = Number(process.env.PORT) || 3003;

/**
 * This service's own public address, e.g. https://voice.beauta.co.
 *
 * Configured rather than derived from the request: behind an ALB the request
 * arrives as plain http on an internal hostname while Twilio signed the public
 * https URL, so a URL rebuilt from headers never matches the signature.
 */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";

/**
 * Off only for local tunnels. Never off in a deployed environment: /incoming is
 * a public URL, and without the check anyone can make this service answer.
 */
export const VERIFY_TWILIO_SIGNATURE =
  process.env.VERIFY_TWILIO_SIGNATURE !== "false";

/** Spoken by Twilio the moment the call connects, before the caller speaks. */
export const GREETING =
  process.env.GREETING ?? "Hi, you've reached the salon. How can I help?";

export const LANGUAGE = process.env.LANGUAGE ?? "en-AU";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
/*
 * gpt-4o rather than the mini. On the same scripted call the mini read nine
 * free times and told the caller three o'clock was not among them, offered the
 * first three slots of the day whatever was asked for, and took "no that's all,
 * thanks" as confirmation and booked. Same latency to first token. A
 * receptionist that mishears a yes is not worth the saving.
 */
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

/** The wss:// address Twilio is told to connect to. */
export const relayUrl = () => `${PUBLIC_URL.replace(/^http/, "ws")}/stream`;

/** Where beauta-api lives. Bookings go through it, never straight to the database. */
export const BEAUTA_API_URL = (
  process.env.BEAUTA_API_URL ?? "http://localhost:3001"
).replace(/\/$/, "");

/**
 * The salon to fall back on when the dialled number does not name one.
 *
 * Which salon a call belongs to is normally worked out from the number the
 * customer rang, at setup, and kept on the session. This covers the cases that
 * lookup cannot settle: a number stored against no organization, or against
 * several of them.
 */
export const DEFAULT_ORGANIZATION_ID = Number(process.env.ORGANIZATION_ID) || 0;

/**
 * Last-resort clock. The real one comes from the salon's own `timezone`
 * column — slots and "tomorrow" only mean anything in the salon's own day.
 */
export const DEFAULT_TIMEZONE = process.env.TIMEZONE ?? "Australia/Sydney";

/**
 * Whether to expose the text simulator at /simulator, and Swagger with it.
 *
 * Off unless asked for. It is not a mock: a booking made through it is a real
 * booking in a real diary, and the salon's customer gets the real confirmation
 * email. Fine against a dev database, never in front of a live one.
 */
export const ENABLE_SIMULATOR = process.env.ENABLE_SIMULATOR === "true";
