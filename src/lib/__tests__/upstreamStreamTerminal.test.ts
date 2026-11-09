import { describe, expect, it, vi } from "vitest";
import { readChatCompletionStream } from "../ai/upstreamStream";

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const terminal = "data: [DONE]\n\n";
function stream(parts: string[]) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      // Leave open so the reader must cancel after the terminal frame.
    }, cancel,
  });
  return { body, cancel };
}

describe("upstream stream terminal frame", () => {
  it.each([
    delta("unwanted tail"),
    "data: {invalid JSON}\n\n",
    'data: {"error":{"message":"late error"}}\n\n',
    'data: {"usage":{"total_tokens":999}}\n\n',
    "data: {unfinished",
  ])("ignores data after DONE in the same chunk: %s", async (tail) => {
    const { body, cancel } = stream([delta("accepted") + terminal + tail]);
    const result = await readChatCompletionStream(body);
    expect(result).toEqual({ choices: [{ message: { content: "accepted" } }] });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("honors DONE split between chunks before ignoring same-chunk trailing data", async () => {
    const { body, cancel } = stream([delta("accepted") + "data: [DO", "NE]\n\n" + delta("tail")]);
    expect((await readChatCompletionStream(body)).choices[0].message.content).toBe("accepted");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not let trailing data turn an empty response into a valid response", async () => {
    const { body } = stream([terminal + delta("tail")]);
    await expect(readChatCompletionStream(body)).rejects.toThrow("empty content");
  });
  it("still rejects malformed data before DONE", async () => {
    const { body, cancel } = stream([delta("accepted") + "data: broken\n\n" + terminal]);
    await expect(readChatCompletionStream(body)).rejects.toThrow("malformed JSON");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
