import { describe, it, expect } from "vitest";
import { exceedsGlobalBodyCap, GLOBAL_API_BODY_CAP_BYTES } from "@/lib/security/bodySize";

// Backend sheet rank 71 (Request Size Limits): a global Content-Length
// precheck bounds every mutating /api route; route-level caps still apply.

describe("exceedsGlobalBodyCap", () => {
  it("rejects bodies over the cap on mutating /api methods", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(exceedsGlobalBodyCap(m, "/api/ai/tailor", String(GLOBAL_API_BODY_CAP_BYTES + 1))).toBe(true);
    }
  });

  it("allows bodies at or under the cap", () => {
    expect(exceedsGlobalBodyCap("POST", "/api/track", "16384")).toBe(false);
    expect(exceedsGlobalBodyCap("POST", "/api/track", String(GLOBAL_API_BODY_CAP_BYTES))).toBe(false);
  });

  it("ignores safe methods and non-API paths", () => {
    const over = String(GLOBAL_API_BODY_CAP_BYTES + 1);
    expect(exceedsGlobalBodyCap("GET", "/api/jobs/suggest", over)).toBe(false);
    expect(exceedsGlobalBodyCap("POST", "/login", over)).toBe(false);
  });

  it("passes requests without a parseable Content-Length (chunked; route caps still apply)", () => {
    const over = String(GLOBAL_API_BODY_CAP_BYTES + 1);
    expect(exceedsGlobalBodyCap("POST", "/api/track", null)).toBe(false);
    expect(exceedsGlobalBodyCap("POST", "/api/track", "not-a-number")).toBe(false);
    expect(exceedsGlobalBodyCap("POST", "/api/track", "-5")).toBe(false);
  });
});
