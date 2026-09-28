import type { Module } from "../toolkit";
import { catalogKnowledge } from "./catalog/knowledge";
import { catalogTools } from "./catalog/tools";
import { calendarKnowledge } from "./calendar/knowledge";
import { bookingChangeTools, bookingTools, calendarTools } from "./calendar/tools";
import { customersKnowledge } from "./customers/knowledge";
import { customersTools } from "./customers/tools";
import { analyticsKnowledge } from "./analytics/knowledge";
import { analyticsTools } from "./analytics/tools";
import { paymentsKnowledge } from "./payments/knowledge";
import { paymentsTools } from "./payments/tools";
import { supportKnowledge } from "./support/knowledge";
import { supportTools } from "./support/tools";

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
    summary: "free times for a service, checking a time, the bookings on a day, and booking, rescheduling, cancelling or changing the staff member of a customer's appointment",
    knowledge: calendarKnowledge,
    tools: [...calendarTools, ...bookingTools, ...bookingChangeTools],
    runOrder: ["CANCEL_BOOKING", "RESCHEDULE_BOOKING", "REASSIGN_STAFF", "CREATE_BOOKING"],
  },
  {
    name: "customers",
    summary: "customers: finding one by phone or name, their booking history and spending, loyalty points and how the salon's loyalty works, and customer enquiries (messages)",
    knowledge: customersKnowledge,
    tools: customersTools,
    // Looks only, for now: nothing to run.
    runOrder: [],
  },
  {
    name: "analytics",
    summary: "how the salon is doing over any range of dates: number of bookings by status, revenue from completed bookings, busiest days, bookings per staff member, most-booked services, new customers",
    knowledge: analyticsKnowledge,
    tools: analyticsTools,
    // Numbers only: nothing to run.
    runOrder: [],
  },
  {
    name: "payments",
    summary: "getting paid: whether the salon's bank account is connected (Stripe), why online payment or gift card sales are not working, and how to connect",
    knowledge: paymentsKnowledge,
    tools: paymentsTools,
    // Reads only: connecting a bank account happens on Stripe's own form.
    runOrder: [],
  },
  {
    name: "support",
    summary: "asking Beauta's team to do work for the salon: set the account up from a menu or price list, migrate data in from another system, or export the salon's data",
    knowledge: supportKnowledge,
    tools: supportTools,
    runOrder: ["CREATE_REQUEST"],
  },
];
