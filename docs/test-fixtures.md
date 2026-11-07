# Test Fixtures

Shared builders live in `src/lib/__tests__/fixtures.ts` and run under the
existing vitest CI gate. Before this module, suites hand-rolled their own
Request builders and rate-limit stubs and the shapes drifted.

What is covered:

| Builder | Shape it mirrors |
| --- | --- |
| `makeRateLimitResult` / `rateLimitAllow` / `rateLimitDeny` / `rateLimitDown` | The shared rate-limit result consumed across `src/lib` handlers |
| `makeRequest` | Plain `Request` with headers / method / Bearer token |
| `makeRequestFromIp` | `x-forwarded-for`-carrying request for rate-limit and ATO tests |
| `makePageViewPayload` | `PageViewPayload` in `src/lib/admin/analytics.ts` |
| `makeJobEligibilityRecord` | `JobEligibilityRecord` in `src/lib/jobs/eligibility.ts` |

Rules:

1. A new suite uses these builders when the shape matches; add a local
   helper only for a shape this module does not cover, and promote it
   here once a second suite needs it.
2. Builders mirror the production interface field names exactly - a
   fixture that invents its own field names is a bug factory.
3. Keep defaults minimal and overridable; no random data in fixtures
   (seeded randomness belongs to the fuzz suite,
   `src/lib/__tests__/fuzzValidators.test.ts`).

The ingestion side keeps its own fixture path: `scripts/ingest.mts
--seed` runs against `config/companies-seed.json`, and CI scripts run on
dummy env vars. Those are deliberately separate from these unit-test
builders.
