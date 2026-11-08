/**
 * Offline static test for the Memory Leaks row (Backend #47): every
 * long-lived in-memory structure must carry an explicit bound, and the
 * bound must be exercised by a behavioral test. Locks the known bounded
 * structures to their caps so a future refactor cannot quietly drop one.
 * Run: npx tsx scripts/test-memory-bounds.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const handler = fs.readFileSync("src/lib/ai/idempotency.ts", "utf8");
check(
  "AI idempotency result cache keeps its 10,000-entry cap",
  /idempotencyResultCache\.size > 10000/.test(handler)
);
check(
  "AI idempotency cache evicts oldest-first when capped",
  /idempotencyResultCache\.keys\(\)\.next\(\)/.test(handler) &&
    /idempotencyResultCache\.delete\(oldestKey\)/.test(handler)
);
check(
  "AI idempotency cache keeps its 24h TTL with expired-entry removal",
  /IDEMPOTENCY_CACHE_TTL_MS = 24 \* 60 \* 60 \* 1000/.test(handler) &&
    /idempotencyResultCache\.delete\(cacheKey\)/.test(handler)
);

const swr = fs.readFileSync("src/lib/cache/swr.ts", "utf8");
check("client SWR completed-value store enforces the chosen 200-entry cap",
  /SWR_MAX_ENTRIES = 200/.test(swr) && /while \(store\.size > SWR_MAX_ENTRIES\)/.test(swr));
check("SWR fetches and write-through updates share the bounded write path",
  /writeEntry\(key, \{ data, ts: Date\.now\(\) \}\)/.test(swr) &&
  /writeEntry\(key, \{ data, ts: hit\.ts \}\)/.test(swr));

const analytics = fs.readFileSync("src/lib/admin/analytics.ts", "utf8");
check(
  "admin analytics fallback buffer keeps its 5,000-record cap",
  /inMemoryViews\.length > 5000/.test(analytics) &&
    /inMemoryViews = inMemoryViews\.slice\(-5000\)/.test(analytics)
);

const rl = fs.readFileSync("src/lib/api/sharedRateLimit.ts", "utf8");
const windowedStores = rl.match(/RateLimitStore = new Map<string, \{ count: number; resetAt: number \}>\(\)/g) || [];
check(
  "in-memory rate-limit fallback stores are windowed (resetAt) not unbounded counters",
  windowedStores.length >= 7
);

const lru = fs.readFileSync("src/lib/cache/lru.ts", "utf8");
check(
  "LruCache enforces capacity on every set and rejects bad capacity",
  /if \(this\.entries\.size > this\.capacity\)/.test(lru) &&
    /throw new RangeError/.test(lru)
);

const serviceHandler = fs.readFileSync("src/lib/ai/serviceHandler.ts", "utf8");
check(
  "fallback rate-limit stores have a 10,000 distinct-key cap on the single write path",
  /FALLBACK_RATE_LIMIT_MAX_KEYS = 10000/.test(serviceHandler) &&
    /evictFallbackBucketsIfFull\(store, now\)/.test(serviceHandler)
);
check(
  "behavioral bounds suite exists (LruCache + idempotency cache)",
  fs.existsSync("src/lib/__tests__/memoryBounds.test.ts")
);
check(
  "memory-bounds inventory doc exists",
  fs.existsSync("docs/memory-bounds.md")
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
