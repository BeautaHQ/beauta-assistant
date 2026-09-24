import type OpenAI from "openai";
import type { SalonData } from "./data";
import type { OwnerAction, OwnerAssistantRequest, SalonDayHours } from "./types";

/**
 * The shape every module is built from.
 *
 * A module is a slice of Beauta that belongs together (staff, services and
 * addons; later bookings, customers...). It brings a short piece of knowledge
 * — what its things are and how they relate — and the tools to read and
 * propose changes to them. The agent gets the knowledge and tools of every
 * module and decides for itself which to use.
 */

export type ToolDefinition = OpenAI.Chat.Completions.ChatCompletionTool;
type Json = Record<string, unknown>;

/** The actions proposed so far in this reply. Nothing in it has been written. */
export type Batch = {
  proposals: OwnerAction[];
  /** A negative id for something created in this batch, so later proposals can refer to it before it exists. */
  nextTempId: () => number;
  pending: <T extends OwnerAction["type"]>(type: T) => Extract<OwnerAction, { type: T }>[];
};

export type ToolContext = {
  input: OwnerAssistantRequest; data: SalonData; batch: Batch;
  /** Every module there is, and the ones the agent has loaded in this reply: only those modules' tools are offered. */
  modules: Module[]; loaded: Set<string>;
};

export type Tool = {
  definition: ToolDefinition;
  run: (args: Json, context: ToolContext) => Promise<unknown>;
};

export type Module = {
  name: string;
  /** One line in the list the agent chooses from; the knowledge only arrives when it loads the module. */
  summary: string;
  knowledge: string;
  tools: Tool[];
  /** Order this module's actions run in when the owner confirms: things must exist before they are assigned. */
  runOrder: OwnerAction["type"][];
};

/** A strict function tool: every property required, nothing extra. */
export const tool = (name: string, description: string, properties: Json, run: Tool["run"]): Tool => ({
  definition: {
    type: "function",
    function: { name, description, strict: true, parameters: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) } },
  },
  run,
});

export const refuse = (...problems: string[]) => ({ ok: false, problems });

export const createBatch = (): Batch => {
  const proposals: OwnerAction[] = [];
  let tempId = -1;
  return {
    proposals,
    nextTempId: () => tempId--,
    pending: <T extends OwnerAction["type"]>(type: T) =>
      proposals.filter((item): item is Extract<OwnerAction, { type: T }> => item.type === type),
  };
};

/** The salon's weekly hours. The assistant does not change them: owners edit them on the Working Hours page. */
export const effectiveSalonHours = async ({ data }: ToolContext): Promise<SalonDayHours[]> => data.salonHours();

/** Tools that are always there, whatever is loaded. */
export const coreTools: Tool[] = [
  tool("load_module", "Load the modules this request needs (several if it spans them). Returns what each module knows; its tools become available from the next step.",
    { names: { type: "array", minItems: 1, items: { type: "string" } } },
    async ({ names }, { modules, loaded }) => {
      const wanted = [...new Set(names as string[])];
      const unknown = wanted.filter((name) => !modules.some((module) => module.name === name));
      if (unknown.length) return refuse(`no module named ${unknown.join(", ")}; the modules are ${modules.map((module) => module.name).join(", ")}`);
      wanted.forEach((name) => loaded.add(name));
      return { loaded: modules.filter((module) => wanted.includes(module.name)).map((module) => ({ name: module.name, knowledge: module.knowledge })) };
    }),
  tool("get_portal_guide", "How the Beauta portal works. Without a pageKey: the list of pages. With a pageKey: how that page is used. For how-to questions and for things you have no tool for.",
    { pageKey: { type: ["string", "null"] } },
    async ({ pageKey }, { input }) => {
      if (!pageKey) return { pages: input.pageGuides.map(({ key, page, summary }) => ({ key, page, summary })) };
      return input.pageGuides.find((item) => item.key === pageKey) ?? refuse(`No page with key ${String(pageKey)}. Call without a pageKey to list pages.`);
    }),
  tool("clear_proposals", "Drop every proposal made so far in this reply, to start the batch again.", {},
    async (_args, { batch }) => { batch.proposals.splice(0); return { ok: true }; }),
];
