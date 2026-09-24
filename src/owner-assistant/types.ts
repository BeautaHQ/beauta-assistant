/**
 * The owner assistant's contract with beauta-api.
 *
 * beauta-api asks on the owner's behalf and gets back a reply plus the actions
 * the agent proposes. Nothing here writes: the actions are only carried out
 * when the owner presses Confirm, by beauta-api, with the owner's own access.
 */

export type OwnerTurn = { role: "user" | "assistant"; content: string };

export type PageGuide = { key: string; page: string; summary: string; instructions: string };

export type OwnerAssistantRequest = {
  organizationId: number;
  message: string;
  /** The whole chat so far, oldest first. */
  history: OwnerTurn[];
  timezone: string;
  /** YYYY-MM-DD in the salon's timezone. */
  today: string;
  pageGuides: PageGuide[];
};

export type DayHours = { dayOfWeek: number; startTime: string; endTime: string; isOff: boolean };
export type SalonDayHours = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean };

/*
 * Ids: a positive id is a row that already exists. A negative id is something
 * proposed earlier in the same batch (a new service or addon) that does not
 * exist yet; beauta-api swaps it for the real id once that step has run.
 */

export type CreateServiceAction = {
  type: "CREATE_SERVICE"; tempId: number;
  name: string; description: string | null; durationMinutes: number; price: number; status: "PUBLIC" | "PRIVATE";
};

export type CreateAddonAction = {
  type: "CREATE_ADDON"; tempId: number;
  name: string; description: string | null; durationMinutes: number; price: number; serviceIds: number[];
};

/** Only the fields that change; null means leave as it is. */
export type UpdateServiceAction = {
  type: "UPDATE_SERVICE"; serviceId: number; serviceName: string;
  name: string | null; price: number | null; durationMinutes: number | null; status: "PUBLIC" | "PRIVATE" | null;
};

/** Only the fields that change; null means leave as it is. Service ids may be temporary ids from this batch. */
export type UpdateAddonAction = {
  type: "UPDATE_ADDON"; addonId: number; addonName: string;
  name: string | null; price: number | null; durationMinutes: number | null;
  attachServiceIds: number[]; detachServiceIds: number[];
};

export type CreateStaffAction = {
  type: "CREATE_STAFF"; tempId: number;
  name: string; phone: string | null; isActive: boolean;
  serviceIds: number[]; addonIds: number[];
  /** All seven days, 1 = Monday ... 7 = Sunday. */
  workingHours: DayHours[];
};

export type UpdateStaffAction = {
  type: "UPDATE_STAFF"; staffId: number; staffName: string;
  addServiceIds: number[]; removeServiceIds: number[]; addAddonIds: number[]; removeAddonIds: number[];
  /** Only the days that change. */
  workingHours: DayHours[];
};

export type CreateStaffBlockAction = {
  type: "CREATE_STAFF_BLOCK"; staffId: number; staffName: string;
  startDate: string; endDate: string; startTime: string | null; endTime: string | null; allDay: boolean; reason: string | null;
};

/**
 * Set a staff member's commission rate: for everything they do (itemType and
 * itemId null), or for one service or addon, which overrides their general
 * rate. Replaces the current rate for the same target; history is kept.
 * staffId and itemId may be temporary ids from this batch.
 */
export type SetCommissionAction = {
  type: "SET_COMMISSION"; staffId: number; staffName: string;
  itemType: "SERVICE" | "ADDON" | null; itemId: number | null; itemName: string | null; percentage: number;
};

/** Stop an active rate; that item falls back to the staff member's general rate. */
export type RemoveCommissionAction = {
  type: "REMOVE_COMMISSION"; ruleId: number; staffName: string; itemName: string | null; percentage: number;
};

/**
 * A booking the owner makes for a customer, found or created by phone.
 * staffId null means any free staff member. Everything the confirmation card
 * shows travels with it, so the owner confirms exactly what will be booked.
 */
export type CreateBookingAction = {
  type: "CREATE_BOOKING";
  phone: string; firstName: string; lastName: string; email: string | null; isNewCustomer: boolean;
  serviceId: number; serviceName: string; addonIds: number[]; addonNames: string[];
  staffId: number | null; staffName: string | null;
  date: string; time: string; endTime: string; people: number;
  durationMinutes: number; price: number; currency: string; notes: string | null; reminderEnabled: boolean;
};

/**
 * Move a booking. SAME keeps its staff member (the booking must have just
 * one); ANY lets the scheduling engine pick whoever is free.
 */
export type RescheduleBookingAction = {
  type: "RESCHEDULE_BOOKING"; bookingId: number; customer: string; phone: string; services: string[];
  from: string; toDate: string; toTime: string; toEndTime: string;
  staffMode: "SAME" | "ANY"; staffId: number | null; staffName: string | null;
};

/** Cancel a booking, or mark it a no-show. notifyCustomer emails them, with the reason if there is one. */
export type CancelBookingAction = {
  type: "CANCEL_BOOKING"; bookingId: number; customer: string; phone: string; services: string[]; staff: string[]; when: string;
  noShow: boolean; notifyCustomer: boolean; reason: string | null; refund: number | null; currency: string;
};

export type OwnerAction =
  | CreateServiceAction | UpdateServiceAction | CreateAddonAction | UpdateAddonAction
  | CreateStaffAction | UpdateStaffAction | CreateStaffBlockAction | SetCommissionAction | RemoveCommissionAction
  | CreateBookingAction | RescheduleBookingAction | CancelBookingAction;

export type OwnerAssistantResult = {
  /** The main message, plain text in the owner's language. */
  answer: string;
  /** One plain-text line per item: each change that will be made, each how-to step, or each option to choose from. */
  details: string[];
  /** In the order they must run. Empty when the agent only answered or asked. */
  actions: OwnerAction[];
};
