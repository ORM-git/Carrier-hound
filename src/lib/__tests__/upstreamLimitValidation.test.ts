import { describe, expect, it, vi } from "vitest";
import { readChatCompletionStream, DEFAULT_MAX_UPSTREAM_STREAM_CHARS } from "../ai/upstreamStream";

const frame = (text: string) => new TextEncoder().encode(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
);
function source(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame(text)); controller.close(); } });
}

describe("upstream output-limit validation", () => {
  it.each([NaN, Infinity, -Infinity, 0, -1, 0.5, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid limit %s without acquiring or reading the stream", async (maxChars) => {
      const body = source("text");
      const getReader = vi.spyOn(body, "getReader");
      await expect(readChatCompletionStream(body, { maxChars })).rejects.toThrow("positive safe integer");
      expect(getReader).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    },
  );
  it("accepts exactly the explicit limit and rejects the next character", async () => {
    expect((await readChatCompletionStream(source("abc"), { maxChars: 3 })).choices[0].message.content).toBe("abc");
    await expect(readChatCompletionStream(source("abcd"), { maxChars: 3 })).rejects.toThrow("too large");
  });
  it("retains the default bound when omitted or undefined", async () => {
    const text = "x".repeat(DEFAULT_MAX_UPSTREAM_STREAM_CHARS);
    expect((await readChatCompletionStream(source(text))).choices[0].message.content).toHaveLength(text.length);
    await expect(readChatCompletionStream(source(text + "x"), { maxChars: undefined })).rejects.toThrow("too large");
  });
});
