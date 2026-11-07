# Memory Bounds (Leak Posture)

Serverless isolates are short-lived, which is the outer bound on any
in-memory growth. Within an isolate, every long-lived structure carries
an explicit cap so a hot or hostile workload cannot grow memory without
limit. This inventory is enforced by `scripts/test-memory-bounds.ts`
(static) and `src/lib/__tests__/memoryBounds.test.ts` (behavioral).

| Structure | Location | Bound |
| --- | --- | --- |
| AI idempotency result cache | `src/lib/ai/idempotency.ts` | 10,001 max entries (oldest-first eviction when size exceeds 10,000) + 24h TTL with expired-entry removal on read |
| Admin analytics fallback buffer | `src/lib/admin/analytics.ts` | 5,000 most-recent records (`slice(-5000)`) |
| Rate-limit fallback stores | `src/lib/api/sharedRateLimit.ts` (stores) + `src/lib/ai/serviceHandler.ts` (`checkRateLimit`, the single write path) | Max 10,000 distinct keys per store (`FALLBACK_RATE_LIMIT_MAX_KEYS`): expired windows evicted first, then the soonest-expiring live window; used only when the shared store is down |
| `LruCache` | `src/lib/cache/lru.ts` | Constructor-enforced capacity, oldest-first eviction on every `set` |

Residual risks, recorded honestly:

- The windowed rate-limit fallback maps are capped at 10,000 distinct keys
  each (see the inventory row above); eviction is expired-first, then
  soonest-expiring. Windows are not pruned mid-window below the cap. The
  shared store is the primary path; the in-memory maps are a degraded-mode
  fallback only.
- `src/lib/cache/swr.ts` is a client-side, memory-only store with no
  persistence; it is cleared on every full page reload and bounded by
  the keys a single tab actually uses.

If a new long-lived `Map`, array, or cache is introduced, give it an
explicit cap or window here and extend the two suites above.
