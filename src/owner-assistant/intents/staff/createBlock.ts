import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../../../config";
import type { OwnerAssistantRequest } from "../../types";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
export const extractStaffBlock = async (input: OwnerAssistantRequest) => {
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: `Extract one staff block command. Today=${input.today}, tomorrow=${input.tomorrow}, timezone=${input.timezone}. Dates are inclusive YYYY-MM-DD and times are 24-hour HH:mm. When no times are named use allDay=true and null times. When either time is named use allDay=false and require both times; never guess the other time. Never guess staff or dates. Reply in the user's language and say what needs clarification or what will be created after confirmation.` },
      { role: "user", content: input.message },
    ],
    response_format: { type: "json_schema", json_schema: { name: "create_staff_block", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["staffName", "startDate", "endDate", "startTime", "endTime", "allDay", "reason", "answer"],
      properties: { staffName: { type: ["string", "null"] }, startDate: { type: ["string", "null"] }, endDate: { type: ["string", "null"] }, startTime: { type: ["string", "null"] }, endTime: { type: ["string", "null"] }, allDay: { type: "boolean" }, reason: { type: ["string", "null"] }, answer: { type: "string" } },
    } } },
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Staff block handler returned no response");
  return JSON.parse(content) as { staffName: string | null; startDate: string | null; endDate: string | null; startTime: string | null; endTime: string | null; allDay: boolean; reason: string | null; answer: string };
};
