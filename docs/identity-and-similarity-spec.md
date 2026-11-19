# Job Ingestion Identity & Advisory Similarity Specification (v2)

**Status**: Active / Authoritative  
**Target Subsystems**: PostgreSQL Schema & Functions, Scraper Engine (`scripts/scraper`), Next.js / TypeScript App (`src/lib/jobs`)  
**Shared By**: Agent A (Database & Contract Owner), Agent B (Ingestion Engine & Worker Owner)

---

## 1. Incident Context & Architectural Separation

### Production Incident Root Cause
In migration `20261116a_high_volume_ingestion_schema.sql`, deduplication was attempted using an aggressive ASCII-only regex `[^a-z0-9]+` and an unconditional trigger (`trg_jobs_merge_dedupe_priority`) enforcing uniqueness on `idx_jobs_active_dedupe_hash_uniq`:
1. Non-ASCII titles (e.g., Japanese roles like `プロダクトマネージャー` and `バックエンドエンジニア`) stripped down to empty strings `""`, and non-ASCII cities (e.g. `東京都`) collapsed to `any`.
2. Unrelated jobs for the same employer collapsed into identical hashes (e.g. `paypay||any|any`), erroneously expiring 489 active rows.
3. The existing `jobs_touch_last_seen` trigger unconditionally set `last_seen_at = now()` on every `UPDATE`, altering ranking order during backfill and reversing dry-run winners.
4. Delimiter collisions occurred when titles or companies contained pipes (`|`), colons (`:`), or slashes (`/`).

### Core Architectural Principle
**Exact Authoritative Write Identity is strictly separated from Advisory Similarity:**
- **Authoritative Identity (`source_id` + `source_job_id`)**: Unique, stable, board-scoped, and provider-verified. This governs all database `INSERT` / `UPDATE` operations and guarantees no two distinct jobs overwrite each other.
- **Similarity Fingerprint (`similarity_hash_v2`)**: Strictly advisory. It identifies cross-source duplicates and clusters across boards/aggregators. It **never** has a unique constraint, **never** triggers row expiration or deletion, and **never** replaces an authoritative row.

---

## 2. Authoritative Write Identity

### Components
Every ingested job must have a deterministic and scoped write identity:
1. **`source_id`** (Text): The canonical board or source namespace in the format:
   ```
   <vendor>:<board_token>
   ```
   - Examples: `greenhouse:stripe`, `lever:netflix`, `ashby:airtable`, `workday:walmart`, `jobspy:linkedin`, `arbeitnow:arbeitnow`.
2. **`source_job_id`** (Text): The provider requisition or posting ID:
   ```
   <provider_job_id>
   ```
   Or for multi-location requisitions published under a single job ID:
   ```
   <escaped_provider_job_id>#<loc_len>:<clean_location_key>
   ```
   - Examples: `REQ-1001`, `54321`, `REQ-1001#6:東京`, `REQ-1001#6:大阪`, `REQ%236` (when provider job ID contains `#`).
   - Unicode-safe, injective, length-framed: Non-ASCII characters (e.g. Japanese `東京`, `大阪`, Hungarian `óbuda`) are preserved without lossy slug conversion. `#` and `%` inside provider IDs are escaped (`%23` and `%25`), guaranteeing zero aliasing.

### Database Enforcement
Enforced via a partial unique index in PostgreSQL:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_id_source_job_id_uniq
ON public.jobs (source_id, source_job_id)
WHERE source_id IS NOT NULL AND source_job_id IS NOT NULL;
```

### Missing / Ambiguous Source Keys Policy
- If `source_id` or `source_job_id` is missing, `NULL`, or empty, the scraper/worker **MUST NOT** guess, fabricate synthetic hashes, or coalesce into an existing job.
- The record must be rejected/quarantined with status `REJECTED_MISSING_SOURCE_KEY`.

---

## 3. Versioned Advisory Similarity Contract (`v2`)

The `v2` similarity hash is computed byte-for-byte identically across PostgreSQL, Python, and TypeScript.

### Normalization Pipeline
Given `company`, `title`, `country`, and `location`:
1. **Unicode NFKC Normalization & Case Folding** (fullwidth forms and ligatures fold to plain letters; non-Latin scripts and emoji are preserved, never stripped):
   - Python: `unicodedata.normalize('NFKC', text).lower()`
   - TypeScript: `text.normalize('NFKC').toLowerCase()`
   - PostgreSQL: `lower(COALESCE(normalize(text, NFKC), ''))`
2. **Deterministic Parity Normalization**:
   - Sharp s `ß` (U+00DF) -> `ss` (case folding, applied identically in all three)
   - Turkish dotted capital `İ` (U+0130) and combining dot `i\u0307` -> ASCII `i` (U+0069)
   - Greek final sigma `ς` (U+03C2) -> small sigma `σ` (U+03C3) matching canonical Unicode case folding
   - Next Line `U+0085` (chr(133)) -> space `' '`
3. **Legal Entity Suffix Stripping (Company only)**:
   - Suffixes removed only at true Unicode-aware boundaries:
     - TypeScript: `(?<![\p{L}\p{N}_])(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\.?(?![\p{L}\p{N}_])/gui`
     - Python: `(?<![^\W_])(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\.?(?![^\W_])`
     - PostgreSQL: `\y(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\y\.?`
     - This guarantees that suffixes directly attached to non-Latin scripts (e.g. `Company Inc東京`) are preserved identically across all runtimes without stripping.
4. **Whitespace Normalization**:
   - Explicit character set matching across all three runtimes:
     `[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+`
   - Explicitly preserves byte values like `\uFEFF` (zero-width no-break space / BOM) and `\x1c` (ASCII 28 / information separator four), preventing cross-runtime divergence.
   - All matching whitespace is collapsed to a single ASCII space `' '`.
   - Trim leading and trailing whitespace.
5. **Location Handling**:
   - Extract primary city/territory segment before any comma (e.g. `San Francisco, CA` -> `san francisco`, `Óbuda, Budapest` -> `óbuda`).
   - If empty or `NULL`, normalize to empty string `""`.
6. **Country Handling**:
   - Normalized to lowercase trimmed string (e.g. `US`, `JP`, `HU`).
   - If empty or `NULL`, normalize to empty string `""`.

### Length-Framed UTF-8 Serialization
To prevent delimiter collision (e.g. pipes, colons, or slashes in titles like `"Engineer | Platform : Core"`), each normalized value is prefixed by its exact UTF-8 byte length:
```
v2|c:{byte_len}:{company}|t:{byte_len}:{title}|co:{byte_len}:{country}|loc:{byte_len}:{location}
```
Where `{byte_len}` is:
- Python: `len(value.encode('utf-8'))`
- TypeScript: `Buffer.byteLength(value, 'utf8')`
- PostgreSQL: `octet_length(convert_to(value, 'UTF8'))`

### Digest
Computed via SHA-256 and represented as a 64-character lowercase hexadecimal string:
- Python: `hashlib.sha256(payload.encode('utf-8')).hexdigest()`
- TypeScript: `crypto.createHash('sha256').update(payload, 'utf8').digest('hex')`
- PostgreSQL: `encode(pg_catalog.sha256(pg_catalog.convert_to(payload, 'UTF8')), 'hex')`

### Advisory Safety Rules
1. **No Unique Index**: `similarity_hash_v2` has only a standard (non-unique) index:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_jobs_active_similarity_hash_v2
   ON public.jobs (similarity_hash_v2)
   WHERE is_active = TRUE;
   ```
2. **No Automatic Merging or Expiration**: The database contains no triggers that expire or delete rows based on similarity hash collisions.
3. **Preserved Ranking Timestamps**: Updates or backfills of `similarity_hash_v2` must never alter `last_seen_at`.

---

## 4. Helper APIs & Signatures

### Python (`scripts/scraper/enrichment.py`)
```python
def build_source_id(vendor: str, board_token: str) -> str:
    """Builds canonical source_id '<vendor>:<board_token>'."""
    ...

def build_scoped_job_identity(
    source_id: str,
    provider_job_id: str,
    location_key: str | None = None
) -> tuple[str, str]:
    """Returns (source_id, source_job_id), supporting multi-location variants."""
    ...

def compute_similarity_hash_v2(
    company: str | None,
    title: str | None,
    country: str | None = None,
    location: str | None = None
) -> str:
    """Computes deterministic SHA-256 hex digest using length-framed UTF-8 payload."""
    ...
```

### TypeScript (`src/lib/jobs/highVolumeEnrichment.ts`)
```typescript
export function buildSourceId(vendor: string, boardToken: string): string;

export function buildScopedJobIdentity(
  sourceId: string,
  providerJobId: string,
  locationKey?: string | null
): { sourceId: string; sourceJobId: string };

export function computeSimilarityHashV2(
  company?: string | null,
  title?: string | null,
  country?: string | null,
  location?: string | null
): string;
```

### PostgreSQL (`supabase/migrations/20261116d_repair_642_identity_and_similarity_safety.sql`)
```sql
CREATE OR REPLACE FUNCTION public.compute_job_similarity_hash_v2(
  p_company text,
  p_title text,
  p_country text,
  p_location text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public;
```

---

## 5. Golden Fixtures Reference
A language-neutral JSON fixture file containing all 24 test scenarios and expected hashes is located at
(checked against PostgreSQL via PGlite, TypeScript and Python; any byte difference fails CI):
`scripts/fixtures/identity_golden_cases.json`

Scenarios covered:
1. PayPay unrelated Japanese roles (Product Manager vs Backend Engineer)
2. New Relic Japanese sales territories (Tokyo vs Osaka)
3. ClickHouse support vs consulting vs TAM
4. Wolt Óbuda vs Buda (accented Ó preserved)
5. Alan territory flags (`[FR]` vs `[ES]`)
6. Bilingual / ASCII punctuation variants (`-` vs `/` vs `:`)
7. Composed vs decomposed accented text (NFC vs NFD equivalence)
8. Null and empty values
9. Delimiter characters injection safety (`|`, `:`, `/`)
10. Same posting title/location with distinct requisition IDs
11. Provider job IDs duplicated across different boards
12. Turkish dotted capital I (`İ` / U+0130)
13. Greek Omicron Sigma and Final Sigma (`ΟΣ` / `ς` -> `σ`)
14. Next Line whitespace (`NEL` / U+0085)
15. Tokyo vs Osaka location identity and provider ID hash escaping (`#` -> `%23`)
16. Company Inc with Japanese Kanji (`Company Inc東京` preserved without stripping)
17. Zero Width No-Break Space (`U+FEFF` / BOM preservation)
18. Information Separator Four (`U+001C` preservation)
19. Hindi titles at one company stay distinct (no shared empty ASCII slug)
20. Chinese and Arabic titles stay distinct
21. Emoji preserved (titles differing only by emoji stay distinct)
22. Trailing spaces, mixed case and legal suffix fold to one hash
23. NFKC: fullwidth letters, `ﬁ` ligature and `ß`/`ss` fold to one hash
24. Cyrillic and Greek uppercase/lowercase fold identically in PG, TS and Python

### Dedupe eligibility and duplicate expiry
- `dedupeKey()` returns `null` when the cleaned company or title has fewer than 2 code points
  (empty, suffix-only like `Inc.`, or a single emoji). Rows with a `null` key are never deduped.
  Used by `scripts/ingest.ts`, `scripts/utils/crossSourceDedupe.ts` and `scripts/board-ingest.ts`.
- `scripts/backfill-job-descriptions.ts` stage 1 (duplicate expiry) is a dry run unless
  `--expire-duplicates` is passed; it expires at most `--max-expire` rows per run (default 100,
  hard ceiling 1000), prints every row it would expire, and refuses when duplicates exceed 1% of
  active jobs unless `--allow-over-1pct` is passed.

---

## 6. Migration Structure & Resumable Batch Backfill
The migration is safely split into three independent phases:
1. **Phase 1: Short Additive DDL (`20261116d`)**:
   - Strict preflight verifying exact constraints (`jobs_pkey`, `companies_pkey`, `jobs_source_source_job_id_unique`), triggers (`jobs_touch_last_seen`), and dedupe integrity.
   - Non-breaking additive columns (`jobs.source_id`, `jobs.similarity_hash_v2`, `jobs.source_priority`, `companies.canonical_domain`).
   - `jobs_public` view updated via `CREATE OR REPLACE VIEW` preserving owner, grants, and column layout.
   - Preserved `last_seen_at` trigger gating: updates to metadata or priority do not alter ranking timestamps.
2. **Phase 2: Concurrent Indexes (`20261116e`)**:
   - `idx_jobs_source_id_source_job_id_uniq` and `idx_jobs_active_similarity_hash_v2` created concurrently outside transaction blocks.
3. **Phase 3: Resumable Batch Backfill (`20261116f`)**:
   - Coordinated via stored procedure `public.repair_645_run_resumable_backfill(p_batch_size integer DEFAULT 500)`.
   - Each batch executes `LIMIT p_batch_size FOR UPDATE SKIP LOCKED` and commits immediately (`COMMIT;`).
   - Progress is persisted across restarts in table `public.repair_645_backfill_progress`.
   - All three targets (`companies.canonical_domain`, `jobs.source_priority`, and `jobs.similarity_hash_v2`) are batched identically.
   - Sets `careermonke.skip_touch_last_seen = 'on'` to ensure zero timestamp corruption during backfill.
