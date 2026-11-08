import { afterEach, describe, expect, it, vi } from "vitest";
import { getRedis, resetRedisForTests } from "../cache/redis";
import { getEdgeKv } from "../cache/edgeKv";
afterEach(() => { vi.unstubAllEnvs(); resetRedisForTests(); });
describe("cache adapter resolved environment options", () => {
  it("Redis explicit undefined fields do not erase resolved environment values", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://cache.example.invalid/");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "env-token");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "value" })));
    const cache = getRedis({ url: undefined, token: undefined, fetchImpl });
    expect(await cache.get("a/b")).toBe("value");
    expect(fetchImpl).toHaveBeenCalledWith("https://cache.example.invalid/GET/a%2Fb", expect.objectContaining({ headers: { Authorization: "Bearer env-token" } }));
  });
  it("Edge KV explicit undefined fields do not erase resolved environment values", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_KV_NAMESPACE_ID", "namespace");
    vi.stubEnv("CLOUDFLARE_KV_API_TOKEN", "env-token");
    const fetchImpl = vi.fn(async () => new Response("value"));
    const cache = getEdgeKv({ accountId: undefined, namespaceId: undefined, apiToken: undefined, fetchImpl });
    expect(await cache.get("a/b")).toBe("value");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/accounts/account/storage/kv/namespaces/namespace/values/a%2Fb", expect.objectContaining({ headers: { Authorization: "Bearer env-token" } }));
  });
  it("explicit Redis values still override the environment", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://wrong.example.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "wrong");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "value" })));
    await getRedis({ url: "https://chosen.example.invalid", token: "chosen", fetchImpl }).get("key");
    expect(fetchImpl).toHaveBeenCalledWith("https://chosen.example.invalid/GET/key", expect.objectContaining({ headers: { Authorization: "Bearer chosen" } }));
  });
  it("explicit Edge KV values still override the environment", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "wrong"); vi.stubEnv("CLOUDFLARE_KV_NAMESPACE_ID", "wrong"); vi.stubEnv("CLOUDFLARE_KV_API_TOKEN", "wrong");
    const fetchImpl = vi.fn(async () => new Response("value"));
    await getEdgeKv({ accountId: "chosen", namespaceId: "selected", apiToken: "chosen", fetchImpl }).get("key");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/accounts/chosen/storage/kv/namespaces/selected/values/key", expect.objectContaining({ headers: { Authorization: "Bearer chosen" } }));
  });
  it("explicit empty strings still disable adapters instead of selecting env credentials", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://cache.example.invalid"); vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "env");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account"); vi.stubEnv("CLOUDFLARE_KV_NAMESPACE_ID", "namespace"); vi.stubEnv("CLOUDFLARE_KV_API_TOKEN", "env");
    expect(getRedis({ token: "" }).isEnabled()).toBe(false);
    expect(getEdgeKv({ apiToken: "" }).isEnabled()).toBe(false);
  });
});
