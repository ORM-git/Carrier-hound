import { describe, it, expect } from "vitest";
import { readChatCompletionStream } from "@/lib/ai/upstreamStream";

// Backend sheet row "Streaming Responses": upstream SSE assembly helper.

function streamOf(parts: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      const p = parts[i++];
      controller.enqueue(typeof p === "string" ? enc.encode(p) : p);
    },
  });
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (t: string) => frame({ choices: [{ delta: { content: t } }] });

describe("readChatCompletionStream", () => {
  it("assembles deltas into the non-streaming response shape", async () => {
    const out = await readChatCompletionStream(streamOf([delta("Hel"), delta("lo "), delta("world"), "data: [DONE]\n\n"]));
    expect(out.choices[0].message.content).toBe("Hello world");
    expect(out.usage).toBeUndefined();
  });

  it("handles frames split across read boundaries and CRLF", async () => {
    const whole = delta("ab") + delta("cd") + "data: [DONE]\n\n";
    const crlf = whole.replace(/\n/g, "\r\n");
    const parts: string[] = [];
    for (let i = 0; i < crlf.length; i += 7) parts.push(crlf.slice(i, i + 7));
    const out = await readChatCompletionStream(streamOf(parts));
    expect(out.choices[0].message.content).toBe("abcd");
  });

  it("keeps multi-byte UTF-8 characters split across chunks intact", async () => {
    const bytes = new TextEncoder().encode(delta("naïve €5 ✓") + "data: [DONE]\n\n");
    const mid = Math.floor(bytes.length / 2);
    const out = await readChatCompletionStream(streamOf([bytes.slice(0, mid), bytes.slice(mid)]));
    expect(out.choices[0].message.content).toBe("naïve €5 ✓");
  });

  it("captures usage from a usage frame or x_groq.usage", async () => {
    const a = await readChatCompletionStream(
      streamOf([delta("x"), frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }), "data: [DONE]\n\n"])
    );
    expect(a.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 });
    const b = await readChatCompletionStream(
      streamOf([delta("x"), frame({ choices: [{ delta: {} }], x_groq: { usage: { prompt_tokens: 1, completion_tokens: 2 } } }), "data: [DONE]\n\n"])
    );
    expect(b.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2 });
  });

  it("accepts a stream that ends without [DONE] if it has content", async () => {
    const out = await readChatCompletionStream(streamOf([delta("tail")]));
    expect(out.choices[0].message.content).toBe("tail");
  });

  it("ignores comment, event and blank lines", async () => {
    const out = await readChatCompletionStream(streamOf([": keepalive\n\n", "event: message\n", delta("ok"), "\n", "data: [DONE]\n\n"]));
    expect(out.choices[0].message.content).toBe("ok");
  });

  it("rejects a malformed JSON frame", async () => {
    await expect(readChatCompletionStream(streamOf([delta("a"), "data: {not json\n\n"]))).rejects.toThrow("malformed");
  });

  it("rejects an upstream error frame", async () => {
    await expect(readChatCompletionStream(streamOf([delta("a"), frame({ error: { message: "boom" } })]))).rejects.toThrow("error frame");
  });

  it("rejects an oversized response", async () => {
    await expect(readChatCompletionStream(streamOf([delta("x".repeat(60))]), { maxChars: 50 })).rejects.toThrow("too large");
  });

  it("rejects empty content and a missing body", async () => {
    await expect(readChatCompletionStream(streamOf(["data: [DONE]\n\n"]))).rejects.toThrow("empty content");
    await expect(readChatCompletionStream(null)).rejects.toThrow("no body");
  });
});
