# PostgreSQL TIMESTAMPTZ Storage Discipline (Database Sheet: Timezone Handling)

This document establishes and documents the database storage standards for temporal columns in CareerMonke PostgreSQL schema (`supabase/migrations/`). Guarded offline by `scripts/test-timestamptz-storage.ts`.

---

## 1. Core Engineering Principle: Strict TIMESTAMPTZ Storage

In PostgreSQL, there are two primary timestamp types:
1. `TIMESTAMP WITHOUT TIME ZONE` (or bare `TIMESTAMP`):
   - Stores local date and time without any offset or timezone indicator.
   - Vulnerable to daylight saving jumps, server timezone reconfigurations, and silent multi-hour clock skew when queried across client boundaries.
2. `TIMESTAMP WITH TIME ZONE` (`TIMESTAMPTZ`):
   - **Always stores an absolute UTC epoch internally** (8 bytes).
   - Converts input timestamps from any timezone offset directly to UTC upon storage.
   - Converts UTC timestamp to the client session timezone upon output.
   - Supports immutable, unambiguous temporal comparisons (`<`, `>`, `BETWEEN`, `date_trunc`).

**Architectural Rule**: Every column representing a point in time (creation, updates, expirations, scheduled runs, events, syncs) across the CareerMonke database **MUST** use `TIMESTAMPTZ`. Bare `TIMESTAMP` or `TIMESTAMP WITHOUT TIME ZONE` is strictly prohibited.

---

## 2. Migration Audit Results

A full static audit of all 70 migrations in `supabase/migrations/` was executed:
- **Total Temporal Columns Analyzed**: 98 columns across all public tables and functions.
- **Bare `TIMESTAMP [WITHOUT TIME ZONE]` Columns**: **0** (100% compliance).
- **`TIMESTAMPTZ` Columns**: **98** (100% compliance).
- **Default Timestamp Functions**: Exclusively `now()` or `clock_timestamp()`. No non-UTC wall-clock functions or hardcoded offsets.

---

## 3. Production Read-Only Inspection Query

Run this query in Supabase SQL Editor to audit all temporal columns in live production:

```sql
-- Audit query: Detect any bare timestamp (without time zone) columns in public schema
-- Expected result: 0 rows returned.
SELECT
    table_schema,
    table_name,
    column_name,
    data_type,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type = 'timestamp without time zone'
ORDER BY table_name, column_name;
```

If any row is returned, it must be altered to `TIMESTAMPTZ`:
```sql
-- Remediation template (if needed):
-- ALTER TABLE public.<table_name> ALTER COLUMN <col> TYPE TIMESTAMPTZ USING <col> AT TIME ZONE 'UTC';
```

---

## 4. Continuous Offline Guard

The companion test script `scripts/test-forensics/test-timestamptz-storage.ts` runs on every CI run and PR. It scans all SQL migration files in `supabase/migrations/` to prevent any developer or migration from introducing a bare `TIMESTAMP` column into the codebase.
