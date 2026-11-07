import { describe, it, expect } from "vitest";
import {
  makeRateLimitResult,
  rateLimitAllow,
  rateLimitDeny,
  rateLimitDown,
  makeRequest,
  makeRequestFromIp,
  makePageViewPayload,
  makeJobEligibilityRecord,
} from "./fixtures";

describe("shared fixtures", () => {
  it("builds the shared rate-limit shape with sane defaults", async () => {
    expect(makeRateLimitResult()).toEqual({ allowed: true, retryAfter: 0, currentCount: 1, source: "shared" });
    expect(await rateLimitAllow()).toMatchObject({ allowed: true });
    expect((await rateLimitDeny()).allowed).toBe(false);
    expect((await rateLimitDown()).source).toBe("unavailable");
  });

  it("builds requests with headers and Bearer tokens", async () => {
    const req = makeRequest("https://x.test/api/ticker", { method: "POST", token: "tok", headers: { "x-a": "1" } });
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer tok");
    expect(req.headers.get("x-a")).toBe("1");
    expect(makeRequest("https://x.test/").headers.get("authorization")).toBeNull();
  });

  it("builds IP-carried requests for rate-limit tests", () => {
    const req = makeRequestFromIp("https://x.test/api/stats", "1.2.3.4");
    expect(req.headers.get("x-forwarded-for")).toBe("1.2.3.4");
    expect(makeRequestFromIp("https://x.test/").headers.get("x-forwarded-for")).toBeNull();
  });

  it("domain fixtures match the production field names they mirror", () => {
    const pv = makePageViewPayload({ path: "/jobs/123" });
    expect(pv).toMatchObject({ path: "/jobs/123", ipHash: expect.any(String) });
    const job = makeJobEligibilityRecord({ remote: true, remote_scope: "worldwide" });
    expect(job).toMatchObject({ country_code: "IN", remote: true, remote_scope: "worldwide" });
  });
});
