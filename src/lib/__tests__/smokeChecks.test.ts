import { describe, it, expect } from "vitest";
import { runSmokeChecks, SMOKE_CHECKS } from "@/lib/monitoring/smokeChecks";

// Backend sheet rank 78 (Smoke Tests post-deploy): the scripted checks run
// against a live base URL; here the transport is faked.

const okHealth = async (url: string) => ({
  status: 200,
  text: async () => (url.endsWith("/api/health") ? '{"status":"ok"}' : "<html><body>x</body></html>"),
});

describe("runSmokeChecks", () => {
  it("passes when every check matches", async () => {
    const { ok, results } = await runSmokeChecks("https://careermonke.com/", okHealth);
    expect(ok).toBe(true);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results).toHaveLength(SMOKE_CHECKS.length);
  });

  it("fails on a wrong status and keeps checking the rest", async () => {
    const down = async (url: string) => ({
      status: url.endsWith("/api/health") ? 500 : 200,
      text: async () => (url.endsWith("/api/health") ? "" : "<html></html>"),
    });
    const { ok, results } = await runSmokeChecks("https://careermonke.com", down);
    expect(ok).toBe(false);
    const health = results.find((r) => r.name === "health endpoint");
    expect(health).toMatchObject({ ok: false, status: 500, error: "expected 200" });
    expect(results.find((r) => r.name === "homepage renders")?.ok).toBe(true);
  });

  it("fails on a body-assertion mismatch", async () => {
    const stale = async () => ({ status: 200, text: async () => "maintenance" });
    const { ok } = await runSmokeChecks("https://careermonke.com", stale);
    expect(ok).toBe(false);
  });

  it("reports network errors without throwing", async () => {
    const boom = async () => { throw new Error("ECONNREFUSED"); };
    const { ok, results } = await runSmokeChecks("https://careermonke.com", boom);
    expect(ok).toBe(false);
    expect(results[0].error).toBe("ECONNREFUSED");
  });

  it("smoke set stays small, read-only, and grounded in real routes", () => {
    expect(SMOKE_CHECKS.length).toBeLessThanOrEqual(5);
    for (const c of SMOKE_CHECKS) {
      expect(c.method ?? "GET").toBe("GET");
    }
    expect(SMOKE_CHECKS.map((c) => c.path)).toContain("/api/health");
  });
});
