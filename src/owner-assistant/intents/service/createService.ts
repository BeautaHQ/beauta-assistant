import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../../../config";
import type { OwnerAssistantRequest, ServiceDraft } from "../../types";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
export const extractServices = async (input: OwnerAssistantRequest) => {
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: `Extract every service the salon owner explicitly asks Beauta to create. Always return an array, including for one service. Required per service: name, durationMinutes and price. Do not guess missing required values. Description may be null. Status defaults to PUBLIC unless the owner says private/hidden. Prices are numeric in the salon's configured currency; never convert currencies. Reply in the user's language, summarising all items or asking for every missing field. Never claim anything was created.` },
      { role: "user", content: input.message },
    ],
    response_format: { type: "json_schema", json_schema: { name: "create_services", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["services", "answer"],
      properties: {
        services: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["name", "description", "durationMinutes", "price", "status"], properties: {
          name: { type: ["string", "null"] }, description: { type: ["string", "null"] }, durationMinutes: { type: ["number", "null"] }, price: { type: ["number", "null"] }, status: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
        } } },
        answer: { type: "string" },
      },
    } } },
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Create service handler returned no response");
  return JSON.parse(content) as { services: ServiceDraft[]; answer: string };
};
