/**
 * A readable log of how the agent worked through one request: what it said it
 * was about to do, which tools it chose, what came back, and what it answered.
 * Meant for watching the agent's decisions while testing by hand.
 */
// On by default while this is a prototype; OWNER_ASSISTANT_TRACE=0 turns it off.
const enabled = () => process.env.OWNER_ASSISTANT_TRACE !== "0";
const print = (line: string) => { if (enabled()) console.log(`[owner-assistant] ${line}`); };

/** A short view of a tool's result: counts for reads, the verdict for proposals. */
const summarise = (output: unknown) => {
  if (!output || typeof output !== "object") return String(output);
  const value = output as Record<string, unknown>;
  if (value.ok === false) return `REFUSED: ${(value.problems as string[] | undefined)?.join(" | ")}`;
  const list = Object.entries(value).find(([, item]) => Array.isArray(item));
  if (value.ok === true) {
    const extras = Object.entries(value).filter(([key]) => !["ok", "proposed"].includes(key)).map(([key, item]) => `${key}=${JSON.stringify(item)}`);
    return `ok${extras.length ? ` (${extras.join(", ").slice(0, 200)})` : ""}`;
  }
  if (list) return `${(list[1] as unknown[]).length} ${list[0]}`;
  return JSON.stringify(value).slice(0, 200);
};

export const trace = {
  enabled,
  start: (organizationId: number, message: string, historyTurns: number) =>
    print(`=== org ${organizationId} | ${historyTurns} earlier turns | owner: ${message}`),
  round: (round: number, seconds: number, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined) =>
    print(`--- round ${round} (${seconds.toFixed(1)}s, ${usage?.prompt_tokens ?? "?"} in / ${usage?.completion_tokens ?? "?"} out tokens)`),
  thought: (text: string | null | undefined) => { if (text?.trim()) print(`  thinks: ${text.trim()}`); },
  call: (name: string, args: string, output: unknown) => {
    print(`  -> ${name} ${args === "{}" ? "" : args}`);
    print(`     <- ${summarise(output)}`);
  },
  finish: (answer: string, actions: { type: string }[], seconds: number) => {
    print(`=== done in ${seconds.toFixed(1)}s | ${actions.length} action(s): ${actions.map((action) => action.type).join(", ") || "none"}`);
    print(`answer: ${answer}`);
  },
};
