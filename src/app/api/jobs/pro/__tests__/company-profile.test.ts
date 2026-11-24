import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, fromMock, entitlementMock, banMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  fromMock: vi.fn(),
  entitlementMock: vi.fn(),
  banMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: getUserMock }, from: fromMock }) }));
vi.mock("@/lib/billing/serverEntitlement", () => ({ getServerEntitlement: entitlementMock }));
vi.mock("@/lib/admin/auth", () => ({ verifyUserNotBanned: banMock }));

import { GET } from "../route";

describe("Pro company profile endpoint gate", () => {
  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-service-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
    getUserMock.mockReset(); fromMock.mockReset(); entitlementMock.mockReset(); banMock.mockReset();
    banMock.mockResolvedValue({ isBlocked: false });
    entitlementMock.mockResolvedValue({ isPro: false });
  });

  it("does not query protected profile tables for a guest", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
    const response = await GET(new Request("https://careermonke.test/api/jobs/pro?id=job-1"));
    expect(response.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("companyProfile");
  });

  it("does not query protected profile tables for a free account", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "free-user", user_metadata: {} } }, error: null });
    const response = await GET(new Request("https://careermonke.test/api/jobs/pro?id=job-1", { headers: { authorization: "Bearer test-session" } }));
    expect(response.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("companyProfile");
  });

  it("keeps expired subscriptions and entitlement failures outside the profile query path", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "expired-user", user_metadata: {} } }, error: null });
    entitlementMock.mockResolvedValueOnce({ isPro: false, status: "expired" });
    const expired = await GET(new Request("https://careermonke.test/api/jobs/pro?id=job-1", { headers: { authorization: "Bearer test-session" } }));
    expect(expired.status).toBe(403);
    entitlementMock.mockRejectedValueOnce(new Error("entitlement lookup failed"));
    const failed = await GET(new Request("https://careermonke.test/api/jobs/pro?id=job-1", { headers: { authorization: "Bearer test-session" } }));
    expect(failed.status).toBe(500);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("keeps banned accounts outside the profile query path", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "banned-user", user_metadata: {} } }, error: null });
    banMock.mockResolvedValueOnce({ isBlocked: true, error: "Account suspended" });
    const response = await GET(new Request("https://careermonke.test/api/jobs/pro?id=job-1", { headers: { authorization: "Bearer test-session" } }));
    expect(response.status).toBe(403);
    expect(entitlementMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });
});
