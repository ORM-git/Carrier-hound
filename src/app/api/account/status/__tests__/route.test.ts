import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeSupabase, seedCompletedAccount } from "@/lib/auth/__tests__/fakeSupabase";

let currentMockAdmin: any = null;

vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: vi.fn(() => undefined),
}));

vi.mock("@/lib/ai/serviceHandler", () => ({
  getSupabaseAdminClient: vi.fn(() => currentMockAdmin),
}));

import { GET } from "../route";

describe("GET /api/account/status", () => {
  beforeEach(() => {
    currentMockAdmin = null;
  });

  it("returns 401 when Authorization header is missing or invalid", async () => {
    const req1 = new Request("http://localhost/api/account/status");
    const res1 = await GET(req1);
    expect(res1.status).toBe(401);

    const req2 = new Request("http://localhost/api/account/status", {
      headers: { Authorization: "Basic invalid" },
    });
    const res2 = await GET(req2);
    expect(res2.status).toBe(401);
  });

  it("inspects deleted_account_tombstones under server authority and reports deletion_pending", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("pending@example.test");
    // Seed tombstone for user
    db.insert("deleted_account_tombstones", {
      user_id: user.id,
      email_hash: "abcd",
      created_at: new Date().toISOString(),
    });

    currentMockAdmin = db.client;
    const req = new Request("http://localhost/api/account/status", {
      headers: { Authorization: `Bearer ${user.id}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deletionPending).toBe(true);
    expect(data.onboardingCompleted).toBe(false);
    expect(data.accountState).toBe("deletion_pending");
  });

  it("reports active completed account when no tombstone exists and profile is completed", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("completed@example.test");
    seedCompletedAccount(db, user.id);

    currentMockAdmin = db.client;
    const req = new Request("http://localhost/api/account/status", {
      headers: { Authorization: `Bearer ${user.id}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deletionPending).toBe(false);
    expect(data.onboardingCompleted).toBe(true);
    expect(data.accountState).toBe("active");
  });

  it("handles missing tombstone table (pre-migration) without failing", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("legacy@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("deleted_account_tombstones", {
      code: "42P01",
      message: 'relation "deleted_account_tombstones" does not exist',
    });

    currentMockAdmin = db.client;
    const req = new Request("http://localhost/api/account/status", {
      headers: { Authorization: `Bearer ${user.id}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deletionPending).toBe(false);
    expect(data.onboardingCompleted).toBe(true);
  });
});
