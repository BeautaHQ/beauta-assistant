import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "./src/config";
import { ACTION_SCHEMA } from "./src/enquiry/action";
import { getCatalogue } from "./src/salon/catalogue";

(async () => {
  const c = await getCatalogue(1);
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content:
        `PRICE LIST\nThese ids are the only real ones. Extras are grouped under a service to show what they cost, but any extra can go with any service — take the one they asked for, wherever it is listed.\n\n${c.text}\n\nFill in what the message says. If they name an extra, give its id even when it is listed under a different service.` },
      { role: "user", content:
        "Hi, I'd like a deluxe manicure with normal polish and also add a deluxe pedicure normal, on 25 Sep at 2pm please." },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "a", strict: true, schema: ACTION_SCHEMA as never },
    },
    max_completion_tokens: 700,
    reasoning_effort: "none",
  });
  console.log("RAW:", completion.choices[0]?.message?.content);
  console.log("addon 18 trong catalogue.addonIds?", c.addonIds.has(18));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
