import { BEAUTA_API_URL } from "../config";

/**
 * The salon's real data, over the same public endpoints the booking website
 * uses.
 *
 * Bookings go through here rather than into the database directly: beauta-api's
 * createBooking checks the slot is still free, builds the per-staff tasks, and
 * sends the confirmation emails. A phone booking has to obey the same rules as
 * a web one, or the diary quietly goes wrong.
 */

const call = async <T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> => {
  /*
   * A caller is holding the line, so a hung API must fail fast enough that the
   * receptionist can apologise rather than leave them on silence.
   */
  const timeout = AbortSignal.timeout(init?.timeoutMs ?? 8000);
  const response = await fetch(`${BEAUTA_API_URL}${path}`, {
    ...init,
    signal: timeout,
    headers: {
      // Only when there is something to describe. Fastify rejects a request
      // that announces JSON and then sends nothing, which is what a PATCH with
      // no body looks like.
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    throw new Error(body?.message ?? `beauta-api ${response.status} on ${path}`);
  }
  return body?.data as T;
};

export interface Service {
  id: number;
  name: string;
  price: number;
  durationMinutes: number;
}

export interface Addon {
  id: number;
  name: string;
  price: number;
  duration: number;
}

export const listServices = (organizationId: number) =>
  call<Service[]>(`/api/v1/public/organizations/${organizationId}/services`);

export const listAddons = (organizationId: number, serviceId: number) =>
  call<Addon[]>(
    `/api/v1/public/organizations/${organizationId}/services/${serviceId}/addons`,
  );

/** Free start times for a service on one day, as "HH:mm" in the salon's zone. */
export const checkAvailability = (params: {
  organizationId: number;
  serviceId: number;
  date: string;
  addonIds?: number[];
  /** Two people need two staff free at once, so the diary must be asked for both. */
  quantity?: number;
}) => {
  const query = new URLSearchParams({
    serviceId: String(params.serviceId),
    date: params.date,
    organizationId: String(params.organizationId),
    quantity: String(params.quantity ?? 1),
  });
  for (const id of params.addonIds ?? []) query.append("addonIds", String(id));

  return call<{ date: string; availableSlots: string[]; unavailableSlots: string[] }>(
    `/api/v1/availability?${query.toString()}`,
  );
};

/**
 * beauta-api parses local times with dayjs against "YYYY-MM-DD HH:mm", so an
 * ISO-style T between the date and the time parses to an invalid date and the
 * booking lands in 1970 — or is rejected. Models write the T by habit, so
 * straighten it here rather than hoping the prompt holds.
 */
const localDateTime = (value: string) => value.replace("T", " ").slice(0, 16);

/** The salon goes in the path, so it has no business in the body as well. */
const rest = <T extends { organizationId: number }>({ organizationId, ...body }: T) =>
  body;

/**
 * Is this one slot still free, right now?
 *
 * The same check the booking site runs on its confirm page. The day's times
 * were read when the caller asked about that day, and a phone call can sit on
 * one question for minutes — long enough for the website to take the slot. Ask
 * again at the last moment, so a caller who has just said yes is told the truth
 * rather than an error about the diary being unreachable.
 */
export const isSlotFree = (params: {
  organizationId: number;
  serviceId: number;
  date: string;
  time: string;
  addonIds?: number[];
  quantity?: number;
}) =>
  call<{ isAvailable: boolean }>(`/api/v1/availability/check`, {
    method: "POST",
    body: JSON.stringify({
      serviceId: params.serviceId,
      addonIds: params.addonIds ?? [],
      date: params.date,
      time: params.time,
      organizationId: params.organizationId,
      quantity: params.quantity ?? 1,
    }),
  });

export const createBooking = (input: {
  organizationId: number;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string | null;
  serviceId: number;
  addonIds: number[];
  startTime: string;
  quantity?: number;
  customerNotes?: string | null;
  /** Which channel took the booking, so the salon can tell it from the website. */
  source: "AI_CALL" | "AI_CHAT";
}) =>
  call<{ bookingPublicId: string; startTime: string; checkoutUrl: string | null }>(
    `/api/v1/bookings/public/organization/${input.organizationId}`,
    {
      method: "POST",
      body: JSON.stringify({
        ...rest(input),
        startTime: localDateTime(input.startTime),
        // Required by the schema, and a phone caller rarely spells one out.
        email: input.email ?? null,
        status: "SCHEDULED",
        quantity: input.quantity ?? 1,
        reminderEnabled: true,
        bookingPaymentType: "IN_PERSON",
      }),
    },
  );

export const joinWaitlist = (input: {
  organizationId: number;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string | null;
  serviceId: number;
  addonIds?: number[];
  slots: { startTime: string; endTime: string }[];
  notes?: string;
}) =>
  call<unknown>(
    `/api/v1/bookings/public/waitlist/organization/${input.organizationId}`,
    {
      method: "POST",
      body: JSON.stringify({
        ...rest(input),
        email: input.email ?? null,
        slots: input.slots.map((slot) => ({
          startTime: localDateTime(slot.startTime),
          endTime: localDateTime(slot.endTime),
        })),
      }),
    },
  );

export interface FoundBooking {
  bookingPublicId: string;
  firstName: string;
  lastName: string;
  serviceId: number | null;
  serviceName: string | null;
  addonIds: number[];
  addonNames: string[];
  quantity: number;
  /** "YYYY-MM-DD HH:mm" in the salon's timezone. */
  startTime: string;
}

/**
 * This caller's bookings on one day.
 *
 * The number is the caller's own, taken from caller ID rather than from
 * anything said during the call, so what comes back is their own day and
 * nobody else's. The exact minute is not asked for: someone ringing up
 * remembers "Saturday" far better than "two twenty".
 */
export const findBookings = (params: {
  organizationId: number;
  phone: string;
  date: string;
}) => {
  const query = new URLSearchParams({ phone: params.phone, date: params.date });

  return call<FoundBooking[]>(
    `/api/v1/bookings/public/organization/${params.organizationId}/find?${query.toString()}`,
  );
};

export const cancelBooking = (params: {
  organizationId: number;
  bookingPublicId: string;
}) =>
  call<unknown>(
    `/api/v1/bookings/public/${params.bookingPublicId}/organization/${params.organizationId}/cancel`,
    { method: "PATCH" },
  );

/** Moves an existing booking. The service, extras and party size are unchanged. */
export const rescheduleBooking = (params: {
  organizationId: number;
  bookingPublicId: string;
  newStartTime: string;
}) =>
  call<unknown>(
    `/api/v1/bookings/public/organization/${params.organizationId}/${params.bookingPublicId}/reschedule`,
    {
      method: "PATCH",
      body: JSON.stringify({ newStartTime: localDateTime(params.newStartTime) }),
    },
  );
