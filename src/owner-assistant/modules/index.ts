import type { Module } from "../toolkit";
import { catalogKnowledge } from "./catalog/knowledge";
import { catalogTools } from "./catalog/tools";
import { calendarKnowledge } from "./calendar/knowledge";
import { bookingChangeTools, bookingTools, calendarTools } from "./calendar/tools";
import { customersKnowledge } from "./customers/knowledge";
import { customersTools } from "./customers/tools";

/**
 * Every module the agent can load. It starts with only their summaries and
 * loads the ones a request needs, so a request pays for the knowledge and
 * tools it uses rather than for all of them.
 */
export const MODULES: Module[] = [
  {
    name: "catalog",
    summary: "staff (create, update hours, services and addons they do, time off), services and addons (create, update), commission rates, the salon's opening hours",
    knowledge: catalogKnowledge,
    tools: catalogTools,
    runOrder: ["CREATE_SERVICE", "UPDATE_SERVICE", "CREATE_ADDON", "UPDATE_ADDON", "CREATE_STAFF", "UPDATE_STAFF", "REMOVE_COMMISSION", "SET_COMMISSION", "CREATE_STAFF_BLOCK"],
  },
  {
    name: "calendar",
    summary: "free times for a service, checking a time, the bookings on a day, and booking, rescheduling or cancelling a customer's appointment",
    knowledge: calendarKnowledge,
    tools: [...calendarTools, ...bookingTools, ...bookingChangeTools],
    runOrder: ["CANCEL_BOOKING", "RESCHEDULE_BOOKING", "CREATE_BOOKING"],
  },
  {
    name: "customers",
    summary: "customers: finding one by phone or name, their booking history and spending, loyalty points and how the salon's loyalty works, and customer enquiries (messages)",
    knowledge: customersKnowledge,
    tools: customersTools,
    // Looks only, for now: nothing to run.
    runOrder: [],
  },
];
