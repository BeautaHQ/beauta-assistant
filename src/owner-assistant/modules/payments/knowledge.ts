/**
 * Getting paid: the bank account behind online payments and gift cards.
 */
export const paymentsKnowledge = `PAYMENTS
- Money from customers reaches the salon through a Stripe account connected to the salon's bank account. Until it is connected and approved, two things do not work: paying online when booking (customers can only choose pay in salon) and buying gift cards on the booking page (that page says gift cards are unavailable). Pay in salon always works.
- get_payment_setup says where this salon is: NOT_CREATED (never started), INCOMPLETE (started, Stripe still needs details), PENDING (submitted, Stripe reviewing — usually a day or two), ENABLED (connected; online payment and gift card sales work).
- To connect or finish: Salon Settings, the Payouts section, the connect button — it opens Stripe's own form (identity, bank account). Only an administrator can. Action Needed lists it while it is outstanding.
- You cannot connect it, change the bank account or see money movements; Stripe holds those. For "where is my payout", point them to the Stripe login link in the same Payouts section.`;
