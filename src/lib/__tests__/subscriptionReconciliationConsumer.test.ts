import { describe, it, expect, vi } from "vitest";
import { reconcileSubscriptionMandates } from "../billing/reconcile";

describe("reconcileSubscriptionMandates Consumer", () => {
  it("resolves and marks orders failed when provider returns 404 (mandate does not exist)", async () => {
    const mockUpdates: any[] = [];
    const mockOrderUpdates: any[] = [];

    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "subscription_reconciliations") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "rec_1",
                  user_id: "u_1",
                  provider_subscription_id: "sub_not_found_123",
                  reservation_order_id: "res_order_123",
                  reconciliation_state: "pending",
                },
              ],
              error: null,
            }),
            update: vi.fn((patch: any) => {
              mockUpdates.push(patch);
              return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
            }),
          };
        }
        if (table === "payment_orders") {
          return {
            update: vi.fn((patch: any) => {
              mockOrderUpdates.push(patch);
              return {
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockResolvedValue({ data: null, error: null }),
              };
            }),
          };
        }
        return {};
      }),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    });

    const res = await reconcileSubscriptionMandates(mockSupabaseAdmin, {
      credentials: "test_credentials",
      fetchFn: mockFetch as any,
    });

    expect(res.processed).toBe(1);
    expect(res.resolved).toBe(1);
    expect(res.failed).toBe(0);
    expect(mockUpdates[0].reconciliation_state).toBe("resolved");
    expect(mockUpdates[0].recovery_outcome).toBe("not_found_on_provider_released");
    expect(mockOrderUpdates[0].status).toBe("failed");
  });

  it("cancels orphan mandate at provider when still active and marks cancelled", async () => {
    const mockUpdates: any[] = [];
    const mockOrderUpdates: any[] = [];

    const mockSupabaseAdmin = {
      from: vi.fn((table: string) => {
        if (table === "subscription_reconciliations") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "rec_2",
                  user_id: "u_2",
                  provider_subscription_id: "sub_orphan_456",
                  reservation_order_id: "res_order_456",
                  reconciliation_state: "pending",
                },
              ],
              error: null,
            }),
            update: vi.fn((patch: any) => {
              mockUpdates.push(patch);
              return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
            }),
          };
        }
        if (table === "payment_orders") {
          return {
            update: vi.fn((patch: any) => {
              mockOrderUpdates.push(patch);
              return {
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockResolvedValue({ data: null, error: null }),
              };
            }),
          };
        }
        return {};
      }),
    };

    const mockFetch = vi.fn((url: string, opts?: any) => {
      if (opts?.method === "GET") {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ id: "sub_orphan_456", status: "active", cancel_at_cycle_end: 0 }),
        });
      }
      if (opts?.method === "POST") {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ id: "sub_orphan_456", status: "cancelled", cancel_at_cycle_end: 0 }),
        });
      }
      return Promise.reject(new Error("unexpected call"));
    });

    const res = await reconcileSubscriptionMandates(mockSupabaseAdmin, {
      credentials: "test_credentials",
      fetchFn: mockFetch as any,
    });

    expect(res.processed).toBe(1);
    expect(res.resolved).toBe(1);
    expect(mockUpdates[0].reconciliation_state).toBe("resolved");
    expect(mockUpdates[0].recovery_outcome).toBe("cancelled_orphan_mandate_at_provider");
    expect(mockOrderUpdates[0].status).toBe("cancelled");
  });
});
