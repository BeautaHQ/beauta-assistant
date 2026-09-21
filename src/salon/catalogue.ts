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
  };
};

export const getCatalogue = async (organizationId: number): Promise<Catalogue> => {
  const hit = cached.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await build(organizationId);
  cached.set(organizationId, { at: Date.now(), value });
  return value;
};
