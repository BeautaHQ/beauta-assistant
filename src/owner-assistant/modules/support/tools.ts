import { refuse, tool, type Tool, type ToolContext } from "../../toolkit";
import type { CreateRequestAction, OwnerAction } from "../../types";

const REQUEST_TYPES = ["ACCOUNT_SETUP", "DATA_MIGRATION", "DATA_EXPORT"] as const;
/** The same limit beauta-api puts on a request typed into the portal. */
const CONTENT_MAX = 5000;
/** A request the team can act on says more than a few words. */
const CONTENT_MIN = 20;

const accept = ({ batch }: ToolContext, action: OwnerAction, extra: Record<string, unknown> = {}) => {
  batch.proposals.push(action);
  return { ok: true, proposed: action, ...extra };
};

export const supportTools: Tool[] = [
  tool(
    "propose_beauta_request",
    "Propose a request for Beauta's team to do work for this salon: ACCOUNT_SETUP (enter services, addons, prices, staff, hours), DATA_MIGRATION (bring data in from another system) or DATA_EXPORT (get their data out). content is the full brief the team will read, in the owner's words where possible.",
    {
      requestType: { type: "string", enum: [...REQUEST_TYPES] },
      content: { type: "string" },
    },
    async (args, context) => {
      const item = args as { requestType: (typeof REQUEST_TYPES)[number]; content: string };
      const content = item.content?.trim() ?? "";
      const problems: string[] = [];
      if (!REQUEST_TYPES.includes(item.requestType)) problems.push(`requestType must be one of ${REQUEST_TYPES.join(", ")}`);
      if (content.length < CONTENT_MIN) problems.push("content is too short to act on: say what the owner wants done and every detail they gave");
      if (content.length > CONTENT_MAX) problems.push(`content must be ${CONTENT_MAX} characters or fewer`);
      if (context.batch.pending("CREATE_REQUEST").some((row) => row.requestType === item.requestType)) {
        problems.push("a request of this type is already proposed in this reply; put everything into one");
      }
      if (problems.length) return refuse(...problems);

      const action: CreateRequestAction = { type: "CREATE_REQUEST", requestType: item.requestType, content };
      return accept(context, action, {
        note: "Sent to Beauta's team when the owner presses Confirm; they reply by email with a reference.",
      });
    },
  ),
];
