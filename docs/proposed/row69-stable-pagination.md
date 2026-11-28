# Row 69: stable job-feed pagination (engine checkpoint, for review)

Status: **engine and tests only, in new files.** No route, service, client or environment file is changed, and no secret exists.
Integration waits for the lean-payload change, which owns `recommended/route.ts`, `search/route.ts`, `service.ts` and `jobs/page.tsx`. **Row 69 is not complete.**

**Correction to the earlier record:**
- Commits `63a358e5`, `e17b9c6b`, `a9cd32b2` and the PR #892 comments called the dedicated secret, the 1000-job trade-off and the search ordering change "chosen" or "approved".
- They are not: the owner has stated that the forwarded report does not establish approval of any of them. All three are listed below as **open decisions**.
- The `.env.example` entry and runbook row that `63a358e5` added are removed again.

## Current behavior (evidence)

**Recommended** (`src/app/api/jobs/recommended/route.ts`). Every request re-ranks the current pool, then slices by page number:
- latest `RECOMMENDED_POOL_SIZE = 1000` relevant rows (`:29`, `:468-471`);
- re-ranked at `scoredAt = Date.now()` (`:487-491`);
- `capJobsPerCompany(…, 3, 30)` (`:499`);
- sliced at `(page - 1) * pageSize` (`:459-460`, `:501`).

An arrival, a rank change or a capped job dropping out between pages repeats or skips jobs (`feedSession.test.ts`, "old pagination bugs").

**Search** (`src/app/api/jobs/search/route.ts`):
- `sort=match` orders `verified DESC` (Postgres default NULLS FIRST), `posted_at DESC NULLS LAST`, `id DESC` (`:609-612`).
- The cursor holds only `(posted_at, id)` (`:603-605`, `cursor.ts`).
- There's an offset fallback (`:613-618`) and a multi-word branch capped at 200 rows with no cursor (`:598-599`).
- On test data with no changes at all, that cursor skips 26 of 54 jobs (`searchSession.test.ts`).

**Why a keyset can't be fixed into stability:** `verified` and `posted_at` change in place. Tested with the earlier version of this PR (full-sort-key keyset plus an arrival-time fence) under the same verified and date changes between pages: 1 job skipped, 5 repeated. Only a fixed membership survives key changes.

## Contract: one browsing session for both surfaces (`src/lib/pagination/feedSession.ts`)

**Page 1:**
- The route builds the final ordered list exactly as the listing orders it, at most `MAX_MEMBERS` = 1000 ids:
  - Recommended: ranked and company-capped.
  - Search: `ORDER BY searchOrder(sort) LIMIT N + 1` over every search filter and eligibility check (`searchSession.ts`). PostgreSQL does this ordering at its own microsecond precision. The JS reference comparator (`compareSortKeys`/`timestampKey`) matches it to the microsecond and refuses timestamps with more than 6 fractional digits.
- It calls `openFeedSession`. If the listing had more rows than the cap, the session is **capped** and every continuation says so.

**Page k:**
- `readFeedPage` verifies the continuation, then the route loads **only that page's ids**, with every current eligibility filter, query filter and masking rule.
- `orderSurvivors` returns them in snapshot order.

**Guarantee:**
- Across pages the reader sees the session's members in the fixed order, minus those that stopped being eligible or matching. No repeats, no skips.
- Nothing new enters, whatever happens meanwhile to scores, `verified`, `posted_at`, ties, nulls or company caps.
- New arrivals appear in a new session (refresh or new query).
- Inactive, hidden, deleted or no-longer-matching jobs never come back from a snapshot. Every page re-checks eligibility.

**Binding:** each continuation is MACed together with the request binding:
- surface (recommended/search), user id or `guest`, and tier (guest/free/pro);
- every effective filter, normalized;
- sort;
- candidate/preferences/scoring revision;
- page size.

A different binding, secret or any tampered field is rejected as `invalid`. Expiry, page size and range are checked after the MAC. Rejections never fall back to offsets.

**Masking and eligibility:** page k runs the same eligibility query and masking/Pro-hydration code as page 1, restricted to its ids. The engine returns ids only and never decides what a tier may see.

**Scores are not frozen; only membership and order are.**
- A continuation freezes which jobs are in the session and in what order. It does **not** freeze the score each card shows.
- Page k computes each displayed `matchScore` and its `scoreRevision` from the job row **as it is when page k is served**, at `scoredAt` = the session's `issuedAt`. So a member whose fields changed since page 1 (title, salary, location, dates) can show a different score than the one it was ranked by, and scores down the list need not be monotonic.
- What stays consistent: each row's score and `scoreRevision` are computed together from the same row (`scoreInputRevision`, `src/lib/matcher/scoring.ts:723`). The existing `withFeedScore` (`src/lib/jobs/recommendations.ts:517`) adopts a feed score on the card or detail only when the revisions match.
- Freezing displayed scores (carrying them in the session) is **not implemented and not tested**. It would also put scores (paid display inputs for Pro) into tokens, which needs its own review.

### Privacy and transport

A continuation is **private-derived data**: it reveals which jobs, in which order, were personalized for one reader. Tokens are **encoded, not encrypted**: anyone holding one can decode its job ids.
- **Transport:** request body (POST) or a request header only, **never a URL**. Query strings reach access logs, analytics and the `Referer` header.
- **Responses** that carry continuations: `Cache-Control: no-store`.
- **Logs and metrics:** never the raw token. `tokenFingerprint()` gives a 12-hex-character SHA-256 prefix to refer to one. No analytics event may include a token.
- **Client storage:** in memory and in `history.state` for Back/Forward. Both are same-origin and never sent anywhere.
- **No user data in tokens:** the binding (user id, filters, tier) is MACed, never encoded. A test checks that a binding containing an email doesn't appear in any token.

### Sizes (measured with real tokens)

| Session | Continuations | One token (per page-k request) | All continuations on page 1 (JSON) |
|---|---|---|---|
| 1000 members, page size 25 | 39 | 601 chars | 23,588 bytes |
| 1000 members, page size 100 | 9 | 2,202 chars | 19,847 bytes |
| 500 members, page size 25 | 19 | 601 chars | 11,488 bytes |
| 250 members, page size 25 | 9 | 601 chars | 5,438 bytes |
| 100 members, page size 25 | 3 | 600 chars | 1,810 bytes |

The hard limit is 2,360 characters per token. Ids are random, so these sizes barely compress. Page-k responses add no tokens.

### Expiry and reset

- **TTL** is 30 minutes from page 1, with 60 s of clock-skew tolerance for future-dated issue times.
- **Retries** and concurrent reads of one continuation return the same page. There's no server state, so any worker can serve it.
- **Proposed reset behavior**, for review:
  - On any rejection (expired, invalid, page-size mismatch) the route answers 409 `{ restart: true }`.
  - The client then **replaces** the list with page 1 of a new session, keeping the current filters, and puts scroll back at the top, the way a query change does today. It never appends a new session to an old one.
  - Back/Forward within the TTL restores rows and continuations from `history.state` without refetching. After the TTL, restored rows stay visible, and the next page request triggers the restart.
- **Capped sessions:** the last page reports `capped`. Below the last row the client shows an explicit end, for example "Showing the first 1,000 results, refine your search". Nothing loads silently past the cap.

## Tests (deterministic, offline)

**`src/lib/pagination/__tests__/feedSession.test.ts`, 18 tests:**
- Old-bug negative controls: an insert repeats a job; a rank change skips one; a capped company's job dropping out shifts later pages.
- Exact ordered surviving membership across inserts, rank changes (unserved and already shown), ties, null dates and inactivation.
- Company caps stay fixed.
- An empty page mid-session, a short final page, empty and single-page sessions.
- Retry and concurrency.
- Rejection for a change in each binding field; tampering with ids, page, issue time, cap flag or MAC; expiry and future dates; junk and oversized input.
- The secret fails closed; caller-bug guards.
- The cap flag; token bounds and no binding values in tokens; the fingerprint.

**`src/lib/pagination/__tests__/searchSession.test.ts`, 10 tests, real Postgres (PGlite); keys read back with microseconds (`.US`), never truncated:**
- For both sorts, between every page:
  - one unserved member's `verified` flips;
  - another's `posted_at` jumps to newest;
  - a third's `verified` and `posted_at` both become NULL;
  - an already-shown member is demoted;
  - a verified newest job is inserted;
  - an unserved member goes inactive, and on one page another stops matching the query.
- Pages still equal exactly the snapshot order minus the dropped jobs, with no arrivals.
- A capped session holds exactly the first N.
- The comparator matches Postgres `ORDER BY`, including rows that differ only below the millisecond and an equal instant written with a `+05:30` offset.
- A `Date.parse` (millisecond) comparator disagrees with Postgres on those rows (negative control). Restoring `Date.parse` in the source fails 2 tests.
- `timestampKey` treats every ISO offset form as the same instant and refuses 7+ fractional digits.
- Search tokens don't open on another surface, query or sort.
- Negative controls: main's cursor (26 of 54 skipped); the earlier keyset-plus-fence design (1 skipped, 5 repeated).

**Engine negative controls** (source edited temporarily, restored byte-identical, hash checked):

| Break | Result |
|---|---|
| Binding not MACed | 2 failures |
| Survivors returned in query order | 7 failures |
| Cap flag left out of the MAC | 3 failures |

## Open decisions (for owner review; none is approved)

1. **Signing key.** A server-only HMAC key of at least 32 characters is required for the "reject forged" requirement.
   - Options:
     - (a) a new dedicated secret. `FEED_SESSION_SECRET` is the proposed name; it's an environment change.
     - (b) reuse an existing one. `COMPANY_GROUP_ID_SECRET` is forbidden by `docs/security/secrets-rotation-runbook.md:16`.
     - (c) no MAC. Forgery could then not be detected, only made harmless by re-checking eligibility. That fails the stated requirement.
   - The engine fails closed without a key.
2. **Membership cap and page-1 size.** Per surface: 1000 (about 23.6 KB on page 1), 500 (about 11.5 KB), 250 (about 5.4 KB), or a server-side store (needs SQL or Redis, not available here). This trades against the lean-payload goal.
3. **Search ordering.** Keep today's verified NULLS FIRST, or switch to true > false > null (`searchOrder`). The engine works with either, as long as page 1 and the comparator agree.
4. **Search beyond the cap.** Today search scrolls indefinitely. With a fixed membership, rows past the cap can't be reached in one session. Options: an explicit end with "refine/refresh", or a larger search cap.
5. **Transport for page k.** POST body versus a request header. Either keeps tokens out of URLs. It must be honored by the Pages routes and the Netlify functions alike.
6. **Reset UX** as proposed above: replace the list and return to the top on restart.
7. **Recommended on Netlify.** Add a Netlify function for `/api/jobs/recommended`, or leave it unserved there (as today).

## Infrastructure actually needed

- **One server-only HMAC key** (decision 1), in Cloudflare Pages and Netlify. Nothing else: no table, no Redis, no KV, no process-local state.
- **Database load:**
  - Page k: one `id IN (≤ page size)` query using the primary key, plus today's hydration.
  - Search page 1: one membership query of `LIMIT cap + 1` that selects keys only, where today's query is `LIMIT pageSize + 1`. Its cost on production indexes is **not measured** and has to be checked during integration.

## Serving paths (from repo config; not verified live)

The two hosts build differently (`next.config.mjs:34`, `docs/dns-cutover-runbook.md`). Which host serves `careermonke.com` is an owner fact that isn't recorded in the repo.

| Path | Cloudflare Pages (edge server build) | Netlify (static export + functions) |
|---|---|---|
| `/api/jobs/recommended` | `src/app/api/jobs/recommended/route.ts` | **No handler.** No `netlify.toml` redirect and no function; a static export has no API routes. `service.ts:562-564` turns the failure into a retryable degraded result. |
| `/api/jobs/search` | `src/app/api/jobs/search/route.ts` | `netlify.toml:57-61` redirects to `netlify/functions/jobs-search.ts`. That's a separate 1,003-line handler with its own `(posted_at, id)` cursor (`:440`) and offset fallback (`:628`). |
| Browser direct path | `src/lib/jobs/service.ts:487-488`: when the browser has a candidate profile and no server filter, `getLiveJobs` skips the API, queries Supabase directly, ranks a 1000-row pool and slices `from..to` (`:880-898`). | Same code, on both hosts. |

Consequences for integration:
- **Every path has to change.** Fixing only the Next.js routes leaves Netlify search on the old cursor, and leaves the browser direct path re-ranking and slicing.
- **The browser can't sign continuations** (it can't hold the key). The direct path has to go behind a server handler on both hosts.
- **Setting an environment variable alone wires up nothing.** The key has to be read in each handler:
  - Pages: `getRuntimeEnv(..., cfEnv)`, as `COMPANY_GROUP_ID_SECRET` is read in `recommended/route.ts`.
  - Netlify functions: `process.env`.
  Each handler must fail closed when the key is missing.
- **Recommended on Netlify** needs an owner decision: add a function, or accept that it doesn't exist there (as today).

## Integration (after the decisions and the lean-payload change)

- **Recommended:** page 1 opens the session on `cappedJobs` ids. Page k reads it, queries `id IN ids` with the existing eligibility filters and hydration, then calls `orderSurvivors`, with display scores computed at the session's `issuedAt`.
- **Search, in both handlers** (`src/app/api/jobs/search/route.ts` and `netlify/functions/jobs-search.ts`, kept equivalent): page 1 runs the membership query and opens the session, and page k is the same as recommended. The `(posted_at, id)` cursor, the offset fallback and the uncursored multi-word branch go away from both.
- **Browser direct path** (`service.ts` `getLiveJobs`): candidate-ranked pages go through a server handler that opens and serves sessions, instead of slicing in the browser.
- **Recommended on Netlify:** per the owner decision above.
- **Client:** continuations live in memory and `history.state`, page k sends `continuation[k-2]` in the body or header, and a 409 triggers the reset. `appendPage`, `isStalledCursor` and the look-ahead stay.
- **Then:** route tests for both search handlers (behavior parity) and the recommended route, `jobsPaginationIntegration.test.tsx`, and live verification on whichever host serves production, after review and release.
