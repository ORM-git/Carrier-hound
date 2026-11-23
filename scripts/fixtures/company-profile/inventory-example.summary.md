# Company-profile candidate inventory (read-only)

Generated 2026-11-22T10:00:00Z · target `local` · code `0000000000000000000000000000000000000000`
Window: after `start`, 15 of limit 1000 scanned · next cursor `none (end of table)`

Scope: Counts, holds and the shortlist cover only the companies scanned in this window. Domain ownership is checked against every company in the table; ATS boards, active jobs and profile rows are read in full for the scanned companies. Separate windows are not merged into one ranking.

**No writes, no crawl. Suggestions are not permission:** the owner picks at most 3 UUIDs for the read-only canary plan.

## Company counts (categories overlap; see the JSON `definitions`)

| scanned | eligible | missing domain | ambiguous | no enabled ATS | fresh (cache hit) | refresh not due | stale | conflict | never enriched | missing facts | missing leadership | missing news | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 15 | 4 | 2 | 4 | 2 | 1 | 1 | 12 | 1 | 11 | 11 | 12 | 12 | 1 |

Existing rows for these companies: 3 facts, 2 leaders, 2 news items, 3 refresh states.

## Shortlist

- 1. More active jobs first: those are the job pages Pro users open.
- 2. More missing sections first (facts, leadership and news each count as one).
- 3. Never enriched first, then oldest last successful refresh.
- 4. Company UUID ascending, as a stable tie-break.

| # | Company UUID | Name | Domain | Active jobs | Coverage (facts / leaders / news) | Why | Max requests |
|---|---|---|---|---|---|---|---|
| 1 | `c0000000-0000-4000-8000-000000000001` | Northwind Robotics | northwind-robotics.example | 9 | 0 / 0 / 0 | 9 active jobs; missing facts, leadership, news; never enriched; enabled ATS evidence: greenhouse:slug-01 | 5 (15 with retries) |
| 2 | `c0000000-0000-4000-8000-000000000002` | Tie Alpha | tie-alpha.example | 3 | 0 / 0 / 0 | 3 active jobs; missing facts, leadership, news; never enriched; enabled ATS evidence: greenhouse:slug-02 | 5 (15 with retries) |
| 3 | `c0000000-0000-4000-8000-000000000015` | Tie Gamma | tie-gamma.example | 3 | 0 / 0 / 0 | 3 active jobs; missing facts, leadership, news; never enriched; enabled ATS evidence: greenhouse:slug-15 | 5 (15 with retries) |
| 4 | `c0000000-0000-4000-8000-000000000004` | Harbor Signal | harbor-signal.example | 2 | 1 / 1 / 1 | 2 active jobs; all three sections have rows; last successful refresh 2026-11-01; has a conflict to re-check; enabled ATS evidence: greenhouse:slug-04 | 5 (15 with retries) |

## Review queue (6): fix or confirm the domain by hand; never guessed

- `c0000000-0000-4000-8000-000000000003` Tie Beta (tie-beta.example): ambiguous_identity
- `c0000000-0000-4000-8000-000000000007` Nameonly Inc (—): missing_domain
- `c0000000-0000-4000-8000-000000000008` Bad Domain (https://user@bad:8080/x): missing_domain
- `c0000000-0000-4000-8000-000000000009` Twin One (twins.example): ambiguous_identity
- `c0000000-0000-4000-8000-000000000010` Twin Two (www.twins.example): ambiguous_identity
- `c0000000-0000-4000-8000-000000000014` Tie Beta Holdings (HTTPS://WWW.Tie-Beta.example/careers): ambiguous_identity

## Holds (5)

- `c0000000-0000-4000-8000-000000000005` Fresh Fields: fresh_cache_hit
- `c0000000-0000-4000-8000-000000000006` Cooling Co: refresh_not_due
- `c0000000-0000-4000-8000-000000000011` Disabled Board: no_enabled_ats
- `c0000000-0000-4000-8000-000000000012` No Board: no_enabled_ats
- `c0000000-0000-4000-8000-000000000013` Bad Rows: error
