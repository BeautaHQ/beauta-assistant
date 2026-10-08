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
 * The auth token calls are signed with, when it is not the account's main one.
 *
 * Twilio keeps credentials per region: a number whose active region is
 * Australia (AU1) has its calls signed with the AU1 auth token, not the US1
 * one the rest of Beauta (SMS) uses. Set this to the AU1 live auth token.
 * Both are accepted, so a number still processed in US1 keeps working.
 */
export const TWILIO_VOICE_AUTH_TOKEN = process.env.TWILIO_VOICE_AUTH_TOKEN ?? "";

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

/**
 * Who turns the caller's speech into text, set on every call's TwiML — no
 * Twilio console setting involved. Google's telephony model is trained on
 * phone audio; Deepgram (e.g. nova-3-general) is the other provider Twilio offers.
 */
export const STT_PROVIDER = process.env.STT_PROVIDER || "Google";
export const STT_MODEL = process.env.STT_MODEL || "telephony";

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

/** Where Twilio asks what to do once the receptionist lets go of the call. */
export const handoffUrl = () => `${PUBLIC_URL}/handoff`;

/** Where beauta-api lives. Bookings go through it, never straight to the database. */
/**
 * Where customers book for themselves, so the receptionist can point a caller
 * who asks "how do I book?" at the salon's own page. Optional: without it the
 * answer is "on our website" and nothing more specific.
 */
export const BOOKING_SITE_URL = (process.env.BOOKING_SITE_URL || "https://booking.beauta.co").replace(/\/$/, "");

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
 * Sites allowed to call the conversation API from a browser, comma separated.
 *
 * The booking site runs on its own origin, so without this the widget's
 * requests never leave the browser. Empty allows none, which is the whole of
 * the browser-side control: there is no separate on/off switch, because a
 * switch that has to be remembered is one that gets forgotten, and the chat
 * widget is a shipped feature rather than a thing to opt into.
 */
export const CHAT_ORIGINS = (process.env.CHAT_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Where to send a call this service cannot serve.
 *
 * A number that matches no salon leaves the receptionist with no price list
 * and no diary, so it must not answer. With this set the caller is put through
 * to a person; without it they are told plainly and the call ends. Either is
 * better than an assistant improvising about a salon it knows nothing about.
 *
 * Never derived from the call itself: on a forwarded call the salon's own line
 * is what forwarded it, so dialling that would loop.
 */
export const FORWARD_UNKNOWN_TO = process.env.FORWARD_UNKNOWN_TO ?? "";
