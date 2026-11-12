import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "api/routeBudget" } });

/**
 * Per-route API response time budgets (audit BE #64).
 *
 * Defines initial per-route SLOs and a small timing wrapper that logs a
 * structured ROUTE_BUDGET_EXCEEDED event when a route exceeds its budget.
 * Budgets are tracking thresholds for observability, never request limits:
 * exceeding one changes nothing about the response.
 *
 * The numbers are starting budgets by route class, to be tuned against real
 * latency data once it is being collected - before this, route-level latency
 * was not tracked at all and a slow endpoint was only noticed via complaints.
 */

export const ROUTE_TIME_BUDGETS_MS: Record<string, number> = {
  // AI generation: provider latency dominates; long but bounded.
  "/api/ai": 30000,
  // Public write endpoints.
  "/api/early-access": 3000,
  // Public read endpoints backed by the jobs table.
  "/api/jobs/search": 2000,
  // Cheap public reads.
  "/api/stats": 1000,
  "/api/ticker": 1000,
};

/** Fallback budget for instrumented routes without an explicit entry. */
export const DEFAULT_ROUTE_BUDGET_MS = 5000;

export function getRouteBudgetMs(route: string): number {
  return ROUTE_TIME_BUDGETS_MS[route] ?? DEFAULT_ROUTE_BUDGET_MS;
}

/**
 * Times fn() and warns when the route exceeds its budget. Returns fn()'s
 * result unchanged and never throws for a breach.
 */
export async function measureRouteBudget<T>(route: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    try {
      const durationMs = Date.now() - start;
      const budgetMs = getRouteBudgetMs(route);
      if (durationMs > budgetMs) {
        log.warn("ROUTE_BUDGET_EXCEEDED", {
          event: "ROUTE_BUDGET_EXCEEDED",
          route,
          budgetMs,
          durationMs,
        });
      }
    } catch {
      // Never allow budget logging to fail or mask the route response.
    }
  }
}
