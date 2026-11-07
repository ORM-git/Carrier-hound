import { describe, it, expect } from "vitest";
import { isCrossSiteMutation } from "@/lib/security/sameOrigin";

// Backend sheet rank 60 (CSRF): browsers always send Origin on cross-site
// POSTs, so a mismatched Origin on a mutating /api request is an attack or a
// bug; a missing Origin is server-to-server traffic (no ambient cookies).

describe("isCrossSiteMutation", () => {
  it("allows same-origin mutations", () => {
    expect(isCrossSiteMutation("POST", "/api/track", "https://careermonke.com", "careermonke.com")).toBe(false);
  });

  it("blocks cross-origin POST/PUT/DELETE to /api", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isCrossSiteMutation(m, "/api/track", "https://evil.example", "careermonke.com")).toBe(true);
    }
  });

  it("allows safe methods even with a foreign Origin", () => {
    expect(isCrossSiteMutation("GET", "/api/jobs/suggest", "https://evil.example", "careermonke.com")).toBe(false);
    expect(isCrossSiteMutation("OPTIONS", "/api/track", "https://evil.example", "careermonke.com")).toBe(false);
  });

  it("ignores non-API paths", () => {
    expect(isCrossSiteMutation("POST", "/login", "https://evil.example", "careermonke.com")).toBe(false);
  });

  it("passes requests with no Origin (server-to-server, webhooks, cron)", () => {
    expect(isCrossSiteMutation("POST", "/api/billing/razorpay/webhook", null, "careermonke.com")).toBe(false);
  });

  it("fails closed on an unparseable Origin or missing host", () => {
    expect(isCrossSiteMutation("POST", "/api/track", "not-a-url", "careermonke.com")).toBe(true);
    expect(isCrossSiteMutation("POST", "/api/track", "https://careermonke.com", null)).toBe(true);
  });

  it("compares hosts case-insensitively and with ports", () => {
    expect(isCrossSiteMutation("POST", "/api/track", "https://CareerMonke.com", "careermonke.com")).toBe(false);
    expect(isCrossSiteMutation("POST", "/api/track", "http://localhost:3000", "localhost:3000")).toBe(false);
    expect(isCrossSiteMutation("POST", "/api/track", "http://localhost:3001", "localhost:3000")).toBe(true);
  });
});
