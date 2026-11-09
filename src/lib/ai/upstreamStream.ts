/**
 * Reads an OpenAI-compatible chat-completions SSE stream (Groq `stream: true`)
 * and returns the same shape a non-streaming response has:
 *   { choices: [{ message: { content } }], usage? }
 * so executeAiCore can keep its validation, sanitization, settlement and
 * idempotency steps exactly as they are. Nothing here forwards partial text to
 * a client: the text is only handed on after the caller has sanitized the whole.
 *
 * Throws on anything that is not a clean stream (malformed JSON frame, an
 * upstream `error` frame, an oversized body, a body that ends with no content).
 * The caller treats a throw like an unparseable upstream JSON body.
 */

export const DEFAULT_MAX_UPSTREAM_STREAM_CHARS = 200_000;

export interface UpstreamStreamResult {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function applyDataLine(
  data: string,
  state: { content: string; usage?: UpstreamStreamResult["usage"]; done: boolean },
  maxChars: number
): void {
  const trimmed = data.trim();
  if (!trimmed) return;
  if (trimmed === "[DONE]") {
    state.done = true;
    return;
  }
  let frame: any;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    throw new Error("upstream stream: malformed JSON frame");
  }
  if (frame && typeof frame === "object" && frame.error) {
    throw new Error("upstream stream: error frame");
  }
  const delta = frame?.choices?.[0]?.delta?.content;
  if (typeof delta === "string") {
    state.content += delta;
    if (state.content.length > maxChars) {
      throw new Error("upstream stream: response too large");
    }
  }
  const usage = frame?.usage ?? frame?.x_groq?.usage;
  if (usage && typeof usage === "object") {
    state.usage = usage;
  }
}

export async function readChatCompletionStream(
  body: ReadableStream<Uint8Array> | null | undefined,
  options: { maxChars?: number } = {}
): Promise<UpstreamStreamResult> {
  if (!body) throw new Error("upstream stream: no body");
  const maxChars = options.maxChars ?? DEFAULT_MAX_UPSTREAM_STREAM_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new RangeError("upstream stream: maxChars must be a positive safe integer");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const state: { content: string; usage?: UpstreamStreamResult["usage"]; done: boolean } = {
    content: "",
    done: false,
  };
  let buffer = "";

  const drain = (final: boolean) => {
    // [DONE] terminates the response even when more lines share its chunk.
    if (state.done) { buffer = ""; return; }
    // SSE events are separated by a blank line; process complete lines only.
    const lines = buffer.split(/\r?\n/);
    buffer = final ? "" : (lines.pop() as string);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("data:")) applyDataLine(line.slice(5), state, maxChars);
      if (state.done) { buffer = ""; break; }
    }
  };

  try {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        drain(false);
        if (state.done) break;
      }
      buffer += decoder.decode();
      drain(true);
    } catch (err) {
      try {
        await reader.cancel();
      } catch {}
      throw err;
    }
    if (state.done) {
      try {
        await reader.cancel();
      } catch {}
    }

    if (!state.content) throw new Error("upstream stream: empty content");
    const out: UpstreamStreamResult = { choices: [{ message: { content: state.content } }] };
    if (state.usage) out.usage = state.usage;
    return out;
  } finally {
    reader.releaseLock();
  }
}
