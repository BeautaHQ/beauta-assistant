/**
 * Free times, grouped by part of the day.
 *
 * Every one of them. The diary runs on ten-minute steps, so a quiet day is
 * fifty-odd times, and an earlier version cut that to the half hours before
 * handing it over. That was a crutch for a weaker model, which had read nine
 * times and told the caller three o'clock was not among them; it also meant the
 * receptionist could not see 13:20 at all, and would tell a caller who asked
 * for it that it did not exist.
 *
 * So the whole list goes over, and choosing two or three to say out loud is the
 * model's job. The grouping is the one thing kept, because "the afternoon is
 * gone until five" is the sentence a caller actually wants, and it is easier to
 * reach from times already sorted into afternoons than from a flat list.
 */
export interface Offer {
  morning: string[];
  afternoon: string[];
  evening: string[];
}

const hourOf = (slot: string) => Number(slot.slice(0, 2));

export const offerable = (slots: string[]): Offer => {
  const between = (from: number, to: number) =>
    slots.filter((s) => hourOf(s) >= from && hourOf(s) < to);

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
    offer.morning.length > 0 ? `morning ${offer.morning.join(" ")}` : "morning none",
    offer.afternoon.length > 0
      ? `afternoon ${offer.afternoon.join(" ")}`
      : "afternoon none",
    offer.evening.length > 0 ? `evening ${offer.evening.join(" ")}` : "evening none",
  ];
  return parts.join(" | ");
};
