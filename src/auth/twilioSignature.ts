import { validateRequest } from "twilio";
import type { FastifyRequest } from "fastify";

import {
  PUBLIC_URL,
  TWILIO_AUTH_TOKEN,
  TWILIO_VOICE_AUTH_TOKEN,
  VERIFY_TWILIO_SIGNATURE,
} from "../config";

/**
 * The tokens a genuine webhook may be signed with: the calling region's own
 * first (AU1 for an Australian number), then the account's main one (US1).
 */
const signingTokens = [...new Set([TWILIO_VOICE_AUTH_TOKEN, TWILIO_AUTH_TOKEN].filter(Boolean))];

/**
 * Proves a webhook really came from Twilio.
 *
 * Twilio signs the full public URL plus the sorted POST parameters with the
 * auth token of the account — and region — the number belongs to. /incoming
 * is reachable by anyone on the internet, and without this check a stranger
 * could make the service answer calls that never happened — or run up the
 * phone bill.
 *
 * The URL is taken from PUBLIC_URL, not from the request: an ALB rewrites the
 * host and drops https before the request reaches us, so a URL rebuilt from
 * headers would never match what Twilio signed.
 */
export const isValidTwilioSignature = (
  request: FastifyRequest,
  path: string,
): boolean => {
  if (!VERIFY_TWILIO_SIGNATURE) return true;

  const signature = request.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;

  const url = `${PUBLIC_URL}${path}`;
  const params = (request.body ?? {}) as Record<string, string>;
  return signingTokens.some((token) => validateRequest(token, signature, url, params));
};
