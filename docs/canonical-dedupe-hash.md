# Canonical Job Dedupe Hash Contract & Transition Specification

**Authoritative Hash Version**: `v2`  
**Algorithm**: `SHA-256` (64 lowercase hex characters)  
**Status**: Contract Active; Cross-Runtime Verified (PostgreSQL SQL, TypeScript Ingest, Python Scraper)

---

## 1. Specification: The Canonical Dedupe Hash Contract

The canonical dedupe hash `dedupe_hash` is computed identically across all three system runtimes:
- **TypeScript**: `computeDedupeHash(company, title, country, location)` in `src/lib/jobs/highVolumeEnrichment.ts`
- **Python**: `compute_dedupe_hash(company, title, country, location)` in `scripts/scraper/enrichment.py`
- **PostgreSQL**: `public.compute_job_dedupe_hash(company, title, country, location)` (delegates to `public.compute_job_similarity_hash_v2`) in `supabase/migrations/20261121a_canonical_job_dedupe_hash.sql`

### Input Fields & Extraction
1. **`company`**: Employer name string.
2. **`title`**: Role title string.
3. **`country`**: Country name or ISO code. If null/undefined, defaults to empty string `""`.
4. **`location`**: Primary territory or city before any comma (`split(',')[0]`). If null/undefined, defaults to empty string `""`.

### Normalization Rules (in strict execution order)
1. **Unicode NFKC & Lowercase**:
   - `NFKC` normalization and case-folding applied to all fields.
   - Non-Latin scripts (Japanese Kanji/Kana, Hindi, Chinese, Cyrillic, etc.) and punctuation are preserved (never stripped).
2. **Parity Replacements**:
   - German sharp s: `ß` (`U+00DF`) -> `ss`
   - Turkish dotted uppercase: `İ` (`U+0130`) and combining dot `i\u0307` -> `i` (`U+0069`)
   - Greek final sigma: `ς` (`U+03C2`) -> small sigma `σ` (`U+03C3`)
   - Next Line control: `U+0085` (`chr(133)`) -> single space `' '`
3. **Legal Entity Suffix Stripping (`company` only)**:
   - Suffixes removed only at Unicode-aware word boundaries:
     `inc`, `llc`, `ltd`, `corp`, `corporation`, `limited`, `pvt`, `private`, `gmbh`, `plc`, `co` (with optional trailing period).
   - Attached suffixes in other scripts (e.g., `Company Inc東京`) are preserved.
4. **Whitespace Normalization**:
   - Matches regex `[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+`.
   - Collapses matches to a single ASCII space `' '`.
   - Strips leading and trailing whitespace.
5. **Length-Framed UTF-8 Serialization**:
   - Prevents delimiter collision (e.g. titles containing `|`, `:`, `/`):
     ```
     v2|c:{c_len}:{company}|t:{t_len}:{title}|co:{co_len}:{country}|loc:{loc_len}:{location}
     ```
   - Length prefixes `{len}` are UTF-8 byte lengths (octets).
6. **Hashing**:
   - Cryptographic `SHA-256` digest over UTF-8 payload, formatted as 64 lowercase hexadecimal characters.

---

## 2. Shared Test Vectors

A fixture containing 25 diverse test vectors is committed at:
- `scripts/fixtures/job_dedupe_test_vectors.json`

Coverage:
- Standard ASCII roles with corporate legal suffixes
- Empty / missing country and location fallbacks
- Non-Latin Unicode scripts: Japanese Kanji/Kana, Hindi Devanagari, Chinese Hanzi, Greek
- Special case foldings: Turkish `İ`, German `ß`, Greek `ς`
- Title punctuation distinctions (`/` vs `-` vs `:`) proving immunity against incident #642

All 25 vectors are verified byte-for-byte in:
- TypeScript: `src/lib/__tests__/highVolumeEnrichment.test.ts`
- Python: `scripts/scraper/test_identity_contract.py`
- PostgreSQL & Unified Runner: `scripts/test-canonical-dedupe-hash.ts`

---

## 3. Backward Compatibility & Backfill Plan

### Advisory Invariant
`dedupe_hash` is strictly advisory.
- Database write identity is governed exclusively by `(source_id, source_job_id)`.
- There is NO unique constraint on `dedupe_hash`.
- No automatic row-deletion triggers or destructive side effects exist.

### Transition & Backfill
1. **Migration File**: `supabase/migrations/20261121a_canonical_job_dedupe_hash.sql` (STATUS: NOT APPLIED; owner runs prod SQL).
2. **Procedure**: `public.backfill_canonical_job_dedupe_hashes(p_batch_size integer DEFAULT 500)`
   - Chunks of 500 rows with `FOR UPDATE SKIP LOCKED`.
   - Per-batch `COMMIT` to eliminate lock escalation or transactional bloat.
   - Sets `careermonke.skip_touch_last_seen = 'on'` to ensure `last_seen_at` ranking order is untouched.
   - Records progress in `public.canonical_dedupe_hash_backfill_progress`.
   - Idempotent: re-running processes 0 rows once complete.
