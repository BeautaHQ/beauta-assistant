import { checkAvailability } from "../clients/beautaApi";
import { mergeBooking, missingFields, type BookingState } from "../call/booking";
import type { CallSession } from "../call/session";
import { nameKey, type Catalogue } from "../salon/catalogue";
import type { Filled, Intent } from "./intent";

/**
 * The steps of a booking, in the order they are asked.
 *
 * Left to right, and the first one still open is what the next turn asks for.
 * Nothing further right is touched until everything to its left is settled:
 * the extras decide how long the appointment is, so the diary is not asked
 * about a time until they are known, and a caller who names a day and a time
 * before a service is asked for the service first.
 */
export type Step = "SERVICE" | "ADDONS" | "DAY" | "TIME" | "INFO" | "REVIEW" | "BOOK";

/**
 * The service they named, as an id the price list recognises.
 *
 * The name wins over the number. Reading a service out of a sentence is what
 * the model is for; finding that row in a list is not, and it hands back the
 * id next to the right one often enough to matter.
 */
const resolveService = (catalogue: Catalogue | null, filled: Filled): number | null => {
  if (!catalogue) return null;
  const byName = filled.serviceName
    ? catalogue.serviceIdByName.get(nameKey(filled.serviceName))
    : undefined;
  if (byName !== undefined) return byName;
  return filled.serviceId && catalogue.serviceIds.has(filled.serviceId) ? filled.serviceId : null;
};

/**
 * The extras they named, as ids, whichever service they end up under — and
 * the names that matched nothing at all.
 *
 * Something the salon does not sell as an extra is not dropped quietly. The
 * caller has heard themselves ask for it, and a reply that says nothing lets
 * them believe it is on the booking; the model then read one back off the
 * transcript that the booking never had.
 */
const resolveAddons = (
  catalogue: Catalogue | null,
  filled: Filled,
): { ids: number[]; unknown: string[] } => {
  if (!catalogue) return { ids: [], unknown: [] };
  const ids = new Set<number>();
  const unknown: string[] = [];
  filled.addonNames.forEach((name, index) => {
    const byName = catalogue.addonIdByName.get(nameKey(name));
    const paired = filled.addonIds[index];
    const id =
      byName ?? (paired !== undefined && catalogue.addonIds.has(paired) ? paired : null);
    if (id !== null) ids.add(id);
    else unknown.push(name);
  });
  // Ids with no name beside them — the model listed more ids than names.
  filled.addonIds.slice(filled.addonNames.length).forEach((id) => {
    if (catalogue.addonIds.has(id)) ids.add(id);
  });
  return { ids: [...ids], unknown };
};

/**
 * Drop extras the chosen service does not offer, and remember which.
 *
 * The service is still what the caller asked for, so it stays; only the extras
 * that do not belong to it go, and their names are kept so the reply can say
 * what happened and offer what is actually available. Run every turn, because
 * an extra named before the service was settled can only be checked now.
 */
const pruneStrayAddons = (session: CallSession) => {
  session.rejectedAddons = [];

  const { serviceId, addonIds } = session.booking;
  const allowed = serviceId ? session.catalogue?.addonsByService.get(serviceId) : null;
  if (!allowed || addonIds.length === 0) return;

  const ok = new Set(allowed.map((addon) => addon.id));
  const kept: number[] = [];
  for (const id of addonIds) {
    if (ok.has(id)) kept.push(id);
    else session.rejectedAddons.push(session.catalogue?.addonNameById.get(id) ?? `extra ${id}`);
  }

  session.booking.addonIds = kept;
  session.booking.addonNames = kept.map(
    (id) => session.catalogue?.addonNameById.get(id) ?? `extra ${id}`,
  );
};

/** What the times on hand were fetched for. A different appointment needs a fresh look. */
const offerKey = (booking: BookingState) =>
  `${booking.serviceId}|${booking.date}|${[...booking.addonIds].sort().join(",")}|${booking.quantity}`;

/**
 * Ask the diary, once the booking is settled enough to ask it about.
 *
 * Only after the service and its extras: they decide how long the appointment
 * is and how many staff it needs, and times fetched before they were known
 * were times for a different appointment. With a day, the free times are
 * fetched so the reply can offer them. With a day and a time, the time is
 * checked against them — and dropped if it is not one of them, with the list
 * kept so the reply can offer the nearest.
 */
const readDiary = async (session: CallSession) => {
  const booking = session.booking;
  if (!booking.serviceId || booking.quantity === null || !booking.date) return;

  const key = offerKey(booking);
  if (session.offered?.key !== key) {
    try {
      const result = await checkAvailability({
        organizationId: session.salon.organizationId,
        serviceId: booking.serviceId,
        date: booking.date,
        addonIds: booking.addonIds,
        quantity: booking.quantity,
      });
      session.offered = {
        serviceId: booking.serviceId,
        date: result.date,
        slots: result.availableSlots,
        key,
      };
    } catch {
      // The briefing reads an unreachable diary off this, and says so.
      session.offered = null;
      return;
    }
  }

  session.rejectedTime = null;
  if (booking.time && !session.offered.slots.includes(booking.time)) {
    session.rejectedTime = booking.time;
    booking.time = null;
  }
};

/**
 * Put what the caller just said into the booking, checked.
 *
 * Only while a new booking is being made. Someone changing an appointment is
 * not filling in a form, and a day they mention is the day their booking is
 * on, not a day to book.
 */
export const absorb = async (session: CallSession, filled: Filled): Promise<void> => {
  if (session.bookingPublicId || session.managing || session.lastIntent === "MANAGE") return;

  const catalogue = session.catalogue;
  const said: Partial<BookingState> = {};

  /*
   * Once a service is settled it stays settled, unless they ask to change it.
   *
   * The salon sells a deluxe manicure on its own and as an extra on top of a
   * set, under one name. A caller who has chosen a back fill and then says
   * "deluxe manicure" is adding to it — and the model put the name in the
   * service slot, which quietly swapped the whole booking to a different
   * service and offered times for that instead. So a service named after one
   * is chosen is taken as an extra if it is one, and otherwise ignored; only
   * an explicit ask to swap, which the model flags, changes the service.
   */
  const serviceId = resolveService(catalogue, filled);
  const settled = session.booking.serviceId !== null;
  const alsoAnExtra =
    filled.serviceName !== null &&
    catalogue?.addonIdByName.has(nameKey(filled.serviceName)) === true;

  if (serviceId !== null && (!settled || filled.changeService)) {
    said.serviceId = serviceId;
    said.serviceName = catalogue?.serviceById.get(serviceId)?.name ?? filled.serviceName;
  }

  const readAsExtra = settled && !filled.changeService && alsoAnExtra && filled.serviceName;
  const addons = resolveAddons(
    catalogue,
    readAsExtra ? { ...filled, addonNames: [...filled.addonNames, filled.serviceName!] } : filled,
  );
  // mergeBooking reads an empty list beside a head count as "no extras", so
  // the extras already on file are handed back when nothing new was said.
  said.addonIds = addons.ids.length > 0 ? addons.ids : session.booking.addonIds;
  if (filled.quantity && filled.quantity > 0) said.quantity = filled.quantity;

  if (filled.date && /^\d{4}-\d{2}-\d{2}$/.test(filled.date)) said.date = filled.date;
  if (filled.time && /^\d{2}:\d{2}$/.test(filled.time)) said.time = filled.time;
  if (filled.firstName?.trim()) said.firstName = filled.firstName.trim();
  if (filled.lastName?.trim()) said.lastName = filled.lastName.trim();

  // On a call the number is caller ID and never the model's to change.
  if (session.channel === "CHAT") {
    if (filled.phone?.trim()) said.phone = filled.phone.trim();
    if (filled.email?.trim()) said.email = filled.email.trim();
  }

  session.booking = mergeBooking(session.booking, said);
  pruneStrayAddons(session);
  session.rejectedAddons.push(...addons.unknown);
  await readDiary(session);
};

/**
 * Where the booking is up to: the first step, left to right, still open.
 */
export const currentStep = (session: CallSession, intent: Intent): Step => {
  const [first] = missingFields(session.booking);
  switch (first) {
    case "service":
      return "SERVICE";
    case "extras and how many people":
      return "ADDONS";
    case "date":
      return "DAY";
    case "time":
      return "TIME";
    case "full name":
    case "phone number":
      return "INFO";
    case "confirmation":
      return session.reviewed && intent === "CONFIRM" ? "BOOK" : "REVIEW";
    default:
      return "BOOK";
  }
};

/**
 * What the label decides, and what it does not.
 *
 * The label says what kind of turn this is. Whether a yes counts is not its
 * call: nothing is confirmed that was never read back, and a yes to nothing is
 * a booking turn like any other. A finished call has nothing left to book, and
 * a caller halfway through changing a booking stays there whatever a stray
 * label says.
 */
export const enforce = (labelled: Intent, session: CallSession): Intent => {
  if (session.bookingPublicId) {
    return labelled === "BOOK" || labelled === "CONFIRM" ? "OTHER" : labelled;
  }

  const changingExisting = session.managing !== null || session.lastIntent === "MANAGE";
  if (changingExisting) {
    if (labelled === "CONFIRM") return session.reviewed ? "CONFIRM" : "MANAGE";
    return labelled === "BOOK" ? "MANAGE" : labelled;
  }

  if (labelled === "CONFIRM" && !session.reviewed) return "BOOK";
  return labelled;
};
