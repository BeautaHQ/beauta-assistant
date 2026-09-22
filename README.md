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

## Layout

    src/
      server.ts            wiring: formbody, websocket, routes, /health
      config.ts            every setting, read once at boot
      routes/              the two ways in
        IncomingCallRoute      POST /incoming — Twilio asks what to do
        ConversationRelayRoute WS /stream — the conversation itself
      receptionist/        the AI
        index.ts               the turn: stream, run tools, stream again
        prompt.ts              every word the model is told
        tools.ts               what it can do, and what it is not allowed to
        jsonStream.ts          lifts `say` out of the JSON as it arrives
      call/                one phone call
        session.ts             what this call knows about itself
        booking.ts             the booking being filled in, and what is missing
        callLog.ts             the row the salon reads afterwards
      salon/               whose phone was rung
        lookup.ts              dialled number -> organization
        catalogue.ts           the price list, cached per salon
        knowledge.ts           the salon's reference photos, cached per salon
        clock.ts               today and tomorrow in the salon's timezone
        slots.ts               free times, cut down to the ones worth saying
      clients/             things outside this process
        beautaApi.ts           bookings, availability, the catalogue
        prisma.ts              beauta-api's database, read here, one table written
      auth/                Twilio request signatures
      utils/               TwiML
      dev/                 scripts for driving it without a phone

The split that matters is `receptionist/` against `call/`. The receptionist is
the part that can be wrong — it is a model, and it drifts. `call/` is the part
that cannot: the state it is held to, and the rules the tools enforce before
anything reaches a real diary.

`prompt.ts` is deliberately apart from both. Kept inside the state it put prose
into a module whose job was to hold facts; kept inside the streaming loop the
wording of a question sat in the middle of chunk handling.

## Driving it without a phone

A call is text in and text out, so a phone is not needed to exercise one.

    npx tsx src/dev/chat.ts "Hi, can I book a gel removal" "Tomorrow afternoon"

Each argument is one thing the caller says. It prints the reply, the time to
first token, and the final booking state, and writes a real `voice_call` row.

    VOICE_DEBUG=1   show every tool call and what it returned
    VOICE_TO=+6442101554   pretend that number was the one dialled

    npx tsx src/dev/tool.ts check_availability '{"serviceId":5,"date":"2026-09-22"}'
    npx tsx src/dev/model.ts gpt-4o        does this account have that model

## The database

`beauta-api` owns the schema and every migration. `prisma/schema.prisma` here
is a copy — refresh it with `npm run prisma:sync` after beauta-api migrates.
This service reads the salon's details and writes `voice_call`, nothing else.

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
conversation, streams its answers, and stops when the caller cuts in. It knows
the price list, reads the diary, offers real times, books, and puts a caller on
the waitlist when a day is gone. Every call is written to `voice_call` with its
transcript.

Not yet: extras are never offered, and there is no way to cancel or move a
booking over the phone. One number, one salon, until `to`/`forwardedFrom` is
mapped for more than one.
