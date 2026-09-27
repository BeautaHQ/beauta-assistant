/** The salon's customers: who they are, what they have booked, their loyalty points and their enquiries. Read only for now. */
export const customersKnowledge = `CUSTOMERS
- A customer is one person at this salon, identified by phone number. Only this salon's customers exist for you: if a lookup finds nobody, say there is no such customer.
- Look up by phone with find_customer. When the owner only knows a name or part of a number, use search_customers; if several match, list them with their phone and ask which.
- get_customer_history gives their bookings: upcoming, past visits with services, addons and staff, cancellations and no-shows, and what they have spent (completed bookings).
- Booking statuses: SCHEDULED (upcoming or not yet closed), COMPLETED, CANCELED, NO_SHOW.
- Loyalty: when switched on, a completed booking earns one point per spendPerPoint of its final price, and each point is worth pointValue when redeemed. get_customer_points gives a customer's balance and history; get_loyalty_settings how it works.
- Enquiries: messages customers send from the booking page, with name, phone or email and what they want. NEW is unread, OPENED read but not answered, RESPONDED answered.
- You can look at points and enquiries but not change them yet: to add or redeem points or answer an enquiry, point the owner to the Customers or Enquiries page.`;
