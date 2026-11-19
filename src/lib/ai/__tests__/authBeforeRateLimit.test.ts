import { describe, it, expect, vi } from "vitest";
import { executeAiCore, AiServiceDeps } from "../serviceHandler";

// Shared rate-limit store is down: the limiter fails closed.
function unavailableLimiterDeps() {
  const checkSharedRateLimit = vi.fn(async () => ({
    allowed: false,
    retryAfter: 30,
    source: "unavailable" as const,
  }));
  const deps = {
    checkSharedRateLimit,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
      GROQ_API_KEY: "gsk_test_key",
    },
  } as unknown as AiServiceDeps;
  return { deps, checkSharedRateLimit };
}

const body = { operation: "job_fit", params: {} };

describe("executeAiCore: auth is checked before the shared rate limiter", () => {
  it.each([null, undefined, "", "Basic abc", "bearer lowercase"])(
    "returns 401 without consulting the limiter when auth header is %s",
    async (header) => {
      const { deps, checkSharedRateLimit } = unavailableLimiterDeps();
      const res = await executeAiCore("127.0.0.1", header as any, body, deps);
      expect(res.statusCode).toBe(401);
      expect(checkSharedRateLimit).not.toHaveBeenCalled();
    }
  );

  it("still fails closed (503) for a Bearer request when the limiter store is unavailable", async () => {
    const { deps, checkSharedRateLimit } = unavailableLimiterDeps();
    const res = await executeAiCore("127.0.0.1", "Bearer some-token", body, deps);
    expect(checkSharedRateLimit).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(503);
    expect(res.headers?.["Retry-After"]).toBe("30");
  });
});
