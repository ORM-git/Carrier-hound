import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getWorldwideCompanies,
  WORLDWIDE_QUERY_TIMEOUT_MS,
} from "../worldwide";
import { WORLDWIDE_COMPANIES } from "@/data/companies";

describe("getWorldwideCompanies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("success path", () => {
    it("updates company counts from live query and clears the 4-second timeout timer", async () => {
      const mockClient = {
        from: (table: string) => ({
          select: () => {
            expect(table).toBe("worldwide_company_counts");
            return Promise.resolve({
              data: [
                {
                  name: "Stripe",
                  slug: "stripe",
                  country: "United States",
                  active_job_count: 85,
                },
                {
                  name: "GitLab",
                  slug: "gitlab",
                  country: "United States",
                  active_job_count: 42,
                },
              ],
              error: null,
            });
          },
        }),
      };

      const result = await getWorldwideCompanies(mockClient);

      expect(result).toHaveLength(WORLDWIDE_COMPANIES.length);
      const stripe = result.find((c) => c.slug === "stripe");
      const gitlab = result.find((c) => c.slug === "gitlab");
      expect(stripe?.jobCount).toBe(85);
      expect(gitlab?.jobCount).toBe(42);

      // Verify timer was cleared on success
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the timer when query resolves after a brief asynchronous delay", async () => {
      const mockClient = {
        from: () => ({
          select: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve({
                  data: [
                    {
                      name: "Supabase",
                      slug: "supabase",
                      country: "United States",
                      active_job_count: 67,
                    },
                  ],
                  error: null,
                });
              }, 150);
            }),
        }),
      };

      const promise = getWorldwideCompanies(mockClient);

      // Timer for 4s timeout is active while query is running
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      // Advance past 150ms query delay
      await vi.advanceTimersByTimeAsync(150);
      const result = await promise;

      const supabase = result.find((c) => c.slug === "supabase");
      expect(supabase?.jobCount).toBe(67);

      // Verify the 4-second race timer was cancelled on success
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("error path", () => {
    it("falls back to static WORLDWIDE_COMPANIES on PostgREST error response and clears timer", async () => {
      const errorClient = {
        from: () => ({
          select: () =>
            Promise.resolve({
              data: null,
              error: {
                code: "42P01",
                message: 'relation "worldwide_company_counts" does not exist',
              },
            }),
        }),
      };

      const result = await getWorldwideCompanies(errorClient);

      expect(result).toEqual(WORLDWIDE_COMPANIES);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("falls back to static WORLDWIDE_COMPANIES on rejected promise / network exception and clears timer", async () => {
      const rejectingClient = {
        from: () => ({
          select: () => Promise.reject(new Error("Supabase gateway unreachable")),
        }),
      };

      const result = await getWorldwideCompanies(rejectingClient);

      expect(result).toEqual(WORLDWIDE_COMPANIES);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("falls back to static WORLDWIDE_COMPANIES when query returns null data without error", async () => {
      const nullDataClient = {
        from: () => ({
          select: () => Promise.resolve({ data: null, error: null }),
        }),
      };

      const result = await getWorldwideCompanies(nullDataClient);

      expect(result).toEqual(WORLDWIDE_COMPANIES);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("timeout path", () => {
    it("falls back to static WORLDWIDE_COMPANIES when query hangs past the 4-second timeout", async () => {
      const stallingClient = {
        from: () => ({
          select: () =>
            new Promise<{ data: any; error: any }>((resolve) => {
              // Simulates Supabase stalling indefinitely past 4s
              setTimeout(() => {
                resolve({
                  data: [
                    {
                      name: "Stripe",
                      slug: "stripe",
                      country: "United States",
                      active_job_count: 999,
                    },
                  ],
                  error: null,
                });
              }, 30000);
            }),
        }),
      };

      const promise = getWorldwideCompanies(stallingClient);

      // Advance by 4000ms (timeout threshold)
      await vi.advanceTimersByTimeAsync(WORLDWIDE_QUERY_TIMEOUT_MS);

      const result = await promise;

      // Must fall back to static list without applying the stalled 999 count
      expect(result).toEqual(WORLDWIDE_COMPANIES);
      const stripe = result.find((c) => c.slug === "stripe");
      expect(stripe?.jobCount).toBe(
        WORLDWIDE_COMPANIES.find((c) => c.slug === "stripe")?.jobCount
      );
    });

    it("falls back to static WORLDWIDE_COMPANIES when query never resolves at all", async () => {
      const hungClient = {
        from: () => ({
          select: () => new Promise(() => {}), // never resolves
        }),
      };

      const promise = getWorldwideCompanies(hungClient);

      await vi.advanceTimersByTimeAsync(WORLDWIDE_QUERY_TIMEOUT_MS);

      const result = await promise;
      expect(result).toEqual(WORLDWIDE_COMPANIES);
    });
  });

  describe("unconfigured client", () => {
    it("returns static WORLDWIDE_COMPANIES immediately when client is null without creating timers", async () => {
      const result = await getWorldwideCompanies(null);

      expect(result).toEqual(WORLDWIDE_COMPANIES);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
