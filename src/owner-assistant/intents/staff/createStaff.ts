import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../../../config";
import type { OwnerAssistantRequest, StaffDraft } from "../../types";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

export const extractStaff = async (input: OwnerAssistantRequest) => {
  const { services, addons, salonWorkingHours } = input.ownerContext;
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: `Extract every staff member the salon owner asks Beauta to create. Always return a staff array, even for one person.
Only select serviceNames and addonNames exactly from the catalog below. Never invent a catalog item and never output IDs.
Name is required. Phone is optional. isActive defaults true.
If the owner does not specify working hours, copy the salon working hours below, mapping isClosed to isOff and openTime/closeTime to startTime/endTime.
If they specify hours for only some days, use those days and mark every other day off. Times are 24-hour HH:mm.
Reply in the user's language. Summarise the complete preview or ask for any information that is genuinely required. Never claim staff were created.

SERVICES: ${JSON.stringify(services)}
ADDONS: ${JSON.stringify(addons)}
SALON WORKING HOURS: ${JSON.stringify(salonWorkingHours)}` },
      { role: "user", content: input.message },
    ],
    response_format: { type: "json_schema", json_schema: { name: "create_staff", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["staff", "answer"],
      properties: {
        staff: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false,
          required: ["name", "phone", "isActive", "serviceNames", "addonNames", "workingHours"],
          properties: {
            name: { type: ["string", "null"] }, phone: { type: ["string", "null"] }, isActive: { type: "boolean" },
            serviceNames: { type: "array", items: services.length ? { type: "string", enum: services.map((item) => item.name) } : { type: "string" } },
            addonNames: { type: "array", items: addons.length ? { type: "string", enum: addons.map((item) => item.name) } : { type: "string" } },
            workingHours: { type: "array", items: { type: "object", additionalProperties: false,
              required: ["dayOfWeek", "startTime", "endTime", "isOff"], properties: {
                dayOfWeek: { type: "number" }, startTime: { type: "string" }, endTime: { type: "string" }, isOff: { type: "boolean" },
              },
            } },
          },
        } },
        answer: { type: "string" },
      },
    } } },
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Create staff handler returned no response");
  return JSON.parse(content) as { staff: StaffDraft[]; answer: string };
};
