/** What a separate intent-classifying call would cost, per turn. */
import OpenAI from "openai";

import { OPENAI_API_KEY, OPENAI_MODEL } from "../config";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const run = async () => {
  const times: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = Date.now();
    await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "Classify the caller's intent. Answer with one word: FAQ, CHECK_AVAILABILITY, ASK_SLOT, BOOKING or OTHER." },
        { role: "user", content: "How about tomorrow?" },
      ],
      max_completion_tokens: 8,
      ...(/^(o\d|gpt-[5-9])/.test(OPENAI_MODEL) ? { reasoning_effort: "none" as const } : {}),
    });
    times.push(Date.now() - started);
  }
  times.sort((a, b) => a - b);
  console.log("classifier round trips (ms):", times.join(" "));
  console.log("median:", times[Math.floor(times.length / 2)], "ms added to EVERY turn");
};

void run();
