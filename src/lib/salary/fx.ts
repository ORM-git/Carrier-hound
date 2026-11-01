/**
 * src/lib/salary/fx.ts
 *
 * Lightweight currency conversion service with static fallback table and non-blocking
 * daily cached refresh (24h TTL) from an upstream public exchange rate API.
 * 
 * Supports: USD, EUR, GBP, INR, CAD, AUD.
 * Rule: Never blocks a client/API request on network fetch. Falls back immediately
 * to static table on any network/parsing failure.
 */

export const STATIC_FX_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.79,
  INR: 84.0,
  CAD: 1.38,
  AUD: 1.52,
};

export const FX_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cachedRates: Record<string, number> = { ...STATIC_FX_RATES };
let lastFetchedTimestamp = 0;
let isFetching = false;

/**
 * Refreshes foreign exchange rates from a free public rates source.
 * Updates cachedRates on success, keeps current/static rates on any failure.
 */
export async function refreshFxRates(endpointUrl?: string): Promise<Record<string, number>> {
  const now = Date.now();
  if (lastFetchedTimestamp > 0 && now - lastFetchedTimestamp < FX_CACHE_TTL_MS) {
    return { ...cachedRates };
  }

  if (isFetching) {
    return { ...cachedRates };
  }

  isFetching = true;
  try {
    const url = endpointUrl || "https://open.er-api.com/v6/latest/USD";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const rates = data?.rates;
      if (rates && typeof rates === "object") {
        const nextRates: Record<string, number> = { ...STATIC_FX_RATES };
        for (const curr of Object.keys(STATIC_FX_RATES)) {
          if (typeof rates[curr] === "number" && rates[curr] > 0) {
            nextRates[curr] = rates[curr];
          }
        }
        cachedRates = nextRates;
        lastFetchedTimestamp = Date.now();
        return { ...cachedRates };
      }
    }
  } catch {
    // Graceful fallback: maintain existing cache or static fallback
  } finally {
    isFetching = false;
  }

  return { ...cachedRates };
}

/**
 * Returns current FX rates synchronously without blocking the request.
 * Triggers asynchronous background refresh if TTL has expired.
 */
export function getFxRates(): Record<string, number> {
  const now = Date.now();
  if (now - lastFetchedTimestamp >= FX_CACHE_TTL_MS && !isFetching) {
    // Non-blocking fire-and-forget background refresh
    refreshFxRates().catch(() => {});
  }
  return { ...cachedRates };
}

/**
 * Converts an amount from one currency to another using cached or static rates.
 * Returns null if either currency is unsupported or conversion is impossible.
 */
export function convertCurrency(
  amount: number | null | undefined,
  fromCurrency: string,
  toCurrency: string,
  customRates?: Record<string, number>
): number | null {
  if (amount == null || typeof amount !== "number" || isNaN(amount)) {
    return null;
  }

  const from = (fromCurrency || "").toUpperCase().trim();
  const to = (toCurrency || "").toUpperCase().trim();

  if (!from || !to) return null;
  if (from === to) return amount;

  const rates = customRates || getFxRates();
  const fromRate = rates[from];
  const toRate = rates[to];

  if (!fromRate || !toRate || fromRate <= 0 || toRate <= 0) {
    return null;
  }

  // Convert via USD base: amount in USD = amount / fromRate; amount in target = inUsd * toRate
  const inUsd = amount / fromRate;
  return inUsd * toRate;
}

/**
 * Test helpers for deterministic cache and TTL assertions.
 */
export function _resetFxCacheForTesting(): void {
  cachedRates = { ...STATIC_FX_RATES };
  lastFetchedTimestamp = 0;
  isFetching = false;
}

export function _setLastFetchedForTesting(timestamp: number): void {
  lastFetchedTimestamp = timestamp;
}
