/**
 * Idempotency-key validation and the in-memory idempotent-result cache for
 * AI set endpoints (Testing row "Memory Bounds" / "Fuzz Testing" support).
 * Extracted from serviceHandler.ts so small vitest suites can exercise the
 * cache and validator without importing the full AI service graph
 * (next/server, supabase-js, billing), which broke the CI coverage ratchet.
 * serviceHandler.ts re-exports everything here, so existing imports from
 * "@/lib/ai/serviceHandler" keep working unchanged.
 */

export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_.:-]+$/;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export function validateIdempotencyKey(candidate: unknown): { valid: true; key: string } | { valid: false; error: string } {
  if (candidate === undefined || candidate === null) {
    return { valid: true, key: "" };
  }
  if (typeof candidate !== "string") {
    return { valid: false, error: "Invalid idempotencyKey: must be a string." };
  }
  const trimmed = candidate.trim();
  if (trimmed.length < 1) {
    return { valid: false, error: "Invalid idempotencyKey: cannot be empty or whitespace." };
  }
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      valid: false,
      error: `Invalid idempotencyKey: exceeds maximum length of ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
    };
  }
  if (!IDEMPOTENCY_KEY_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: "Invalid idempotencyKey: must contain only alphanumeric characters, hyphens, underscores, colons, or periods.",
    };
  }
  return { valid: true, key: trimmed };
}

interface IdempotencyCacheEntry {
  payload: any;
  cachedAt: number;
}

const idempotencyResultCache = new Map<string, IdempotencyCacheEntry>();
const IDEMPOTENCY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function _clearIdempotencyResultCacheForTesting(): void {
  idempotencyResultCache.clear();
}

export function getIdempotencyCacheKey(userId: string, kind: string, key: string): string {
  return `${userId}:${kind}:${key}`;
}

export function getIdempotentResult(userId: string, kind: string, key: string): any | null {
  const cacheKey = getIdempotencyCacheKey(userId, kind, key);
  const entry = idempotencyResultCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > IDEMPOTENCY_CACHE_TTL_MS) {
    idempotencyResultCache.delete(cacheKey);
    return null;
  }
  return entry.payload;
}

export function storeIdempotentResult(userId: string, kind: string, key: string, payload: any): void {
  const cacheKey = getIdempotencyCacheKey(userId, kind, key);
  idempotencyResultCache.set(cacheKey, { payload, cachedAt: Date.now() });
  if (idempotencyResultCache.size > 10000) {
    const oldestKey = idempotencyResultCache.keys().next().value;
    if (oldestKey) idempotencyResultCache.delete(oldestKey);
  }
}
