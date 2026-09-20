/** `npx tsx src/dev/model.ts <model-id>` — does this account have that model? */
import OpenAI from "openai";

import { OPENAI_API_KEY } from "../config";

const id = process.argv[2]!;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

client.chat.completions
  .create({ model: id, messages: [{ role: "user", content: "say ok" }] })
  .then((r) => console.log("OK ->", r.choices[0]?.message?.content))
  .catch((e: any) => console.log("FAILED ->", e.status, String(e.message).slice(0, 200)));
