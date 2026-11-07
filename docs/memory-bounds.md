# Memory Bounds (Leak Posture)

Serverless isolates are short-lived, which is the outer bound on any
in-memory growth. Within an isolate, every long-lived structure carries
an explicit cap so a hot or hostile workload cannot grow memory without
limit. This inventory is enforced by `scripts/test-memory-bounds.ts`
(static) and `src/lib/__tests__/memoryBounds.test.ts` (behavioral).

| Structure | Location | Bound |
| --- | --- | --- |
| AI idempotency result cache | `src/lib/ai/idempotency.ts` | 10,000 entries (oldest-first eviction) + 24h TTL with expired-entry removal on read |
| Admin analytics fallback buffer | `src/lib/admin/analytics.ts` | 5,000 most-recent records (`slice(-5000)`) |
| Rate-limit fallback stores | `src/lib/api/sharedRateLimit.ts` | Per-key `{ count, resetAt }` windows (O(1) per key); used only when the shared store is down |
| `LruCache` | `src/lib/cache/lru.ts` | Constructor-enforced capacity, oldest-first eviction on every `set` |

Residual risks, recorded honestly:

- The windowed rate-limit fallback maps are not pruned mid-window; their
  cardinality is bounded by distinct keys seen within one isolate
  lifetime, and isolates reset on recycle. The shared store is the
  primary path; the in-memory maps are a degraded-mode fallback only.
- `src/lib/cache/swr.ts` is a client-side, memory-only store with no
  persistence; it is cleared on every full page reload and bounded by
  the keys a single tab actually uses.

If a new long-lived `Map`, array, or cache is introduced, give it an
explicit cap or window here and extend the two suites above.
