/**
 * Staff, services and addons: the salon's menu and the people who deliver it.
 * They belong together because each only works through the others.
 *
 * Only what the agent needs to reason with is here. Hard rules (hours inside
 * opening hours, ids that exist, prices that are whole numbers) are checked by
 * the tools, which tell the agent exactly what is wrong when it gets one wrong.
 */
export const catalogKnowledge = `STAFF, SERVICES AND ADDONS
- Service: what customers book (price, minutes; PUBLIC shows on the booking page, PRIVATE is salon-only). Addon: an extra attached to services, offered only with them.
- Staff: weekly hours for all 7 days, inside the salon's opening hours, plus the services and addons they do. Staff with no services cannot be booked.
- Assign only the services and addons the owner names. If they name none for a new staff member, assign none and mention they cannot be booked until they have some; never assign everything on your own.
- A block is time off on specific dates; changing usual weekly hours is a staff update.
- Commission: the percentage of the price a staff member earns. Each rate belongs to one staff member: a general rate for everything they do, and optional rates for single services or addons that override it. Setting a rate replaces the current one for the same staff and item. Removing a single-item rate makes that item fall back to the general rate.
- Names are not unique, so work with ids. If a name matches several items, ask which (show price and duration).
- A request covering several things: services first, then addons, then staff, then commission.
- New services: propose straight from the owner's words; do not read the service list first. Price and duration must come from the owner: if either is missing, ask.
- Never delete staff, services or addons (hard to undo, staff have bookings): say you won't, and tell them how to delete it themselves on that page, from get_portal_guide.`;
