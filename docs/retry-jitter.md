# Retry Jitter

Every exponential-backoff wait on a retry path passes through
`withJitter` (`src/lib/reliability/jitter.ts`), which spreads each wait
uniformly over ±20% of the computed backoff. Without jitter, isolates or
cron runs that fail together retry together, keeping the downstream
dependency saturated (thundering herd).

Jittered call sites (all enforced by `scripts/test-jitter-policy.ts`):

| Path | Wait | Base expression |
| --- | --- | --- |
| `scripts/utils/polite-fetch.ts` | HTTP 429 retry (no `Retry-After`) | `2000 * 2^attempt` ms |
| `scripts/utils/polite-fetch.ts` | Failed-attempt retry | `1500 * 2^(attempt-1)` ms |
| `src/lib/billing/subscription.ts` | Subscription-check retry (both waits) | `500 * 2^attempt` ms |
| `src/lib/events/failedEvents.ts` | Failed-event replay reschedule | `2^attempt * 60` s |

The 20% fraction is a chosen default: large enough to decorrelate
concurrent retries, small enough to keep worst-case waits close to the
documented backoff growth. A `Retry-After` response header is honored
verbatim (no jitter) because it is the server's own instruction.

Behavioral bounds are pinned in `src/lib/__tests__/jitter.test.ts`
(injected RNG for the exact min/max, 10k-sample default-RNG sweep).
