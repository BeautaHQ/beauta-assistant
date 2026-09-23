import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../../../config";
import type { OwnerAssistantRequest } from "../../types";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
export const extractWorkingHourOverride = async (input: OwnerAssistantRequest) => {
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: `Extract a salon-wide special-hours command. Today=${input.today}, tomorrow=${input.tomorrow}, timezone=${input.timezone}. Dates are inclusive YYYY-MM-DD. This action either closes the salon for whole days (isClosed=true, times null), or replaces operating hours for each date (isClosed=false, both 24-hour HH:mm times required). It cannot represent a break in the middle of a day; ask the user to block staff instead if that is what they requested. Never guess dates or a missing open/close time. Reply in the user's language and never claim it has already happened.` },
      { role: "user", content: input.message },
    ],
    response_format: { type: "json_schema", json_schema: { name: "working_hour_override", strict: true, schema: {
      type: "object", additionalProperties: false,
      required: ["startDate", "endDate", "isClosed", "openTime", "closeTime", "answer"],
      properties: {
        startDate: { type: ["string", "null"] }, endDate: { type: ["string", "null"] }, isClosed: { type: "boolean" },
        openTime: { type: ["string", "null"] }, closeTime: { type: ["string", "null"] }, answer: { type: "string" },
      },
    } } },
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Working-hour override handler returned no response");
  return JSON.parse(content) as { startDate: string | null; endDate: string | null; isClosed: boolean; openTime: string | null; closeTime: string | null; answer: string };
};
