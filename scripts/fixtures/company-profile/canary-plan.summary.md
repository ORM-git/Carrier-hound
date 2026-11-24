# Company-profile canary plan: review summary

Read this alongside the JSON plan; the JSON and its digest are what the write checks. **A digest proves which plan this is, not that the owner approved it.**

- Plan digest: `6c06184082db9e661ac205b62cbc10d77f5b50723d2ef3898b0c114423f39a9c`
- Target project: `szakevhxhwpeskidvtfs` · schema `20261124a_company_profile_wikidata` · reviewed code SHA `0123456789abcdef0123456789abcdef01234567`
- Created 2026-11-22T10:00:00Z · expires 2026-11-23T10:00:00Z (after that, generate and review a new plan)
- Companies (3 of max 3): `11111111-1111-4111-8111-111111111111`, `22222222-2222-4222-8222-222222222222`, `33333333-3333-4333-8333-333333333333`
- Actions: 9 (6 inserts, 3 updates) across 1 companies. By table: company_profile_facts 6, company_profile_leadership 1, company_profile_news 1, company_profile_refresh_state 1
- **Not atomic.** Each action is one compare-and-set statement, journaled before it runs. A stopped write leaves earlier steps applied; use `--resume` or `--rollback` with the same plan, digest and journal.
- Rollback restores or removes only rows that still hold the canary's values. Rows someone else changed since are left alone and reported as `skipped_drifted`.
- The write fails closed on a changed plan, expiry, another target, code SHA or schema, changed current rows, or any changed source (final URL, status or sha256).

## Affirm

- Company UUID: `11111111-1111-4111-8111-111111111111`
- Canonical domain: affirm.com
- Enabled ATS boards: greenhouse:affirm (`66666666-6666-4666-8666-666666666661`)
- Freshness before: stale (refresh due)
- Outcome: **verified**. Verified first-party source. Proposed rows below.
- Current rows: 1 facts, 1 leaders, 0 news, 1 refresh state

### Sources fetched (5)

| Kind | Requested | Final URL | Status | Fetched at | Bytes | sha256 |
|---|---|---|---|---|---|---|
| robots | https://affirm.com/robots.txt | https://affirm.com/robots.txt | 200 | 2026-11-22T10:00:00Z | 23 | `16ceb5ee3e0dc13aa9adf31a3ebbe45a1d965b8c2b9f72eaf84e5911e140ed95` |
| page | https://affirm.com/ | https://affirm.com/ | 200 | 2026-11-22T10:00:00Z | 1111 | `ab485837d9693280875ae64fdef9cfa1bbfd24d7d69ec23fd3fc1c50875d6f47` |
| page | https://affirm.com/about/leadership-news | https://affirm.com/about/leadership-news | 200 | 2026-11-22T10:00:00Z | 545 | `68f5eb8865eea4152f63b355d6eda2ba66dd56ae79983f9f2f6e97e6df599a47` |
| page | https://affirm.com/about/team | https://affirm.com/about/team | 200 | 2026-11-22T10:00:00Z | 545 | `68f5eb8865eea4152f63b355d6eda2ba66dd56ae79983f9f2f6e97e6df599a47` |
| page | https://affirm.com/news/update | https://affirm.com/news/update | 200 | 2026-11-22T10:00:00Z | 545 | `68f5eb8865eea4152f63b355d6eda2ba66dd56ae79983f9f2f6e97e6df599a47` |

### Facts after the canary (6)

| Fact | Value | Source | Retrieved | Observed | Status | Conflicting report |
|---|---|---|---|---|---|---|
| overview | Old overview | https://affirm.com/old | 2025-01-01T00:00:00Z | — | conflict | Affirm helps consumers pay over time (https://affirm.com/) |
| website | https://affirm.com/ | https://affirm.com/news/update | 2026-11-22T10:00:00Z | — | fresh | — |
| headquarters | San Francisco, California, US | https://affirm.com/ | 2026-11-22T10:00:00Z | — | fresh | — |
| founded_year | 2012 | https://affirm.com/ | 2026-11-22T10:00:00Z | 2012-01-01T00:00:00Z | fresh | — |
| linkedin_url | https://www.linkedin.com/company/affirm | https://affirm.com/ | 2026-11-22T10:00:00Z | — | fresh | — |
| twitter_url | https://x.com/affirm | https://affirm.com/ | 2026-11-22T10:00:00Z | — | fresh | — |

### Leadership after the canary (1)

| Name | Role | Role as of | Source | Retrieved |
|---|---|---|---|---|
| Max Levchin | CEO | 2026-01-01 | https://affirm.com/about/leadership-news | 2026-11-22T10:00:00Z |

### News after the canary (1)

| Headline | Published (from the page) | Source | Retrieved |
|---|---|---|---|
| Company update | 2026-10-01T00:00:00Z | https://affirm.com/news/update | 2026-11-22T10:00:00Z |

### Database actions for this company (9)

| Table | Inserts | Updates |
|---|---|---|
| company_profile_facts | 5 | 1 |
| company_profile_leadership | 0 | 1 |
| company_profile_news | 1 | 0 |
| company_profile_refresh_state | 0 | 1 |

## Fresh Co

- Company UUID: `22222222-2222-4222-8222-222222222222`
- Canonical domain: fresh.example
- Enabled ATS boards: greenhouse:fresh (`66666666-6666-4666-8666-666666666662`)
- Freshness before: fresh
- Outcome: **cache_hit**. Skipped: the stored profile is fresh, so nothing was fetched and nothing will be written.
- Current rows: 1 facts, 0 leaders, 0 news, 1 refresh state

### Sources fetched (0)

None.

### Facts after the canary (0)

Not extracted (see outcome).

### Leadership after the canary (0)

Not extracted (see outcome).

### News after the canary (0)

Not extracted (see outcome).

### Database actions for this company (0)

None.

## Quiet Co

- Company UUID: `33333333-3333-4333-8333-333333333333`
- Canonical domain: quiet.example
- Enabled ATS boards: none
- Freshness before: stale (refresh due)
- Outcome: **no_ats_evidence**. Skipped: no enabled ATS board, so nothing was fetched and nothing will be written.
- Current rows: 0 facts, 0 leaders, 0 news, 0 refresh state

### Sources fetched (0)

None.

### Facts after the canary (0)

Not extracted (see outcome).

### Leadership after the canary (0)

Not extracted (see outcome).

### News after the canary (0)

Not extracted (see outcome).

### Database actions for this company (0)

None.
