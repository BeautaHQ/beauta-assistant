import { listAddons, listServices } from "../clients/beautaApi";

/**
 * The salon's price list, written out for the model.
 *
 * Handed over in the opening instructions rather than fetched through a tool.
 * A tool round costs the caller a second of silence before anything is said,
 * and the model was using that round to look up a list it then half-remembered
 * — quoting one service while booking another's id. Given the real ids up
 * front it has nothing left to invent.
 */
export interface Catalogue {
  text: string;
  serviceIds: Set<number>;
  /**
   * Which extras belong to which service.
   *
   * Kept apart from the text because the text is for reading and this is for
   * checking. Extras are per service, and the same one appears under many of
   * them — nothing about the prose stops a model attaching Cat Eyes, listed
   * under the acrylics, to a gel removal that does not offer it.
   */
  addonsByService: Map<number, { id: number; name: string; price: number }[]>;
  /**
   * Every extra the salon sells, whichever service it is listed under.
   *
   * Flat on purpose. Whether an id is real and whether it is listed under the
   * service someone picked are two different questions, and only the first has
   * an answer that is ours to give — the salon puts a pedicure extra on a
   * manicure when the customer asks for both, and that is their call.
   */
  addonIds: Set<number>;
  /**
   * The same price list as two flat lists: the services, then the extras.
   *
   * What `text` says is that an extra belongs under a service, which is true of
   * how the salon prices things and not of what a customer asks for. It also
   * repeats every extra under every service that offers it, so the one name the
   * reader is looking for appears a dozen times over, and once as a service in
   * its own right — a deluxe pedicure is both. Asked to pick an id out of that,
   * the model named the extra and left the id empty.
   *
   * Flat, each thing appears exactly once and the choice is a lookup. The
   * receptionist keeps the grouped version: it books with nobody watching, so
   * what the salon does and does not put together still binds it.
   */
  flatText: string;
  /**
   * Name to id, for the service list and the extras list.
   *
   * The model reads the names right and then hands back the wrong id — it said
   * DELUXE PEDICURE - NORMAL and gave the id next to DELUXE MANICURE. Picking
   * a number out of a list by eye is the one thing it is worst at, and the one
   * thing a map does perfectly, so the name it wrote decides the id.
   *
   * Keyed on the name lowercased with its spacing collapsed, because the price
   * list has entries like "DELUXE PEDICURE  - GEL" with two spaces in it.
   */
  serviceIdByName: Map<string, number>;
  addonIdByName: Map<string, number>;
  /** The other way round, so an extra is reported in the salon's own words. */
  addonNameById: Map<number, string>;
  /** The services alone — id, name, price, length — for the turn that settles which. */
  servicesText: string;
  /** Every extra once, for the turn that reads what the caller said. */
  extrasText: string;
  /** Price and length by service id, so the briefing can quote them without the list. */
  serviceById: Map<number, { name: string; price: number; durationMinutes: number }>;
}

/** Lowercase, single-spaced, trimmed. Two spellings of one name become one. */
export const nameKey = (name: string) =>
  name.trim().toLowerCase().replace(/\s+/g, " ");

interface Cached {
  at: number;
  value: Catalogue;
}

/*
 * Shared across calls on purpose: a price list is the same for everyone ringing
 * the same salon, and re-fetching it per call would put two dozen requests on
 * beauta-api every time the phone goes. Keyed by salon, because two salons on
 * one instance must never be shown each other's prices. Nothing caller-specific
 * lives here.
 */
const cached = new Map<number, Cached>();
const TTL_MS = 5 * 60 * 1000;

const money = (value: number) => `$${value}`;

const build = async (organizationId: number): Promise<Catalogue> => {
  const services = await listServices(organizationId);

  const addonsByService = await Promise.all(
    services.map(async (service) => {
      try {
        return await listAddons(organizationId, service.id);
      } catch {
        // One service's extras failing should not cost the receptionist the
        // whole price list.
        return [];
      }
    }),
  );

  /*
   * Every extra, once, in the order first met. The same extra is listed under
   * many services and the reader must not be shown it many times.
   */
  const everyAddon = new Map<number, { id: number; name: string; price: number }>();
  for (const addons of addonsByService) {
    for (const addon of addons) {
      if (!everyAddon.has(addon.id)) {
        everyAddon.set(addon.id, {
          id: addon.id,
          name: addon.name,
          price: addon.price,
        });
      }
    }
  }

  const byId = <T extends { id: number }>(items: T[]) =>
    [...items].sort((a, b) => a.id - b.id);

  const servicesText = [
    "SERVICES",
    ...byId(services).map(
      (service) =>
        `${service.id}. ${service.name} — ${money(service.price)}, ${service.durationMinutes} min`,
    ),
  ].join("\n");

  const extrasText = [
    "EXTRAS",
    ...byId([...everyAddon.values()]).map(
      (addon) => `${addon.id}. ${addon.name} — ${money(addon.price)}`,
    ),
  ].join("\n");

  const flatText = `${servicesText}\n\n${extrasText}`;

  const lines = services.map((service, index) => {
    const head = `${service.id}. ${service.name} — ${money(service.price)}, ${service.durationMinutes} min`;
    const addons = addonsByService[index] ?? [];
    if (addons.length === 0) return head;
    const extras = addons
      .map((addon) => `${addon.id}:${addon.name} ${money(addon.price)}`)
      .join("; ");
    return `${head}\n   extras — ${extras}`;
  });

  return {
    text: lines.join("\n"),
    serviceIds: new Set(services.map((service) => service.id)),
    flatText,
    servicesText,
    extrasText,
    serviceById: new Map(
      services.map((service) => [
        service.id,
        { name: service.name, price: service.price, durationMinutes: service.durationMinutes },
      ]),
    ),
    serviceIdByName: new Map(
      services.map((service) => [nameKey(service.name), service.id]),
    ),
    addonIdByName: new Map(
      [...everyAddon.values()].map((addon) => [nameKey(addon.name), addon.id]),
    ),
    addonNameById: new Map(
      [...everyAddon.values()].map((addon) => [addon.id, addon.name]),
    ),
    addonIds: new Set(addonsByService.flat().map((addon) => addon.id)),
    addonsByService: new Map(
      services.map((service, index) => [
        service.id,
        (addonsByService[index] ?? []).map((addon) => ({
          id: addon.id,
          name: addon.name,
          price: addon.price,
        })),
      ]),
    ),
  };
};

export const getCatalogue = async (organizationId: number): Promise<Catalogue> => {
  const hit = cached.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = await build(organizationId);

  /*
   * An empty price list is never cached.
   *
   * A salon with no services is not a thing; an empty answer means beauta-api
   * was unreachable or looking at the wrong database for that moment. Caching
   * it turns a blink into five minutes of "that service is not on the price
   * list" for every caller, and the receptionist cannot say anything useful
   * because as far as it can tell the salon sells nothing.
   */
  if (value.serviceIds.size === 0) return value;

  cached.set(organizationId, { at: Date.now(), value });
  return value;
};
