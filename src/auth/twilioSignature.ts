import { validateRequest } from "twilio";
import type { FastifyRequest } from "fastify";

import {
  PUBLIC_URL,
  TWILIO_AUTH_TOKEN,
  VERIFY_TWILIO_SIGNATURE,
} from "../config";

/**
 * Proves a webhook really came from Twilio.
 *
 * Twilio signs the full public URL plus the sorted POST parameters with the
 * account's auth token. /incoming is reachable by anyone on the internet, and
 * without this check a stranger could make the service answer calls that never
 * happened — or run up the phone bill.
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

  return validateRequest(
    TWILIO_AUTH_TOKEN,
    signature,
    `${PUBLIC_URL}${path}`,
    (request.body ?? {}) as Record<string, string>,
  );
};
