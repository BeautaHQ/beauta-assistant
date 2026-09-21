import { GREETING } from "../config";

/**
 * The first thing said, before anyone has said anything.
 *
 * Says whose salon it is, so a caller knows straight away they rang the right
 * number — "you've reached the salon" tells them nothing.
 *
 * "Virtual" rather than "AI": it is warmer to hear, and it still tells the
 * caller they are not speaking to one of the staff, which is the part that
 * matters. Callers who work that out halfway through tend to mind more than
 * those told at the start, and some places require the disclosure outright.
 *
 * Phone and chat differ only in what follows. A caller cannot skim a list of
 * what the assistant can do, so the phone opening stops after the question;
 * chat can afford the extra clause and benefits from it, because a text box
 * gives no clue what may be typed into it.
 */
export const openingLine = (
  channel: "PHONE" | "CHAT",
  salonName: string | null,
): string => {
  /*
   * Nothing identified the salon, so fall back to whatever was configured
   * rather than greet them by the name of a salon we are guessing at.
   *
   * "the salon" counts as nothing: it is the placeholder a lookup returns when
   * no organization matched, and threading it through produced "you've reached
   * the salon, I'm the salon's AI receptionist".
   */
  if (!salonName || salonName.trim().toLowerCase() === "the salon") return GREETING;

  return channel === "CHAT"
    ? `Hi, I'm the virtual receptionist for ${salonName}. Ask me anything about our services, or tell me what you'd like booked and I'll take care of it.`
    : `Hi, you've reached ${salonName}. I'm the virtual receptionist — how can I help?`;
};
