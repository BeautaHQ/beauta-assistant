import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../../config";
import type { OwnerAssistantRequest, OwnerDomain } from "../types";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const pageKeys: Record<OwnerDomain, string[]> = {
  BOOKING: ["calendar", "bookingHistory", "bookingPolicies"], SERVICE: ["services", "addOns"],
  STAFF: ["staff", "commission"], CUSTOMER: ["customers", "enquiries", "feedback", "issues"],
  CALENDAR: ["calendar", "workingHours", "holidaySpecialDays"], REPORTING: ["analytics", "exports"],
  SETTINGS: ["salonSettings", "account", "subscription", "bookingTheme", "aiConfig"],
  SUPPORT: ["helpSupport", "actionNeeded"], OTHER: ["helpSupport"],
};

export const answerFaq = async (input: OwnerAssistantRequest, domain: OwnerDomain) => {
  const allowed = new Set(pageKeys[domain]);
  const guides = input.pageGuides.filter((guide) => allowed.has(guide.key));
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: `Answer only this ${domain} FAQ using the supplied portal guide. Do not perform actions or invent controls. Reply in the user's language with at most five steps.\n\n${guides.map((g) => `${g.key} | ${g.page} | ${g.summary}\n${g.instructions}`).join("\n\n")}` },
      { role: "user", content: input.message },
    ],
    response_format: { type: "json_schema", json_schema: { name: "owner_faq", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["answer", "steps", "pageKey", "confidence"],
      properties: { answer: { type: "string" }, steps: { type: "array", items: { type: "string" } }, pageKey: { type: "string", enum: guides.map((g) => g.key) }, confidence: { type: "number" } },
    } } },
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Owner FAQ returned no response");
  return JSON.parse(content) as { answer: string; steps: string[]; pageKey: string; confidence: number };
};
