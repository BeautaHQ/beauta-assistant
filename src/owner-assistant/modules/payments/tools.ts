import { tool, type Tool } from "../../toolkit";

const MEANING: Record<string, string> = {
  NOT_CREATED: "no Stripe account yet: the salon has never started connecting a bank account",
  INCOMPLETE: "connecting was started but Stripe still needs details from the owner",
  PENDING: "details submitted; Stripe is reviewing them",
  ENABLED: "connected and approved",
};

export const paymentsTools: Tool[] = [
  tool(
    "get_payment_setup",
    "Whether this salon's bank account is connected for payouts, and so whether online payment at booking and gift card sales work.",
    {},
    async (_args, context) => {
      const setup = await context.data.paymentSetup();
      const enabled = setup.payoutStatus === "ENABLED";
      return {
        payoutStatus: setup.payoutStatus,
        meaning: MEANING[setup.payoutStatus] ?? setup.payoutStatus,
        currency: setup.currency,
        onlinePaymentAtBooking: enabled ? "works" : "not available until ENABLED; customers can only pay in salon",
        giftCardSales: enabled ? "work" : "not available until ENABLED; the booking page shows gift cards as unavailable",
        howToFix: enabled ? null : "Salon Settings → Payouts → connect (administrators only); Stripe's form asks for identity and bank details",
      };
    },
  ),
];
