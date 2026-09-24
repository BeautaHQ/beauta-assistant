/**
 * The calendar: when customers can be booked, and booking them. Free times
 * always come from the scheduling engine.
 */
export const calendarKnowledge = `CALENDAR
- A booking is a customer, a service (plus any addons) done by a staff member at a start time.
- Whether a time is free depends on opening hours, special days, staff hours and blocks, existing bookings, and the service and addon durations. Never work it out yourself: always ask find_available_times or check_time_available.
- Free times are start times, every 10 minutes. Today starts 30 minutes from now; past dates have none.
- Free times depend on the service's length. If the owner does not name a service, even when asking when a staff member is free, ask which service; never try services one by one.
- Use any staff unless they name one. "people" is how many customers come together, each needing their own staff at the same time.
- Parts of the day: morning is before 12:00, afternoon 12:00-17:00, evening 17:00 on; pass them as fromTime/toTime. "This week" runs from today to Sunday.
- Tell the owner ranges of start times, not every slot.
- Booking: customers are found by phone number (find_customer), never by name. Pass the number as typed; the tool normalises it.
- Required, ask for whatever is missing before proposing: phone, service, date, start time, and for a new customer their first name. An existing customer keeps their saved name.
- Optional, never ask for them: email, last name, staff (any free staff unless named), addons, notes. Reminder is off unless the owner asks for one.
- Never invent a name, phone or email.
- If the time is taken the tool says so and gives the nearest free times: offer those instead.
- Changing a booking: find it first, by the customer's phone (get_customer_history lists their upcoming bookings) or by day (list_bookings). If several could be meant, list them and ask which.
- Reschedule: keep the same staff member unless the owner says any staff or names another. It needs the new date and start time; ask if missing.
- Cancel: email the customer by default unless the owner says not to. Put the owner's reason in if they gave one; do not ask for one. A no-show is only for a booking whose time has passed. If the customer paid online, cancelling refunds them: say so.`;
