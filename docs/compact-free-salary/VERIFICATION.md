# Compact INR and free salary

Salary now appears for active jobs on free/guest listings, recommendations and search detail. Only salary, salary_display and salary_original are unmasked. Inactive detail remains blank; company, logo, location, apply URL, description and skills retain their prior entitlement rules. Pro detail endpoint still rejects free access. No DB/view/grant/schema or pricing changes.

UI compacts explicitly INR values to Cr or Lakh with one decimal maximum. Foreign salary stays unchanged and is still shown secondarily when provided. Missing salary shows Not disclosed. No FX calculation changed. Direct jobs_public degraded fallback has no source salary to expose, so it shows Not disclosed.

20 final focused tests pass (formatter, free-vs-Pro handlers, mobile field parity/density); typecheck passes. Earlier wider salary/API/component run passed 74 tests. Browser fixture covers free and missing salary feed/detail at 360/390/768/1440, 8 cases with no horizontal overflow. Inspected 390/1440 feed and free/missing detail pixels. Fixture masks free description and skills to match real handler tests. Screenshots predate separate feed-polish PR; they demonstrate salary only. Full suite is CI's gate, no full-suite pass claimed. No merge.

## INR-only display follow-up

Owner removed the secondary USD line. Removed original-currency rendering and hover titles from all four feed/detail salary blocks. API original data stays intact; only UI changes. No FX changes. Rechecked 8 browser cases with explicit no-USD assertions in feed and detail, 7 formatter/UI tests and typecheck pass. Updated 390/1440 screenshots inspected. Recommended route suite previously passed all 40 after updating free salary expectations.
