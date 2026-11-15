import { describe, it, expect, vi, beforeEach } from "vitest";
import { cancelSubscription } from "../billing/subscription";

// Mock supabase client and dependencies
const mockSubRow = {
  id: "sub_uuid_123",
  user_id: "user_uuid_456",
  provider: "razorpay",
  subscription_id: "sub_rzp_active_789",
  plan_id: "monthly",
  currency: "INR",
  amount: 149900,
  status: "active",
  current_period_start: new Date(Date.now() - 5 * 86400000).toISOString(),
  current_period_end: new Date(Date.now() + 25 * 86400000).toISOString(), // 25 days remaining
  cancel_at_period_end: false,
  metadata: { provider_subscription_id: "sub_rzp_active_789" },
};

let capturedUpdate: any = null;

vi.mock("../supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: {
          session: {
            user: { id: "user_uuid_456" },
            access_token: "mock_jwt_token",
          },
        },
      }),
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: { id: "user_uuid_456" },
        },
      }),
    },
    from: (table: string) => {
      if (table === "subscriptions") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      ...mockSubRow,
                      cancel_at_period_end: capturedUpdate?.cancel_at_period_end ?? false,
                      status: mockSubRow.status, // stays active!
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: (payload: any) => {
            capturedUpdate = payload;
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              in: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      };
    },
  }),
}));

describe("Legacy cancelSubscription() (Reviewer 9)", () => {
  beforeEach(() => {
    capturedUpdate = null;
    vi.restoreAllMocks();
  });

  it("keeps paid access until period end and does NOT set status canceled immediately", async () => {
    // Mock global fetch for DELETE /api/billing/razorpay/subscription
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        message: "Subscription auto-renew canceled",
        cancelAtPeriodEnd: true,
      }),
    } as any);

    const result = await cancelSubscription();

    expect(result).not.toBeNull();
    // Must preserve active status until period end
    expect(result?.status).toBe("active");
    // Must mark cancelAtPeriodEnd = true
    expect(result?.cancelAtPeriodEnd).toBe(true);

    // Verify DB update did NOT set status: "canceled"
    expect(capturedUpdate).not.toBeNull();
    expect(capturedUpdate.cancel_at_period_end).toBe(true);
    expect(capturedUpdate.status).toBeUndefined(); // NEVER set to 'canceled' immediately
  });
});
