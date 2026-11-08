import { describe, expect, it } from "vitest";
import { createLogger, redactContext } from "../observability/logger";

describe("structured logger array value normalization", () => {
  it("serializes bigints at arbitrary array depths without throwing", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line) });
    expect(() => log.info("array", { values: [BigInt(1), [BigInt(2)], { values: [BigInt(3)] }] })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).values).toEqual(["1", ["2"], { values: ["3"] }]);
  });
  it("uses the same stable markers in arrays and object properties", () => {
    const values = [undefined, NaN, Infinity, -Infinity, Symbol("test"), function named() {}];
    const normalized = redactContext({ values, item: values[0] }) as { values: unknown[]; item: unknown };
    expect(normalized.values).toEqual(values.map(String));
    expect(normalized.item).toBe("undefined");
    expect(() => JSON.stringify(normalized)).not.toThrow();
  });
  it("keeps nested secret-key redaction while normalizing arrays", () => {
    const output = redactContext({ values: [{ token: "do-not-log", safe: [BigInt(9)] }, { password: "hidden" }] });
    expect(output).toEqual({ values: [{ token: "[REDACTED]", safe: ["9"] }, { password: "[REDACTED]" }] });
    expect(JSON.stringify(output)).not.toContain("do-not-log");
  });
  it("keeps circular-array detection and newline-safe one-line emission", () => {
    const array: unknown[] = ["line1\nline2", BigInt(4)]; array.push(array);
    const lines: string[] = [];
    createLogger({ sink: (line) => lines.push(line) }).warn("message\nnext", { array });
    expect(lines).toHaveLength(1); expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0]).array).toEqual(["line1\nline2", "4", "[CIRCULAR]"]);
  });
  it("preserves ordinary JSON array primitives unchanged", () => {
    expect(redactContext([null, true, false, 0, "text", [42]])).toEqual([null, true, false, 0, "text", [42]]);
  });
});
