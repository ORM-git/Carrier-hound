// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyTextToClipboard } from "../clipboard";

const originalClipboard = navigator.clipboard;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
});

describe("copyTextToClipboard", () => {
  it("uses the async Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("returns false when both paths fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false);
    await expect(copyTextToClipboard("hello")).resolves.toBe(false);
  });

  it("returns false when no clipboard mechanism exists", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => { throw new Error("nope"); });
    await expect(copyTextToClipboard("hello")).resolves.toBe(false);
  });
});
