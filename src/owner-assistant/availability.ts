import { BEAUTA_API_URL } from "../config";

/**
 * Free times, from beauta-api's scheduling engine.
 *
 * Availability is the one thing the owner assistant does not read from the
 * database itself: it depends on opening hours, special days, staff hours and
 * blocks, existing bookings and service and addon durations, and the engine
 * that works it out is the same one the booking page uses. Asking it keeps the
 * two from ever disagreeing. organizationId always comes from the request.
 */

const get = async <T>(path: string, params: URLSearchParams): Promise<T> => {
  const response = await fetch(`${BEAUTA_API_URL}/api/v1/availability${path}?${params}`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => null) as { data?: T; message?: string } | null;
  if (!response.ok || !body?.data) throw new Error(body?.message ?? `Availability request failed (${response.status})`);
  return body.data;
};

const withAddons = (params: URLSearchParams, addonIds: number[]) => {
  // Indexed keys so a single addon still parses as a list on the API side.
  addonIds.forEach((id, index) => params.set(`addonIds[${index}]`, String(id)));
  return params;
};

/** Start times (HH:mm) on one date when any staff member can do the service and addons, for `people` customers at once. */
export const availableTimes = async (organizationId: number, input: { serviceId: number; addonIds: number[]; date: string; people: number }) =>
  (await get<{ availableSlots: string[] }>("", withAddons(new URLSearchParams({
    organizationId: String(organizationId), serviceId: String(input.serviceId), date: input.date, quantity: String(input.people),
  }), input.addonIds))).availableSlots;

/** Start times (HH:mm) on one date when this staff member can do the service. The engine does not add addon time here. */
export const staffAvailableTimes = async (organizationId: number, input: { serviceId: number; staffId: number; date: string }) =>
  (await get<{ availableSlots: string[] }>("/with-staff", new URLSearchParams({
    organizationId: String(organizationId), serviceId: String(input.serviceId), date: input.date, staffId: String(input.staffId),
  }))).availableSlots;

/** Whether this exact start time is free for any staff member, with addons, for `people` customers at once. */
export const isTimeAvailable = async (organizationId: number, input: { serviceId: number; addonIds: number[]; date: string; time: string; people: number }) => {
  const response = await fetch(`${BEAUTA_API_URL}/api/v1/availability/check`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ organizationId, serviceId: input.serviceId, addonIds: input.addonIds, date: input.date, time: input.time, quantity: input.people }),
  });
  const body = await response.json().catch(() => null) as { data?: { isAvailable: boolean }; message?: string } | null;
  if (!response.ok || !body?.data) throw new Error(body?.message ?? `Availability check failed (${response.status})`);
  return body.data.isAvailable;
};
