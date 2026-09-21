/**
 * Runs a conversation against the receptionist without Twilio or a phone.
 *
 * `npx tsx src/dev/chat.ts "line one" "line two" ...`
 *
 * Each argument is one thing the caller says. Prints what the receptionist says
 * back, how long it took, and which tools it reached for — which is the part a
 * real call hides.
 */
import { closeCall, openCall } from "../call/callLog";
import { getCatalogue } from "../salon/catalogue";
import { streamReply, type Turn } from "../receptionist";
import { salonForCall } from "../salon/lookup";
import { newSession, record } from "../call/session";

/*
 * VOICE_FAKE_FULL=2026-09-22,2026-09-23 makes those dates come back with no
 * free times at all.
 *
 * The dev salon opens seven days a week and has almost nothing booked, so every
 * date it is asked about answers with fifty-nine slots. The branch that matters
 * most — the day is gone, do you want the waitlist — could not otherwise be
 * reached without filling a day with sixty junk bookings. Faked here in the
 * harness rather than behind a flag in the service, which would mean shipping a
 * way to lie about the diary.
 */
const fakeFull = (process.env.VOICE_FAKE_FULL ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

if (fakeFull.length > 0) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    const asked = fakeFull.find((d) => url.includes("/availability") && url.includes(d));
    if (!asked) return real(input, init);
    console.error(`     (faking ${asked} as full)`);
    return new Response(
      JSON.stringify({
        success: true,
        message: "Availability fetched successfully",
        data: { date: asked, availableSlots: [], unavailableSlots: [] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

const lines = process.argv.slice(2);
if (lines.length === 0) {
  console.error('Usage: tsx src/dev/chat.ts "Hi, I want a manicure" "Tomorrow afternoon"');
  process.exit(1);
}

const run = async () => {
  const { salon, matchedOn } = await salonForCall(process.env.VOICE_TO ?? null, null);
  console.log(`SALON: ${salon.name} (org ${salon.organizationId}, ${salon.timezone}) matched on ${matchedOn}`);
  const session = newSession(`cnv_dev_${Date.now()}`, "+61400111222", salon, "PHONE");
  session.toNumber = process.env.VOICE_TO ?? null;
  session.catalogue = await getCatalogue(salon.organizationId);
  await openCall(session);
  const history: Turn[] = [];

  for (const line of lines) {
    console.log(`\nCALLER: ${line}`);
    history.push({ role: "user", content: line });
    record(session, "caller", line);

    const started = Date.now();
    let first = 0;
    const reply = await streamReply(
      session,
      history,
      () => {
        if (!first) first = Date.now() - started;
      },
      AbortSignal.timeout(60_000),
    );

    history.push({ role: "assistant", content: reply.say });
    record(session, "salon", reply.say);
    console.log(`SALON : ${reply.say}`);
    console.log(`        [first token ${first}ms, total ${Date.now() - started}ms${reply.endCall ? ", END CALL" : ""}]`);
  }

  await closeCall(session);

  console.log("");
  console.log("FINAL STATE:", JSON.stringify(session.booking));
  console.log("conversation:", session.conversationId);
  console.log("booked:", session.bookingPublicId, "| waitlisted:", session.waitlisted);
};

void run();
