/**
 * How the salon is doing, in numbers the owner asks for in passing: "how many
 * bookings this week", "what did we take last month", "who was busiest".
 */
export const analyticsKnowledge = `ANALYTICS
- One tool, get_booking_stats, for any range of dates up to 92 days. Work the range out from the question and today: "this week" is Monday to Sunday of the current week, "last month" the whole previous calendar month, "today" one day. Say the range you used in the answer.
- bookings counts every booking that starts in the range by status: scheduled (still to come or not yet closed), completed, cancelled, noShow. Bookings from before Beauta (legacy imports) are never counted.
- revenue is the final price of completed bookings only — money for work actually done. Scheduled bookings are not revenue yet; say "booked value" if the owner asks about them. paidOnline is the part of that revenue customers paid through the booking page.
- byDay, byStaff and topServices are there so you can answer "which day", "who" and "what" without another call. A staff member's completed count is bookings they had a part in; a booking with two staff counts once for each.
- newCustomers is people whose record at this salon was first made in the range.
- Compare two ranges by calling the tool twice. Never estimate, extrapolate or round beyond what the numbers say; if the range is in the future, say most of it is still scheduled.`;
