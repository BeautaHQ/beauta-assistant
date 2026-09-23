import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../../config";
import { OWNER_DOMAINS, type OwnerAction, type OwnerDomain, type OwnerIntent } from "../types";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const ACTIONS = ["CREATE_STAFF", "CREATE_STAFF_BLOCK", "CREATE_WORKING_HOUR_OVERRIDE", "CREATE_SERVICE", "NONE"] as const;

export type OwnerRoute = { intent: OwnerIntent; domain: OwnerDomain; action: OwnerAction };

export const classifyOwnerRequest = async (message: string): Promise<OwnerRoute> => {
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: `Route a salon owner's request. Do not answer it and do not extract fields.
Return intent, domain and action.
FAQ means they ask how to do something. ACTION means they ask Beauta to do it.
Supported actions: CREATE_STAFF, CREATE_STAFF_BLOCK, CREATE_WORKING_HOUR_OVERRIDE and CREATE_SERVICE. Use NONE for FAQ or unsupported actions.
Examples:
"How do I add a service?" => FAQ, SERVICE, NONE
"Create BIAB $65 60 minutes" => ACTION, SERVICE, CREATE_SERVICE
"Add Suri as a staff member who does BIAB" => ACTION, STAFF, CREATE_STAFF
"Block Suri tomorrow" => ACTION, STAFF, CREATE_STAFF_BLOCK
"Close the salon tomorrow" => ACTION, CALENDAR, CREATE_WORKING_HOUR_OVERRIDE
"Open from 10 to 4 this Sunday" => ACTION, CALENDAR, CREATE_WORKING_HOUR_OVERRIDE` },
      { role: "user", content: message },
    ],
    response_format: { type: "json_schema", json_schema: { name: "owner_route", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["intent", "domain", "action"],
      properties: { intent: { type: "string", enum: ["FAQ", "ACTION", "CLARIFICATION"] }, domain: { type: "string", enum: OWNER_DOMAINS }, action: { type: "string", enum: ACTIONS } },
    } } },
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Owner assistant router returned no response");
  return JSON.parse(content) as OwnerRoute;
};
