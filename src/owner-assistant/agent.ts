import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_MODEL } from "../config";
import { createSalonData } from "./data";
import { knowledge } from "./knowledge";
import { MODULES } from "./modules";
import { coreTools, createBatch, refuse, type Tool, type ToolContext } from "./toolkit";
import { trace } from "./trace";
import type { OwnerAssistantRequest, OwnerAssistantResult } from "./types";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const REASONING_MODEL = /^(o\d|gpt-[5-9])/.test(OPENAI_MODEL.trim());

/** Enough rounds to read everything and propose a large batch; a run past this has lost its way. */
const MAX_ROUNDS = 12;

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** The shape of the final reply, so the app gets fields to lay out rather than one block of text. */
const REPLY_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "owner_reply", strict: true,
    schema: {
      type: "object", additionalProperties: false, required: ["answer", "details"],
      properties: { answer: { type: "string" }, details: { type: "array", items: { type: "string" } } },
    },
  },
};

/** Read the final reply. A model that ignored the format still gets its words through, as the answer. */
const readReply = (content: string | null | undefined) => {
  const text = content?.trim() ?? "";
  try {
    const parsed = JSON.parse(text) as { answer?: unknown; details?: unknown };
    if (typeof parsed.answer === "string") {
      return { answer: parsed.answer.trim(), details: Array.isArray(parsed.details) ? parsed.details.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [] };
    }
  } catch { /* not JSON: fall through */ }
  return { answer: text, details: [] as string[] };
};

/**
 * The owner assistant: one agent that knows how Beauta works, reads the
 * salon's data with tools, decides what to do, asks when it must, and proposes
 * actions for the owner to confirm.
 *
 * Each round the model either calls tools (their results go back to it) or
 * replies in plain text, which ends the run. Nothing is written here.
 */
export const runOwnerAgent = async (input: OwnerAssistantRequest): Promise<OwnerAssistantResult> => {
  // Every read in this run is scoped to this one organization.
  const context: ToolContext = { input, data: createSalonData(input.organizationId), batch: createBatch(), modules: MODULES, loaded: new Set() };
  const nameOf = (item: Tool) => (item.definition.type === "function" ? item.definition.function.name : "");
  // Which module each tool belongs to, so a tool only runs once its module is loaded.
  const moduleOf = new Map(MODULES.flatMap((module) => module.tools.map((item) => [nameOf(item), module.name] as const)));
  const allTools = new Map<string, Tool>([...coreTools, ...MODULES.flatMap((module) => module.tools)].map((item) => [nameOf(item), item]));
  const offered = () => [...coreTools, ...MODULES.filter((module) => context.loaded.has(module.name)).flatMap((module) => module.tools)];
  const runOrder = MODULES.flatMap((module) => module.runOrder);

  const messages: Message[] = [
    { role: "system", content: knowledge(input, MODULES) },
    ...input.history.map((turn): Message => ({ role: turn.role, content: turn.content })),
    { role: "user", content: input.message },
  ];

  const startedAt = Date.now();
  trace.start(input.organizationId, input.message, input.history.length);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const roundStartedAt = Date.now();
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL, messages, tools: offered().map((item) => item.definition), tool_choice: "auto", response_format: REPLY_FORMAT,
      // Reasoning models refuse a temperature, and on Chat Completions only allow tools with no reasoning.
      // Moving to the Responses API is what would let this agent think before it acts.
      ...(REASONING_MODEL ? { reasoning_effort: "none" as const } : { temperature: 0.2 }),
    });
    const reply = completion.choices[0]?.message;
    if (!reply) throw new Error("Owner assistant returned no response");
    trace.round(round + 1, (Date.now() - roundStartedAt) / 1000, completion.usage);

    const calls = (reply.tool_calls ?? []).filter((call) => call.type === "function");
    if (calls.length === 0) {
      const actions = [...context.batch.proposals].sort((a, b) => runOrder.indexOf(a.type) - runOrder.indexOf(b.type));
      const { answer, details } = readReply(reply.content);
      trace.finish([answer, ...details.map((line) => `  * ${line}`)].join("\n"), actions, (Date.now() - startedAt) / 1000);
      return { answer, details, actions };
    }

    trace.thought(reply.content);
    messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: calls });
    // One at a time, in the order asked: a proposal may use an id returned by the one before it.
    for (const call of calls) {
      const owner = moduleOf.get(call.function.name);
      const handler = owner && !context.loaded.has(owner) ? undefined : allTools.get(call.function.name);
      let output: unknown;
      try {
        output = handler
          ? await handler.run(JSON.parse(call.function.arguments || "{}") as Record<string, unknown>, context)
          : refuse(owner ? `load the ${owner} module first` : `unknown tool ${call.function.name}`);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        output = refuse("arguments were not valid JSON");
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      trace.call(call.function.name, call.function.arguments, output);
    }
  }

  // Proposals from a run that never finished are not offered: the owner never saw them explained.
  trace.finish(`gave up after ${MAX_ROUNDS} rounds`, [], (Date.now() - startedAt) / 1000);
  return { answer: "Sorry, I couldn't finish working that out. Could you try again, one change at a time?", details: [], actions: [] };
};
