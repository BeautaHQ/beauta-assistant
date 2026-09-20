# beauta-voice

Beauta's phone line. A customer rings the salon, the salon's carrier forwards
that call to a Twilio number, Twilio asks this service what to do, and the
answer hands the call's audio to a WebSocket where an AI receptionist will
answer.

## Why it is not part of beauta-api

A call is a socket that lives for minutes. `beauta-api` deploys with
`--force-new-deployment`, which would cut every conversation in progress — and
it deploys often. This service deploys on its own schedule.

Bookings are still made by `beauta-api` over HTTP rather than written here
directly: `createBooking` checks availability, prevents double-booking, builds
the per-staff tasks and sends the confirmation emails. Writing to the database
straight from here would skip all of it.

## Running it

    cp .env.example .env     # fill in TWILIO_AUTH_TOKEN
    npm install
    npm run dev

Locally Twilio cannot reach `localhost`, so expose it with a tunnel
(`ngrok http 3003`), set `PUBLIC_URL` to the tunnel's https address, and point
the Twilio number's "A call comes in" webhook at `POST <PUBLIC_URL>/incoming`.

`VERIFY_TWILIO_SIGNATURE=false` skips the signature check for hand-made test
requests. Never set that in a deployed environment — `/incoming` is a public
URL, and without the check anyone can drive this service.

## What happens on a call

    POST /incoming                     Twilio asks what to do
      -> <Connect><ConversationRelay/> hands the call to our socket

    WS /stream                         text in, text out
      setup      call connected, who is calling
      prompt     what the caller said, already transcribed
      interrupt  caller talked over the reply
      -> { type: "text", token, last } what to say back

Twilio does the listening and the speaking. This service never touches audio —
no mu-law, no transcoding. The LLM runs here, streaming its tokens straight
out so Twilio starts speaking while the model is still writing.

The alternative is `<Connect><Stream>`, which hands over raw audio and leaves
speech recognition, voices and barge-in timing to us. Worth moving to only if
Twilio's recognition proves too weak for our callers' accents — the prompt,
the conversation and any calls into beauta-api carry over unchanged.

## Where it is up to

Working: the webhook, signature verification, and a receptionist that holds a
conversation, streams its answers, and stops when the caller cuts in.

Not yet: it cannot see the diary. It takes booking details, reads them back and
says the salon will confirm. Next is reading availability from beauta-api, then
booking through it — writes go through `createBooking` rather than the
database, so a phone booking gets the same conflict checks and confirmation
emails as any other.
