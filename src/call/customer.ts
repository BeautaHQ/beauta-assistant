import { createHash } from "node:crypto";

import { prisma } from "../clients/prisma";
import { CUSTOMER_AUTH_SECRET } from "../config";
import type { CallSession } from "./session";

/**
 * Who the customer is, when the platform already knows.
 *
 * Two ways in. A visitor signed in on the booking site carries the bearer
 * token beauta-api issued at OTP sign-in; the chat widget passes it along when
 * it opens the conversation, and the token's hash is looked up in
 * `customer_session` the same way beauta-api does. A phone caller is known by
 * caller ID. Either way the number is then matched to `customer_profile`, the
 * name and email the customer keeps for themselves across every salon.
 *
 * Read straight from the tables, like everything else this service knows: it
 * reads beauta-api's database and writes only through its API.
 */
export interface KnownCustomer {
  phone: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /** Signed in on the booking site, or recognised from the number they rang from. */
  how: "signed-in" | "caller-id";
}

// Must match beauta-api's digest(): `${secret}:${token}`, SHA-256, hex.
const digest = (token: string): string =>
  createHash("sha256").update(`${CUSTOMER_AUTH_SECRET}:${token}`).digest("hex");

const profileFor = async (phone: string) => {
  const profile = await prisma.customerProfile.findUnique({
    where: { phone },
    select: { firstName: true, lastName: true, email: true },
  });
  return {
    firstName: profile?.firstName?.trim() || null,
    lastName: profile?.lastName?.trim() || null,
    email: profile?.email?.trim() || null,
  };
};

/** The customer a booking-site bearer token belongs to, or null if it is not a live session. */
export const customerFromToken = async (token: string): Promise<KnownCustomer | null> => {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const session = await prisma.customerSession.findUnique({
    where: { tokenHash: digest(trimmed) },
    select: { phone: true, expiresAt: true, revokedAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  return { phone: session.phone, ...(await profileFor(session.phone)), how: "signed-in" };
};

/**
 * The customer behind a caller ID, if they have a profile. Only a profile
 * counts: the number alone is already on the booking from caller ID, and a
 * name is what saves them being asked.
 */
export const customerFromCallerId = async (phone: string): Promise<KnownCustomer | null> => {
  if (!phone.startsWith("+")) return null;
  const details = await profileFor(phone);
  if (!details.firstName && !details.lastName) return null;
  return { phone, ...details, how: "caller-id" };
};

/**
 * Put what is known onto the call, so the receptionist never asks for it.
 *
 * The booking's fields are filled rather than only noted for the prompt:
 * `missingFields` reads the booking, and that is what decides whether the
 * name and number are asked for.
 */
export const adoptCustomer = (session: CallSession, customer: KnownCustomer | null): void => {
  if (!customer) return;
  session.customer = customer;
  session.booking.phone = customer.phone;
  if (customer.firstName) session.booking.firstName = customer.firstName;
  if (customer.lastName) session.booking.lastName = customer.lastName;
  if (customer.email && !session.booking.email) session.booking.email = customer.email;
};
