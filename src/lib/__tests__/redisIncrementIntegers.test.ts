import { describe, expect, it } from "vitest";
import { getRedis } from "../cache/redis";

function adapter(result: unknown) {
  return getRedis({ url: "https://cache.example.invalid", token: "test",
    fetchImpl: async () => new Response(JSON.stringify({ result })),
  });
}

describe("Redis increment result validation", () => {
  it.each(["", " ", "1.5", "1e3", "0x10", "+1", " 1", "1\n", "NaN", "Infinity", "9007199254740992", "9223372036854775807", "-9223372036854775808", 1.5, 9007199254740992, null, true, {}, []])(
    "returns null instead of a false or inexact count for %j", async (result) => {
      expect(await adapter(result).incr("counter")).toBeNull();
    },
  );
  it.each([[0, 0], [1, 1], [-1, -1], ["0", 0], ["12", 12], ["-12", -12],
    ["9007199254740991", Number.MAX_SAFE_INTEGER], ["-9007199254740991", Number.MIN_SAFE_INTEGER]])(
    "preserves exact signed integer %j", async (result, expected) => {
      expect(await adapter(result).incr("counter")).toBe(expected);
    },
  );
});
