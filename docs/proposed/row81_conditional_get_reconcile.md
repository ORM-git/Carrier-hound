# Row 81: conditional GET, reconcile note against open engine work

Note only. No code. Read from `main` @ `71339758` and live PR state, 27 Nov 2026.
Labels: **from source** = read in repo or PR diff; **unverified** = not checked.

## Open lanes it would touch

| PR | State (live, 27 Nov) | Files | Overlap with a conditional-GET change |
|---|---|---|---|
| #749 ingest pgrst102 diagnostics | open, head `d7a7a337`, last updated 25 Nov | `scripts/scraper/engine.py` (insert batching), `persistence.py`, `test_insert_key_sets.py` | **Low.** It changes the *write* path. Conditional GET is on the *fetch* path. Both edit `engine.py`, so whichever lands second rebases. |
| #698 company-logo contract | open **draft**, head `eccce671`, last updated 23 Nov | `engine.py`, `enrichment.py`, `run_ingestion.py`, `test_engine.py` + many non-scraper files | **Medium for files, none for logic.** Logo lane: do not touch. It also edits `run_ingestion.py`, where a per-run validator cache would be loaded and saved. |
| #842 (Agent A, rows 17/21) | open, head `17ae2f94` | `scripts/scraper/fetchers.py`, `engine.py`, … | **High for files.** Every fetcher that would send validators lives in `fetchers.py`, which is paused until #842 merges. |

## Technical facts that shape the design (from source)

- Every Python fetch goes through `request_with_backoff` (`scripts/scraper/rate_limiter.py:110`). It forwards `**kwargs`,
  so request headers (`If-None-Match`, `If-Modified-Since`) can be passed without changing its signature.
- **A 304 currently fails the board.** `request_with_backoff` calls `response.raise_for_status()`. With httpx 0.28.1
  (installed), `raise_for_status()` raises on a 304; checked locally with a constructed `httpx.Response(304)`. That
  becomes a `RequestHTTPError`. So 304 must be handled before `raise_for_status` *and* the caller must treat it as
  "unchanged board", not as an empty board.
- **An "unchanged" board must not expire jobs.** Expiry and complete-board evidence (rows 78/80) assume a full listing.
  A 304 carries no listing, so the run must reuse the previous complete snapshot's identities for expiry, or skip expiry
  for that board. The second is simpler and safer.
- **Storage is undecided.** Validators (ETag / Last-Modified per board URL) need to live somewhere between runs. Options:
  a table (NOT APPLIED proposal), or a run artifact in the ingest workflow. This is the owner's storage decision from the
  brief; it is still open.
- **unverified**: which providers return ETag / Last-Modified on their listing endpoints. Check provider docs; do not
  probe live endpoints for this.

## Proposed order once unblocked

1. #842 merges (frees `fetchers.py`), and the owner picks storage.
2. One PR: 304 handling in `request_with_backoff` + "unchanged board" result type + expiry skip for unchanged boards,
   with tests that a 304 never marks jobs expired.
3. Validators sent only for providers whose docs confirm support.
4. Rebase against #749 if it is still open. Leave #698's files to the logo lane.

**Blocked on:** #842 merge (file lane) and the owner's storage decision.
