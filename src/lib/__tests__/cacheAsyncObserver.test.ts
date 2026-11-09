import { describe, expect, it, vi } from "vitest";
import { getRedis } from "../cache/redis";
import { getEdgeKv } from "../cache/edgeKv";

const backendFailure = new Error("backend unavailable");
const rejectBackend = async () => { throw backendFailure; };

describe("cache async observer failure containment", () => {
  it.each(["redis", "binding", "rest"])("observes rejected %s telemetry without changing miss/no-op results", async (kind) => {
    const onError = vi.fn(async () => { throw new Error("async telemetry unavailable"); });
    if (kind === "redis") {
      const cache = getRedis({ url: "https://cache.example.invalid", token: "test", fetchImpl: rejectBackend, onError });
      expect(await cache.get("k")).toBeNull();
      expect(await cache.set("k", "v")).toBe(false);
      expect(await cache.del("k")).toBe(false);
      expect(await cache.incr("k")).toBeNull();
    } else {
      const cache = getEdgeKv(kind === "binding"
        ? { binding: { get: rejectBackend, put: rejectBackend, delete: rejectBackend }, onError }
        : { accountId: "test", namespaceId: "test", apiToken: "test", fetchImpl: rejectBackend, onError });
      expect(await cache.get("k")).toBeNull();
      expect(await cache.getJson("k")).toBeNull();
      expect(await cache.put("k", "v")).toBe(false);
      expect(await cache.delete("k")).toBe(false);
    }
    expect(onError).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledWith(backendFailure);
    // Let unhandled rejections surface to Vitest if containment is removed.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  it("does not wait for a never-settling telemetry callback", async () => {
    const onError = vi.fn(() => new Promise<void>(() => {}));
    const redis = getRedis({ url: "https://cache.example.invalid", token: "test", fetchImpl: rejectBackend, onError });
    const kv = getEdgeKv({ binding: { get: rejectBackend, put: rejectBackend, delete: rejectBackend }, onError });
    expect(await redis.get("k")).toBeNull();
    expect(await kv.get("k")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
