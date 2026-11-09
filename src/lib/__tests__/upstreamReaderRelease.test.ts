import { describe, expect, it, vi } from "vitest";
import { readChatCompletionStream } from "../ai/upstreamStream";

const data = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
function source(text: string, options: { close?: boolean; rejectCancel?: boolean } = {}) {
  const cancel = vi.fn(() => options.rejectCancel ? Promise.reject(new Error("cancel failure")) : undefined);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      if (options.close) controller.close();
    }, cancel,
  });
  return { body, cancel };
}

describe("upstream parser reader ownership", () => {
  it("releases the lock after normal EOF without DONE", async () => {
    const { body } = source(data("ok"), { close: true });
    expect((await readChatCompletionStream(body)).choices[0].message.content).toBe("ok");
    expect(body.locked).toBe(false);
  });
  it.each([false, true])("releases after terminal cancellation, cancel rejection=%s", async (rejectCancel) => {
    const { body, cancel } = source(data("ok") + "data: [DONE]\n\n", { rejectCancel });
    expect((await readChatCompletionStream(body)).choices[0].message.content).toBe("ok");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it.each(["data: broken\n\n", data("too long")])("releases after parse/size error: %s", async (text) => {
    const { body, cancel } = source(text, { rejectCancel: true });
    await expect(readChatCompletionStream(body, { maxChars: 3 })).rejects.toThrow(/malformed JSON|too large/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it("releases after the underlying reader rejects", async () => {
    const failure = new Error("transport failed");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
    await expect(readChatCompletionStream(body)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });
  it("releases on empty-content rejection after EOF", async () => {
    const { body } = source(": keepalive\n\n", { close: true });
    await expect(readChatCompletionStream(body)).rejects.toThrow("empty content");
    expect(body.locked).toBe(false);
  });
});
