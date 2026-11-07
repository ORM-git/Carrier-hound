# Race-Condition Handling Audit

Every async surface in the app, its out-of-order race vector, and the guard
that covers it. Rule for adding an async surface: pick the guard pattern,
record the row here, and keep
`src/lib/__tests__/raceConditionAuditDoc.test.ts` green.

| Surface | Race vector | Guard |
| --- | --- | --- |
| `/jobs` list + detail loads | fast typing / pagination resolves out of order | effect-cleanup `cancelled` flags + last-write request refs (`src/app/jobs/page.tsx`) |
| `/jobs` save / applied mutations | duplicate same-tick invocations (double click) | synchronous in-flight refs (`inFlightSaveRef`, `inFlightAppliedRef`), released in `finally` |
| Tracker storage layer | overlapping writes make a stale read land after a newer write | generation token (`activeTrackerGenToken` in `src/lib/tracker/storage.ts`): each write invalidates in-flight reads |
| `/dashboard` bundle loads | overlapping loads / duplicate concurrent fetches | SWR in-flight dedupe (`swrFetch` shared promise) |
| Admin users search | two overlapping searches resolve out of order, older paints over newer | last-issued-wins sequence ref (`fetchSeqRef` in `src/app/admin/users/page.tsx`) |
| Admin user activity panel | quickly opening two users paints the first response into the second panel | last-opened-wins sequence ref (`activitySeqRef` in `src/app/admin/users/page.tsx`) |
| Settings / onboarding / profile saves | user-driven sequential submits | server last-write-wins is correct: each submit sends the full payload, no partial-merge hazard; no client guard needed |

Why no global request manager: the surfaces are few and their guards are
local and provable. A shared abstraction would couple unrelated pages
without removing any of the guards above.
