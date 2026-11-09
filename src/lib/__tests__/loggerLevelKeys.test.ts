import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../observability/logger";

afterEach(() => vi.unstubAllEnvs());

describe("logger level own-key validation", () => {
  it.each(["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "INFO", "unknown"])(
    "falls back to info for unsupported environment level %s", (level) => {
      vi.stubEnv("LOG_LEVEL", level);
      const lines: string[] = [];
      const log = createLogger({ sink: (line) => lines.push(line) });
      expect(log.minLevel()).toBe(20);
      log.debug("hidden"); log.info("visible");
      expect(lines.map((line) => JSON.parse(line).msg)).toEqual(["visible"]);
      const child = log.child({ route: "test" });
      expect(child.minLevel()).toBe(20);
      child.debug("hidden child"); child.warn("child warning");
      expect(lines).toHaveLength(2);
    },
  );
  it.each([["debug", 10], ["info", 20], ["warn", 30], ["error", 40], ["silent", Infinity]] as const)(
    "preserves supported environment level %s", (level, threshold) => {
      vi.stubEnv("LOG_LEVEL", level);
      expect(createLogger().minLevel()).toBe(threshold);
    },
  );
  it("preserves an explicit valid level over an invalid environment value", () => {
    vi.stubEnv("LOG_LEVEL", "constructor");
    expect(createLogger({ level: "error" }).minLevel()).toBe(40);
    expect(createLogger({ level: "silent" }).minLevel()).toBe(Infinity);
  });
});
