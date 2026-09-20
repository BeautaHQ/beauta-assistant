/** The escapes JSON allows inside a string, minus \u which is handled separately. */
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
};

/**
 * Reads one string field out of a JSON object while that object is still arriving.
 *
 * The model answers in JSON so the reply is structured at the source rather than
 * free text picked apart afterwards. A phone call cannot wait for the closing
 * brace, though — so this walks the characters as they stream in and releases the
 * contents of the field the moment each one lands. Twilio starts speaking while
 * the model is still writing, exactly as it did when the reply was plain text.
 */
export class StreamingStringField {
  private readonly opening: RegExp;
  private phase: "before" | "inside" | "after" = "before";
  private pending = "";
  private escaped = false;
  private collectingHex = false;
  private hex = "";
  private collected = "";

  constructor(
    key: string,
    private readonly emit: (text: string) => void,
  ) {
    this.opening = new RegExp(`"${key}"\s*:\s*"`);
  }

  /** Everything of the field seen so far, unescaped. */
  get value(): string {
    return this.collected;
  }

  push(chunk: string): void {
    if (this.phase === "after") return;

    if (this.phase === "before") {
      this.pending += chunk;
      const match = this.opening.exec(this.pending);
      if (!match) {
        // A key can straddle two chunks, so keep a tail long enough to rejoin it.
        if (this.pending.length > 200) this.pending = this.pending.slice(-200);
        return;
      }
      this.phase = "inside";
      chunk = this.pending.slice(match.index + match[0].length);
      this.pending = "";
    }

    this.consume(chunk);
  }

  private consume(text: string): void {
    let out = "";

    for (const ch of text) {
      if (this.collectingHex) {
        this.hex += ch;
        if (this.hex.length === 4) {
          out += String.fromCharCode(parseInt(this.hex, 16));
          this.hex = "";
          this.collectingHex = false;
        }
        continue;
      }

      if (this.escaped) {
        this.escaped = false;
        if (ch === "u") {
          this.collectingHex = true;
          continue;
        }
        out += ESCAPES[ch] ?? ch;
        continue;
      }

      if (ch === "\\") {
        this.escaped = true;
        continue;
      }

      if (ch === '"') {
        this.phase = "after";
        break;
      }

      out += ch;
    }

    if (out) {
      this.collected += out;
      this.emit(out);
    }
  }
}
