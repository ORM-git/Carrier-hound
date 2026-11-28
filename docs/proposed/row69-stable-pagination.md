# Row 69: stable job-feed pagination (engine checkpoint)

Status: **checkpoint 1 of 2**. The engine, contracts and deterministic tests are in new files only. No route, service or
client file is edited; those are owned by the lean-payload change until it lands. The row is **not complete**:
integration and live verification are still to come.

Base: main `de1db3cf`.

## Current behavior (evidence)

**Recommended** (`src/app/api/jobs/recommended/route.ts`). Every request re-ranks the current pool, then slices by page number:
- takes the latest `RECOMMENDED_POOL_SIZE = 1000` relevant rows (`:29`, `:468-471`);
- re-ranks them at `scoredAt = Date.now()` (`:487-491`);
- applies `capJobsPerCompany(…, 3, 30)` (`:499`);
- slices `(page - 1) * pageSize` (`:459-460`, `:501`).

So a new arrival, a rank change, or one capped job dropping out between page N and N+1 shifts the whole list. Jobs then repeat or are skipped. Reproduced in `feedSession.test.ts` under "old pagination bugs".

**Search** (`src/app/api/jobs/search/route.ts`):
- `sort=match` orders by `verified DESC` (Postgres default NULLS FIRST), `posted_at DESC NULLS LAST`, `id DESC` (`:609-612`).
- The cursor holds only `(posted_at, id)` (`src/lib/pagination/cursor.ts`), and the filter compares only those (`:603-605`). So the page after the last verified job skips unverified jobs newer than it. Reproduced against real Postgres in `searchKeyset.test.ts`.
- There's also an offset fallback (`:613-618`) and a multi-word branch capped at 200 rows with no cursor (`:598-599`).

## Contract

### Recommended feed: stateless browsing session (`src/lib/pagination/feedSession.ts`)

**Page 1 (`openFeedSession`):**
- The route ranks, filters and company-caps exactly as today, then fixes that ordered list (at most 1000 unique UUIDs) as the session.
- It returns page 1 rows plus `continuation: string[]`, where `continuation[i]` serves page `i + 2`.

**Each continuation token:**
- holds exactly that page's ids in order (16 bytes each), the issue time, the page index, the page count and the page size;
- carries an HMAC-SHA256 over those fields and over the request **binding**;
- contains no user data, filters or binding values: those are only included in the MAC.

**The binding** is built by the route from:
- user id (or `guest`) and tier (guest/free/pro);
- every effective filter, normalized (query, location, country set, work model, type, experience, salary, saved feed constraints, excluded skills/companies);
- sort;
- candidate/preferences/scoring revision (answers + resume profile + scorer version);
- page size.

**Page k (`readFeedPage` + `orderSurvivors`):**
- Verify the token, then load **only** its ids, with every current eligibility filter (active, visible source, user exclusions, query filters).
- Return the survivors in snapshot order.
- Nothing outside the page's ids is returned. Nothing new enters, and no other member moves.

**Display scores** on later pages use the session's `issuedAt` as `scoredAt`, so they match page 1.

**Rejections** never fall back to offsets. The client starts a new session (page 1) on any of these:
- `malformed`, `oversized`;
- `invalid`: forged, or issued for another binding or secret. These deliberately can't be told apart;
- `expired`: older than 30 minutes, or more than 60 s in the future;
- `page_size_mismatch`, `out_of_range`.

**Cross-worker:** there's no server state, so any worker serves any page. Retries and concurrent reads of one token return the same page.

**Capacity:**
- At most 1000 members, page size 1–100, a token of at most 2,360 characters.
- Measured: 599 characters per page at page size 25. A full 1000-member session is 39 tokens, about 23.5 KB of JSON, sent once with page 1.

### Search: full-sort-key keyset (`src/lib/pagination/searchKeyset.ts`)

**One total order per sort, every key NULLS LAST:**
- `newest`: `posted_at`, `id`.
- `match`: `verified` (true > false > null), `posted_at`, `id`.

**Paging:**
- The cursor carries every key plus the session arrival time. It's signed and bound the same way (separate MAC domain).
- `afterCursorFilter()` builds the exact PostgREST `.or()` filter for the rows after the cursor.
- Every page is also bounded to `first_seen_at <= arrivalAt`. `first_seen_at` is insert-only in this repo's writers: no TS, Python or migration writer updates it.

**Guarantee:** for rows whose sort keys don't change during the session, pages concatenate to exactly the rows that existed at the arrival time and still match, in order, with no repeat or skip. Search results are unbounded, so their membership is not snapshotted. A row whose `verified` or `posted_at` changes mid-session can cross the cursor: one skip, or one repeat that the client's `appendPage` hides.

## Tests (deterministic, offline)

**`src/lib/pagination/__tests__/feedSession.test.ts`, 16 tests:**
- Old-bug negative controls: an insert repeats a job; a rank change skips one; a deactivated capped job shifts later pages.
- Exact ordered surviving membership across inserts, rank changes of unserved and already-shown members, ties, null dates and inactivation.
- Company caps stay fixed.
- An empty page in mid-session, a short final page, empty and single-page sessions.
- Retry and concurrency.
- Binding changes for each of user, tier, filters, sort, revision and page size.
- Tampering with ids, page, issue time or MAC; expiry and future dates; malformed and oversized input; secret fail-closed; caller-bug guards.
- Token bounds, no binding values in tokens, and canonical binding.

**`src/lib/pagination/__tests__/searchKeyset.test.ts`, 12 tests, real Postgres (PGlite):**
- Both sorts at page sizes 1, 7 and 60 concatenate to the full ordered result.
- A page crossing from `true` directly into `null` (empty middle tier).
- The JS comparator agrees with Postgres.
- Inserts after arrival stay out; deactivated rows drop; the rest stays complete.
- Old-cursor negative control (it skips jobs).
- Token round-trip and rejection cases.

**Engine negative controls** (source edited temporarily, then restored byte-identical, hash checked):

| Break | Result |
|---|---|
| Binding not MACed | 1 failure |
| Survivors in query order | 4 failures |
| No expiry check | 1 failure |
| Null tier dropped after a `true` cursor | 1 failure |
| Null `posted_at` dropped | 6 failures |
| `id` tie-break dropped | 6 failures |

## Blockers (owner decisions before integration)

1. **Signing secret: name decided, value still to set.** The owner chose `FEED_SESSION_SECRET`. This PR adds it to `.env.example`, adds a row in `docs/security/secrets-rotation-runbook.md`, and adds `FEED_SESSION_SECRET_ENV` in `feedSession.ts`. The value is not set anywhere yet: the owner sets a random 32+ character value, the same in Cloudflare Pages and Netlify, before the integration deploys. Background: The only existing HMAC key, `COMPANY_GROUP_ID_SECRET`, must not be reused (`docs/security/secrets-rotation-runbook.md:16`). Creating one is an environment change that I may not make.
   - Proposal: `FEED_SESSION_SECRET`, at least 32 random characters, the same value in Cloudflare Pages and Netlify, plus a runbook row.
   - Without it the engine fails closed, so integrating before it exists would break page 2+.
2. **Page-1 payload: decided, keep the full 1000-member session.** The owner accepted about 23.5 KB of continuation tokens on the page-1 response (measured: 39 tokens of 599 characters at page size 25). No session cap below the pool size and no "refresh for more" boundary. Later pages carry no extra tokens. The rejected alternatives were a 250-member cap (about 5.4 KB) or a server store (needs SQL or Redis).
3. **Shared files.** `recommended/route.ts`, `search/route.ts`, `service.ts` and `jobs/page.tsx` are owned by the lean-payload change. Integration waits for it to land, then rebases.
4. **Search order change: approved by the owner.** For `sort=match`, integration sets `verified` DESC NULLS LAST, so the order is true > false > null. Today Postgres's DESC default (NULLS FIRST) puts null-verified rows above verified ones. The multi-word branch (currently capped at 200 rows, no cursor) and the legacy offset fallback move onto the same keyset path, with no offset fallback left.

## Integration plan (after the blockers clear)

**Recommended route:**
- Page 1 builds the binding and calls `openFeedSession` on `cappedJobs` ids, returning `continuation`.
- Page k calls `readFeedPage`. On `ok`, it queries `id IN ids` with the existing eligibility filters and hydration, then `orderSurvivors`. On reject it returns 409 `{ restart: true }`; there is no offset fallback.
- Masking, company-group IDs and Pro hydration stay as they are.

**Search route:**
- Use `searchOrder`, `afterCursorFilter` and the `first_seen_at` bound.
- Encode the cursor from the last eligible row's full key.
- Remove the `(posted_at, id)` cursor and the offset fallback.

**Client (`jobs/page.tsx`):**
- Keep `continuation` with the list state for the current query: memory plus `history.state`, so Back/Forward restores it with no refetch.
- Use `continuation[k-2]` as the cursor for page k.
- A 409 restart resets the chain the way a query change already does.
- `appendPage`, `isStalledCursor` and the look-ahead stay unchanged.

**Tests:**
- Route tests for page 1 / page k / restart, masking parity, Pro hydration and filters.
- Rerun `jobsPaginationIntegration.test.tsx`.
- Then live verification after review and release.
