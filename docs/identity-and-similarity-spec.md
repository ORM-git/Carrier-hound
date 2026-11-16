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
   <provider_job_id>#<location_key>
   ```
   - Examples: `REQ-1001`, `54321`, `REQ-1001#tokyo`, `REQ-1001#san_francisco`.

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
1. **Unicode NFC Normalization**:
   - Python: `unicodedata.normalize('NFC', text)`
   - TypeScript: `text.normalize('NFC')`
   - PostgreSQL: `normalize(text, NFC)`
2. **Case Folding**:
   - Converted to lowercase using standard Unicode case folding.
3. **Legal Entity Suffix Stripping (Company only)**:
   - Suffixes removed at word boundaries:
     `\b(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\b\.?`
4. **Whitespace Normalization**:
   - All consecutive whitespace characters `[\s\t\r\n]+` collapsed to a single ASCII space `' '`.
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
A language-neutral JSON fixture file containing all 11 test scenarios and expected hashes is located at:
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
