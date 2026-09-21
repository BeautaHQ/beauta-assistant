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
}

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
