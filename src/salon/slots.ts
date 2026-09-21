/**
 * Free times, cut down to the ones worth saying out loud.
 *
 * The diary runs on ten-minute steps, so a quiet day comes back as sixty
 * times. Read to a caller that is absurd, and handed to a model whole it was
 * worse than absurd: it offered "nine, ten past, twenty past" off the top of
 * the list and then claimed two o'clock was taken while two o'clock sat in the
 * same list it was holding.
 *
 * So the half hours are what gets offered. The full list still decides what is
 * bookable — a caller who asks for ten past two gets ten past two.
 */
export interface Offer {
  morning: string[];
  afternoon: string[];
  evening: string[];
}

const hourOf = (slot: string) => Number(slot.slice(0, 2));

export const offerable = (slots: string[]): Offer => {
  const rounded = slots.filter((s) => s.endsWith(":00") || s.endsWith(":30"));
  const usable = rounded.length > 0 ? rounded : slots;
  const between = (from: number, to: number) =>
    usable.filter((s) => hourOf(s) >= from && hourOf(s) < to);

  return {
    morning: between(0, 12),
    afternoon: between(12, 17),
    evening: between(17, 24),
  };
};

/** The same thing on one line, for the briefing. */
export const describeOffer = (slots: string[]): string => {
  if (slots.length === 0) return "none, that day is full";
  const offer = offerable(slots);
  const parts = [
    offer.morning.length > 0 ? `morning ${offer.morning.join(" ")}` : null,
    offer.afternoon.length > 0 ? `afternoon ${offer.afternoon.join(" ")}` : null,
    offer.evening.length > 0 ? `evening ${offer.evening.join(" ")}` : null,
  ].filter(Boolean);
  return `${parts.join(" | ")} (any ten-minute time in between is bookable too)`;
};
