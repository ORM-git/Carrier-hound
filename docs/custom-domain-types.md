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
    AND VALUE ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
  )
  ```
- **Rules Enforced**:
  - **Normalization**: Must be stored strictly lowercase and trimmed (`VALUE = lower(trim(VALUE))`), matching application-level normalization (`normalizeEmail` in `src/lib/admin/earlyAccess.ts`).
  - **RFC Length Limit**: Maximum length 254 characters (RFC 5321).
  - **Format Validation**: Must contain a valid local-part, `@` delimiter with preceding characters, domain name, and valid top-level domain (`.[a-z]{2,}`).
  - Prevents uppercase letters, untrimmed whitespace, missing domains, and malformed email strings from ever being persisted.

### `public.cm_non_empty_text`
- **Base Type**: `text`
- **Enforced Constraints**:
  ```sql
  CHECK (length(trim(VALUE)) > 0)
  ```
- **Rules Enforced**:
  - Rejects empty strings (`""`).
  - Rejects whitespace-only strings (`"   "`).
  - Ensures required text columns (e.g. company names, job titles, department names) carry substantive content rather than blank placeholders.

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

---

## 3. Why DOMAIN Types Beat Duplicated Ad-Hoc CHECKs

| Dimension | Ad-Hoc `CHECK` Constraints | Reusable PostgreSQL `DOMAIN` Types |
| :--- | :--- | :--- |
| **Maintenance (DRY)** | Validation expressions must be copied to every table (`early_access_emails`, `email_suppressions`, etc.). | Single centralized definition. Changes or extensions are defined once. |
| **Drift Risk** | High. Table A might check `char_length <= 254`, while Table B checks `position('@' in email) > 1`, and Table C has no check. | Zero. Every column referencing `cm_email` enforces identical rules. |
| **Schema Readability** | Column appears as generic `text`; requirements are buried in table constraint catalogs. | Schema introspection (`information_schema.columns`) and PostgREST immediately report the domain type. |
| **Performance Overhead** | Evaluated per row on `INSERT`/`UPDATE`. | Identical performance. PostgreSQL evaluates domain constraints at write time with zero additional storage overhead. |
| **Refactoring Safety** | Removing or updating rules requires altering multiple tables and synchronizing migrations. | Controlled, centralized type definition. |

---

## 4. Staged Adoption Plan

Adopting domain types across production databases requires strict discipline to prevent unintended write rejections or lock contention on high-traffic tables.

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
- Before altering existing columns, audit production data against the domain rules to identify legacy non-conforming rows:
  ```sql
  -- Audit emails violating cm_email rules
  SELECT email FROM public.early_access_emails
  WHERE email != lower(trim(email))
     OR char_length(email) > 254
     OR position('@' in email) <= 1
     OR email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$';

  -- Audit slugs violating cm_slug rules
  SELECT slug FROM public.companies
  WHERE slug != lower(trim(slug))
     OR length(trim(slug)) = 0
     OR char_length(slug) > 120
     OR slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$';
  ```
- Run targeted data-hygiene scripts to normalize any legacy entries before schema alterations.

### Phase 3: Staged Column Adoption with Owner Approval
- With owner approval, migrate candidate columns table-by-table using non-blocking, zero-downtime procedures:
  ```sql
  -- Safe column type adoption using validated existing data
  ALTER TABLE public.early_access_emails
    ALTER COLUMN email TYPE public.cm_email;
  ```
- Priority candidate columns:
  - `public.early_access_emails.email`
  - `public.email_suppressions.email`
  - `public.early_access_approved.email`
  - `public.companies.slug`
  - `public.companies.name` (`cm_non_empty_text`)
  - `public.jobs.title` (`cm_non_empty_text`)

---

## 5. Rollback Runbook

If the domain definitions must be removed prior to column adoption:
```sql
DROP DOMAIN IF EXISTS public.cm_slug;
DROP DOMAIN IF EXISTS public.cm_non_empty_text;
DROP DOMAIN IF EXISTS public.cm_email;
```
*Note: Once columns adopt a domain type, `DROP DOMAIN ... CASCADE` must never be run in production as it drops dependent columns.*
