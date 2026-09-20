import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import { closeCall, openCall } from "../callLog";
import { getCatalogue } from "../catalogue";
import { salonForCall } from "../salon";
import { streamReply, type Turn } from "../receptionist";
import { newSession, record, type CallSession } from "../session";

/** What ConversationRelay sends us. Only the fields we act on are typed. */
type RelayIn =
  | { type: "setup"; callSid: string; from: string; to: string; forwardedFrom?: string }
  | { type: "prompt"; voicePrompt: string; lang: string; last: boolean }
  | { type: "interrupt"; utteranceUntilInterrupt: string }
  | { type: "dtmf"; digit: string }
  | { type: "error"; description: string };

/**
 * The call itself: text in, text out.
 *
 * Twilio has already turned the caller's speech into words by the time a
 * message arrives here, and turns our words back into speech. So this file
 * holds a conversation, not an audio pipeline.
 */
export const conversationRelayRouter = (app: FastifyInstance) => {
  app.get("/stream", { websocket: true }, (socket: WebSocket, request) => {
    const history: Turn[] = [];
    let session: CallSession = newSession("unknown", "unknown", {
      organizationId: 0,
      name: "the salon",
      timezone: "Australia/Sydney",
    });
    let callSid = "unknown";

    /*
     * Settling which salon was rung takes a database round trip, and Twilio is
     * reading the greeting out while it happens. A caller who talks over the
     * greeting would otherwise reach a receptionist with no salon, no clock and
     * no price list, so the first answer waits on this.
     */
    let ready: Promise<void> = Promise.resolve();

    /*
     * One reply is in flight at a time. Kept so a caller talking over the
     * answer can cut it off — without this the receptionist would talk through
     * the interruption and then answer a question that moved on.
     */
    let inFlight: AbortController | null = null;

    const say = (token: string, last: boolean) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ type: "text", token, last }));
    };

    const answer = async (prompt: string) => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;

      await ready;

      history.push({ role: "user", content: prompt });
      record(session, "caller", prompt);

      try {
        // Tokens go out as they arrive, so Twilio starts speaking immediately.
        const reply = await streamReply(
          session,
          history,
          (token) => say(token, false),
          controller.signal,
        );
        say("", true);
        history.push({ role: "assistant", content: reply.say });
        record(session, "salon", reply.say);
        request.log.info({ event: "replied", callSid, reply: reply.say }, "Answered");

        // The model decides the call is over; Twilio speaks the goodbye first,
        // then hands back to TwiML, which ends it.
        if (reply.endCall && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "end" }));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        request.log.error(
          { event: "reply_failed", callSid, errorMessage: (error as Error).message },
          "LLM failed",
        );
        // Silence would read as a dropped call, so always say something.
        say("Sorry, I didn't catch that. Could you say it again?", true);
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    };

    socket.on("message", (raw: Buffer) => {
      let message: RelayIn;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (message.type) {
        case "setup":
          callSid = message.callSid;
          /*
           * Everything the call needs to know about itself, settled once while
           * Twilio is still reading the greeting out: which salon was rung, its
           * clock, and its price list. None of it can change while the phone is
           * off the hook, so nothing here is looked up again mid-sentence.
           */
          ready = (async () => {
            const { salon, matchedOn } = await salonForCall(
              message.type === "setup" ? (message.to ?? null) : null,
              message.type === "setup" ? (message.forwardedFrom ?? null) : null,
            );
            session = newSession(callSid, message.from, salon);
            session.toNumber = message.to ?? null;
            session.forwardedFrom = message.forwardedFrom ?? null;
            request.log.info(
              {
                event: "salon_resolved",
                callSid,
                organizationId: salon.organizationId,
                salon: salon.name,
                matchedOn,
              },
              "Salon for this call",
            );

            await openCall(session).catch((error: Error) =>
              request.log.error(
                { event: "call_log_failed", callSid, errorMessage: error.message },
                "Could not open the call record",
              ),
            );

            session.catalogue = await getCatalogue(salon.organizationId).catch(
              (error: Error) => {
                request.log.error(
                  { event: "catalogue_failed", callSid, errorMessage: error.message },
                  "Could not load the price list",
                );
                return null;
              },
            );
          })();
          request.log.info(
            {
              event: "call_setup",
              callSid,
              from: message.from,
              to: message.to,
              // On a forwarded call this says which salon number was dialled.
              forwardedFrom: message.forwardedFrom,
            },
            "Call connected",
          );
          /*
           * The number they are ringing from is the one thing we know before
           * they speak. Telling the model saves asking for it, and asking a
           * caller to read out the number they are calling from is the kind of
           * thing that makes an assistant feel mechanical.
           */
          if (message.from) {
            history.push({
              role: "system",
              content: `The caller is ringing from ${message.from}. Use this as their phone number.`,
            });
          }
          break;

        case "prompt":
          // Partial transcripts arrive too; only answer a finished sentence.
          if (!message.last) return;
          request.log.info(
            { event: "caller_said", callSid, text: message.voicePrompt },
            "Caller spoke",
          );
          void answer(message.voicePrompt);
          break;

        case "interrupt":
          request.log.info({ event: "interrupted", callSid }, "Caller cut in");
          inFlight?.abort();
          break;

        case "error":
          request.log.error(
            { event: "relay_error", callSid, description: message.description },
            "ConversationRelay error",
          );
          break;

        default:
          break;
      }
    });

    socket.on("close", () => {
      inFlight?.abort();
      // Behind `ready` as well: a call that drops during setup would otherwise
      // try to finish a record that was never opened.
      void ready
        .then(() => closeCall(session))
        .catch((error: Error) =>
          request.log.error(
            { event: "call_log_failed", callSid, errorMessage: error.message },
            "Could not finish the call record",
          ),
        );
      request.log.info(
        {
          event: "call_ended",
          callSid,
          turns: session.transcript.length,
          booked: session.bookingPublicId,
          waitlisted: session.waitlisted,
        },
        "Call ended",
      );
    });
  });
};
