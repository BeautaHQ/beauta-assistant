/**
 * The XML Twilio expects back from a webhook. A small, fixed grammar, so it is
 * written by hand rather than pulled from a builder library.
 */

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Hand the call to ConversationRelay.
 *
 * Twilio then does the listening and the speaking: our socket receives what
 * the caller said as text and sends back text to be spoken. We never touch
 * audio — no mu-law, no transcoding, no barge-in timing of our own.
 *
 * The alternative, `<Connect><Stream>`, gives raw audio instead and leaves all
 * of that to us. Worth moving to only if Twilio's speech recognition turns out
 * too weak for our callers' accents.
 */
export const conversationRelayTwiml = (opts: {
  url: string;
  welcomeGreeting?: string;
  language?: string;
  /**
   * Where Twilio posts when the session ends, to ask what to do next.
   *
   * Without it, whatever TwiML follows </Connect> runs every time the session
   * ends — so a <Dial> put there for transfers would also ring the salon after
   * every completed booking. With it, the socket says why it ended and the
   * answer is decided then: put the caller through, or hang up.
   */
  action?: string;
}) => {
  const attrs = [
    `url="${escapeXml(opts.url)}"`,
    opts.welcomeGreeting
      ? `welcomeGreeting="${escapeXml(opts.welcomeGreeting)}"`
      : "",
    opts.language ? `language="${escapeXml(opts.language)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const connect = opts.action
    ? `<Connect action="${escapeXml(opts.action)}" method="POST">`
    : "<Connect>";

  return `<?xml version="1.0" encoding="UTF-8"?><Response>${connect}<ConversationRelay ${attrs}/></Connect></Response>`;
};

/** Said when we cannot serve the call, so the caller is never left on silence. */
export const sayAndHangUpTwiml = (message: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(
    message,
  )}</Say><Hangup/></Response>`;

/**
 * Put the call through to a person instead.
 *
 * For calls this service cannot serve: a number that belongs to no salon means
 * no price list, no diary and nothing to answer with, so the call goes to
 * whoever is configured to take it rather than to a receptionist with nothing
 * behind it.
 *
 * The number has to be configured, never taken from the call. On a forwarded
 * call `ForwardedFrom` is the salon's own line — dialling that would hand the
 * call straight back to the number that forwarded it, and round again.
 */
export const sayAndDialTwiml = (message: string, number: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(
    message,
  )}</Say><Dial>${escapeXml(number)}</Dial></Response>`;
