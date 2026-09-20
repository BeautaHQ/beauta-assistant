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

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay ${attrs}/></Connect></Response>`;
};

/** Said when we cannot serve the call, so the caller is never left on silence. */
export const sayAndHangUpTwiml = (message: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(
    message,
  )}</Say><Hangup/></Response>`;
