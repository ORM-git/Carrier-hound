import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createOperationId } from "@/lib/security/operationId";

afterEach(() => vi.restoreAllMocks());

describe("cryptographic operation identities", () => {
  it("uses Web Crypto UUIDs for both identity classes, not Math.random", () => {
    const uuid = "12345678-1234-4234-8234-123456789012";
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("weak RNG called"); });
    expect(createOperationId("set")).toBe(`set_${uuid}`);
    expect(createOperationId("lease")).toBe(`lease_${uuid}`);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it("never falls back to weak randomness on a Web Crypto failure", () => {
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("crypto unavailable"); });
    expect(() => createOperationId("lease")).toThrow("crypto unavailable");
  });

  it("AI handler uses the helper for operation-set and lease identifiers", () => {
    const source = readFileSync("src/lib/ai/serviceHandler.ts", "utf8");
    expect(source).toContain('createOperationId("set")');
    expect(source).toContain('createOperationId("lease")');
    expect(source).not.toContain("Math.random(");
  });
});
