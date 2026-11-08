import { describe, expect, it, vi } from "vitest";
import { getRedis } from "../cache/redis";
import { getEdgeKv } from "../cache/edgeKv";

function throwingHook() {
  return vi.fn(() => { throw new Error("telemetry failed"); });
}
const failure = new Error("cache backend failed");

describe("cache failures remain fail-open when the error observer throws", () => {
  it.each(["network", "http", "json", "provider"])("Redis %s failure returns misses/no-ops for every operation", async (kind) => {
    const hook = throwingHook();
    const fetchImpl = vi.fn(async () => {
      if (kind === "network") throw failure;
      if (kind === "http") return new Response("outage", { status: 503 });
      if (kind === "json") return new Response("not json");
      return new Response(JSON.stringify({ error: "unavailable" }));
    });
    const cache = getRedis({ url: "https://cache.example.invalid", token: "test", fetchImpl, onError: hook });
    expect(await cache.get("key")).toBeNull();
    expect(await cache.set("key", "value")).toBe(false);
    expect(await cache.del("key")).toBe(false);
    expect(await cache.incr("key")).toBeNull();
    expect(hook).toHaveBeenCalledTimes(4);
  });
  it("Edge KV binding exceptions return miss/no-op for every operation", async () => {
    const hook = throwingHook();
    const binding = { get: vi.fn(async () => { throw failure; }), put: vi.fn(async () => { throw failure; }), delete: vi.fn(async () => { throw failure; }) };
    const cache = getEdgeKv({ binding, onError: hook });
    expect(await cache.get("key")).toBeNull();
    expect(await cache.getJson("key")).toBeNull();
    expect(await cache.put("key", "value")).toBe(false);
    expect(await cache.delete("key")).toBe(false);
    expect(hook).toHaveBeenCalledTimes(4);
    expect(hook).toHaveBeenCalledWith(failure);
  });
  it.each(["network", "http"])("Edge KV REST %s failure returns miss/no-op for every operation", async (kind) => {
    const hook = throwingHook();
    const fetchImpl = vi.fn(async () => {
      if (kind === "network") throw failure;
      return new Response("outage", { status: 503 });
    });
    const cache = getEdgeKv({ accountId: "test", namespaceId: "test", apiToken: "test", fetchImpl, onError: hook });
    expect(await cache.get("key")).toBeNull();
    expect(await cache.getJson("key")).toBeNull();
    expect(await cache.put("key", "value")).toBe(false);
    expect(await cache.delete("key")).toBe(false);
    expect(hook).toHaveBeenCalledTimes(4);
  });
  it("Edge KV malformed JSON does not escape through the observer", async () => {
    const hook = throwingHook();
    const cache = getEdgeKv({ accountId: "test", namespaceId: "test", apiToken: "test", fetchImpl: async () => new Response("malformed"), onError: hook });
    expect(await cache.getJson("key")).toBeNull();
    expect(hook).toHaveBeenCalledTimes(1);
  });
  it("Edge KV body-read failure does not escape through the observer", async () => {
    const hook = throwingHook();
    const cache = getEdgeKv({ accountId: "test", namespaceId: "test", apiToken: "test", fetchImpl: async () => { const response = new Response("body"); vi.spyOn(response, "text").mockRejectedValue(failure); return response; }, onError: hook });
    expect(await cache.get("key")).toBeNull();
    expect(hook).toHaveBeenCalledWith(failure);
  });
  it("healthy Redis and KV reads never call the failing observer", async () => {
    const hook = throwingHook();
    const redis = getRedis({ url: "https://cache.example.invalid", token: "test", fetchImpl: async () => new Response(JSON.stringify({ result: "value" })), onError: hook });
    expect(await redis.get("key")).toBe("value");
    const kv = getEdgeKv({ binding: { get: async () => "value", put: async () => {}, delete: async () => {} }, onError: hook });
    expect(await kv.get("key")).toBe("value");
    expect(await kv.put("key", "value")).toBe(true);
    expect(hook).not.toHaveBeenCalled();
  });
});
