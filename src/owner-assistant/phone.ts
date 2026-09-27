/**
 * Phone numbers, in the E.164 shape beauta-api stores (+61412345678).
 *
 * Beauta runs in Australia and New Zealand, so a number typed with a leading
 * 0 takes the salon's country from its timezone. The dial codes are the same
 * list the org app's phone input offers (beauta-org-app constant/countries.ts).
 */

/** Country dial codes, without the "+", from the org app's phone input. */
export const DIAL_CODES = [
  "61", "55", "1", "86", "33", "49", "852", "91", "62", "353", "39", "81", "60", "31", "64",
  "63", "966", "65", "27", "82", "34", "46", "41", "886", "66", "971", "44", "84",
] as const;

/** The salon's own dial code, from its timezone. Only the two countries Beauta runs in. */
export const salonDialCode = (timezone: string): string | null => {
  if (timezone.startsWith("Australia/")) return "61";
  if (timezone === "Pacific/Auckland" || timezone === "Pacific/Chatham") return "64";
  return null;
};

/**
 * The number as +<country><number>, or null when it cannot be settled:
 * - "+61 412 345 678" and "0061412345678" keep their country code;
 * - "0412 345 678" swaps the 0 for the salon's code (+61 or +64);
 * - "61412345678" already starts with a known code and just gains its "+";
 * - "412345678" (the 0 left off) takes the salon's code.
 * E.164 numbers are 8-15 digits long counting the country code.
 */
export const toE164 = (typed: string, timezone: string): string | null => {
  const raw = typed.trim();
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;

  let number: string | null;
  if (raw.startsWith("+")) number = digits;
  else if (digits.startsWith("00")) number = digits.slice(2);
  else {
    const home = salonDialCode(timezone);
    if (digits.startsWith("0")) number = home ? home + digits.slice(1) : null;
    else if (DIAL_CODES.some((code) => digits.startsWith(code)) && digits.length >= 10) number = digits;
    else number = home ? home + digits : null;
  }

  return number && number.length >= 8 && number.length <= 15 ? `+${number}` : null;
};
