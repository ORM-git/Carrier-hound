# Reusable PostgreSQL DOMAIN Types

## 1. Overview & Context

A database audit of the CareerMonke repository identified that recurring data patterns—such as emails, slugs, and non-empty text strings—are stored across various tables as plain `text` columns with duplicated, ad-hoc `CHECK` constraints (or in some cases, without constraints).

Migration `supabase/migrations/20261112a_custom_domain_types.sql` introduces reusable PostgreSQL `DOMAIN` types in the `public` schema. The migration is marked **NOT APPLIED** and strictly additive: it defines domain types without altering, dropping, or rewriting any existing table, column, constraint, or data.

---

## 2. Domain Inventory & Enforced Rules

### `public.cm_email`
- **Base Type**: `text`
- **Enforced Constraints**:
  ```sql
  CHECK (
    VALUE = lower(trim(VALUE))
    AND char_length(VALUE) <= 254
    AND position('@' in VALUE) > 1
    AND VALUE ~ '^[a-z0-9_%+-]+(\.[a-z0-9_%+-]+)*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$'
  )
  ```
- **Rules Enforced**:
  - **Normalization**: Must be stored strictly lowercase and trimmed (`VALUE = lower(trim(VALUE))`), matching application-level normalization (`normalizeEmail` in `src/lib/admin/earlyAccess.ts`).
  - **RFC Length Limit**: Maximum length 254 characters (RFC 5321).
  - **Format Validation (Strict POSIX Regex)**:
    - **Local Part**: `^[a-z0-9_%+-]+(\.[a-z0-9_%+-]+)*@` prevents leading dots (`.a@example.com`), trailing dots (`a.@example.com`), or consecutive dots (`a..b@example.com`).
    - **Domain Labels**: `[a-z0-9]([a-z0-9-]*[a-z0-9])?` requires every label to begin and end with an alphanumeric character. Prevents domain labels starting with a hyphen (`a@-example.com`), ending with a hyphen (`a@example-.com`), or containing empty labels / consecutive dots (`a@example..com`).
    - **Top-Level Domain**: `\.[a-z]{2,}$` enforces letters only with a minimum of 2 characters.
  - **NULL Semantics**: PostgreSQL domain `CHECK` constraints evaluate to `TRUE` for `NULL` values. If a column must not be nullable, declare `NOT NULL` on the column definition.

### `public.cm_non_empty_text`
- **Base Type**: `text`
- **Enforced Constraints**:
  ```sql
  CHECK (VALUE ~ '[^[:space:]]')
  ```
- **Rules Enforced**:
  - **Explicit Whitespace Predicate**: PostgreSQL standard `trim(string)` only strips space characters (`' '` ASCII 32). A naive `length(trim(VALUE)) > 0` check permits tab-only (`\t`) and newline-only (`\n`) strings.
  - **POSIX `[:space:]` Matching**: `VALUE ~ '[^[:space:]]'` tests for at least one non-whitespace character across all POSIX whitespace characters (spaces, horizontal tabs, newlines, carriage returns, vertical tabs, form feeds).
  - Rejects empty strings (`""`), space-only strings (`"   "`), tab-only strings (`"\t"`, `"\t\t"`), newline-only strings (`"\n"`, `"\r\n"`), and mixed whitespace-only strings.
  - Ensures required text columns (e.g. company names, job titles, department names) carry substantive content rather than blank placeholders.
  - **NULL Semantics**: Evaluates to `TRUE` for `NULL`. Table columns must declare `NOT NULL` separately.

### `public.cm_slug`
- **Base Type**: `text`
- **Enforced Constraints**:
  ```sql
  CHECK (
    VALUE = lower(trim(VALUE))
    AND length(trim(VALUE)) > 0
    AND char_length(VALUE) <= 120
    AND VALUE ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  )
  ```
- **Rules Enforced**:
  - **Normalization**: Must be trimmed and lowercase.
  - **Slug Format**: Alphanumeric characters separated by single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`).
  - **No Leading/Trailing Hyphens**: Disallows `-slug`, `slug-`, and multiple consecutive hyphens `slug--name`.
  - **Length Cap**: Bounded to 120 characters to ensure URL compatibility and index efficiency.
  - Matches the standard `slugify` logic in `scripts/utils/sanitizer.ts`.
  - **NULL Semantics**: Evaluates to `TRUE` for `NULL`. Table columns must declare `NOT NULL` separately.

---

## 3. Important PostgreSQL Domain Behaviors

### NULL Handling: Domain CHECKs Do Not Enforce NOT NULL
In SQL standard and PostgreSQL, `CHECK (expression)` evaluates to:
- `TRUE` -> validation passes.
- `FALSE` -> validation fails, error raised.
- `NULL` / `UNKNOWN` -> validation passes!

When a column value is `NULL`, expressions like `VALUE ~ '[^[:space:]]'` or `char_length(VALUE) <= 254` evaluate to `NULL`, which PostgreSQL considers valid.
Therefore, **PostgreSQL domain types do NOT enforce column presence**. Table column definitions requiring a non-null value MUST explicitly declare `NOT NULL` alongside the domain:
```sql
-- Correct usage for required fields:
CREATE TABLE public.example (
  email public.cm_email NOT NULL,
  title public.cm_non_empty_text NOT NULL
);
```

---

## 4. Why DOMAIN Types Beat Duplicated Ad-Hoc CHECKs

| Dimension | Ad-Hoc `CHECK` Constraints | Reusable PostgreSQL `DOMAIN` Types |
| :--- | :--- | :--- |
| **Maintenance (DRY)** | Validation expressions must be copied to every table (`early_access_emails`, `email_suppressions`, etc.). | Single centralized definition. Changes or extensions are defined once. |
| **Drift Risk** | High. Table A might check `char_length <= 254`, while Table B checks `position('@' in email) > 1`, and Table C has no check. | Zero. Every column referencing `cm_email` enforces identical rules. |
| **Schema Readability** | Column appears as generic `text`; requirements are buried in table constraint catalogs. | Schema introspection (`information_schema.columns`) and PostgREST immediately report the domain type. |
| **Performance Overhead** | Evaluated per row on `INSERT`/`UPDATE`. | Identical performance. PostgreSQL evaluates domain constraints at write time with zero additional storage overhead. |
| **Refactoring Safety** | Removing or updating rules requires altering multiple tables and synchronizing migrations. | Controlled, centralized type definition. |

---

## 5. Staged Adoption Plan & Zero-Downtime Migration Guidance

### Locking Truth: ALTER COLUMN TYPE Is NOT Zero-Downtime
Directly altering an existing column's type to a domain:
```sql
-- DANGER: NOT zero-downtime!
ALTER TABLE public.early_access_emails
  ALTER COLUMN email TYPE public.cm_email;
```
Takes an **`ACCESS EXCLUSIVE`** lock on the table. This lock blocks all concurrent `SELECT`, `INSERT`, `UPDATE`, and `DELETE` operations for the entire duration of a full sequential table scan while PostgreSQL validates the domain constraints against every existing row. On active or large tables (`jobs`, `early_access_emails`), this causes connection pool exhaustion, query queues, and lock timeouts.

### Safe Zero-Downtime Adoption Patterns

#### Pattern A: Table-Level `CHECK ... NOT VALID` then `VALIDATE CONSTRAINT` (Recommended)
When keeping existing `text` columns while enforcing domain-level validation rules:
1. **Add constraint `NOT VALID`**:
   ```sql
   -- Acquires brief SHARE ROW EXCLUSIVE lock; does NOT scan existing rows.
   -- Only validates subsequent INSERTs and UPDATEs.
   ALTER TABLE public.early_access_emails
     ADD CONSTRAINT chk_early_access_emails_cm_email
     CHECK (
       email = lower(trim(email))
       AND char_length(email) <= 254
       AND position('@' in email) > 1
       AND email ~ '^[a-z0-9_%+-]+(\.[a-z0-9_%+-]+)*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$'
     ) NOT VALID;
   ```
2. **Validate constraint concurrently**:
   ```sql
   -- Scans existing rows with SHARE UPDATE EXCLUSIVE lock.
   -- Concurrent SELECT, INSERT, UPDATE, and DELETE operations proceed normally!
   ALTER TABLE public.early_access_emails
     VALIDATE CONSTRAINT chk_early_access_emails_cm_email;
   ```

#### Pattern B: Dual-Column Migration with Batched Backfill
When the column type itself must become the domain type (e.g. for PostgREST / GraphQL schema introspection):
1. Add new column with the domain type:
   ```sql
   ALTER TABLE public.early_access_emails
     ADD COLUMN email_v2 public.cm_email;
   ```
2. Deploy application code to dual-write to both `email` and `email_v2` (or use a trigger).
3. Backfill existing rows in throttled batches to avoid long locks or replication lag.
4. Verify data parity between `email` and `email_v2`.
5. Switch application reads and writes to `email_v2`.
6. Drop the old column and rename `email_v2` to `email`.

---

## 6. Adoption Phases

### Phase 0: Type Definition (Current PR)
- Create domain types in `supabase/migrations/20261112a_custom_domain_types.sql`.
- Migration status: **NOT APPLIED** (applied manually in Supabase SQL editor by the repository owner).
- **Zero changes** to existing tables, columns, indexes, triggers, or data.

### Phase 1: New Tables & Columns
- All new migrations introducing email, slug, or non-empty string fields must reference `cm_email`, `cm_slug`, or `cm_non_empty_text` instead of raw `text` with ad-hoc checks.
- Example:
  ```sql
  CREATE TABLE public.new_feature_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_email public.cm_email NOT NULL,
    organization_slug public.cm_slug NOT NULL,
    display_name public.cm_non_empty_text NOT NULL
  );
  ```

### Phase 2: Existing Column Audit & Data Cleansing
- Before adding constraints to existing columns, audit production data against the domain rules to identify legacy non-conforming rows:
  ```sql
  -- Audit emails violating cm_email rules
  SELECT email FROM public.early_access_emails
  WHERE email != lower(trim(email))
     OR char_length(email) > 254
     OR position('@' in email) <= 1
     OR email !~ '^[a-z0-9_%+-]+(\.[a-z0-9_%+-]+)*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$';

  -- Audit non-empty text violating cm_non_empty_text
  SELECT title FROM public.jobs
  WHERE title !~ '[^[:space:]]';

  -- Audit slugs violating cm_slug rules
  SELECT slug FROM public.companies
  WHERE slug != lower(trim(slug))
     OR length(trim(slug)) = 0
     OR char_length(slug) > 120
     OR slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$';
  ```
- Run targeted data-hygiene scripts to normalize any legacy entries before schema alterations.

### Phase 3: Staged Constraint Adoption with Owner Approval
- Using Pattern A (`ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT`), apply validation rules table-by-table.
- Priority candidate columns:
  - `public.early_access_emails.email`
  - `public.email_suppressions.email`
  - `public.early_access_approved.email`
  - `public.companies.slug`
  - `public.companies.name` (`cm_non_empty_text`)
  - `public.jobs.title` (`cm_non_empty_text`)

---

## 7. Rollback Runbook

If the domain definitions must be removed prior to column adoption:
```sql
DROP DOMAIN IF EXISTS public.cm_slug;
DROP DOMAIN IF EXISTS public.cm_non_empty_text;
DROP DOMAIN IF EXISTS public.cm_email;
```
*Note: Once columns adopt a domain type, `DROP DOMAIN ... CASCADE` must never be run in production as it drops dependent columns.*
