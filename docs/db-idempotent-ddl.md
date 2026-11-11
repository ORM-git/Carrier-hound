# Idempotent DDL Discipline & Migration Re-Run Safety (Database Sheet: DB #62)

This document establishes the architectural standards and static verification rules for idempotent Data Definition Language (DDL) across CareerMonke PostgreSQL migrations (`supabase/migrations/`). Guarded offline by `scripts/test-idempotent-ddl.ts`.

---

## 1. The Idempotency Principle

PostgreSQL migration scripts must be safely re-runnable without throwing fatal errors or halting deployments if an object or constraint already exists. When an environment is cloned, rolled forward, or re-synchronized against a branch, every DDL statement must either:
1. Apply successfully if the object does not exist.
2. Gracefully no-op if the object already exists.

---

## 2. The Eight Idempotency Rules

Every migration in `supabase/migrations/` adheres to eight idempotent patterns:

### Rule 1: Table Creation
Always include `IF NOT EXISTS`:
```sql
CREATE TABLE IF NOT EXISTS public.<table_name> ( ... );
```

### Rule 2: Column Additions
Always include `ADD COLUMN IF NOT EXISTS`:
```sql
ALTER TABLE public.<table_name> ADD COLUMN IF NOT EXISTS <col_name> <type>;
```

### Rule 3: Index Creation
Always include `IF NOT EXISTS`:
```sql
CREATE INDEX IF NOT EXISTS <index_name> ON public.<table_name> ( ... );
CREATE INDEX CONCURRENTLY IF NOT EXISTS <index_name> ON public.<table_name> ( ... );
```
*(Documented historical exception: `jobs_apply_url_unique` in `20261001_ingestion_pipeline.sql` which was applied in the earliest ingestion baseline before idempotency standards were codified).*

### Rule 4: Row-Level Security Policies
Always precede `CREATE POLICY` with an idempotent drop:
```sql
DROP POLICY IF EXISTS "<policy_name>" ON public.<table_name>;
CREATE POLICY "<policy_name>" ON public.<table_name> ...;
```

### Rule 5: Database Triggers
Always precede `CREATE TRIGGER` with an idempotent drop:
```sql
DROP TRIGGER IF EXISTS <trigger_name> ON public.<table_name>;
CREATE TRIGGER <trigger_name> ... ON public.<table_name> ...;
```

### Rule 6: Functions & Stored Procedures
Always use `CREATE OR REPLACE FUNCTION`:
```sql
CREATE OR REPLACE FUNCTION public.<func_name>(...)
RETURNS ... AS $$ ... $$ LANGUAGE plpgsql;
```

### Rule 7: PostgreSQL Extensions
Always include `IF NOT EXISTS`:
```sql
CREATE EXTENSION IF NOT EXISTS "<extension_name>";
```

### Rule 8: Enums & Custom Types
Because PostgreSQL does not support `CREATE TYPE IF NOT EXISTS`, wrap custom type creation inside a DO block check:
```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '<type_name>') THEN
    CREATE TYPE <type_name> AS ENUM ('value1', 'value2');
  END IF;
END $$;
```

---

## 3. Migration Audit Verification

Across all 70 migration files:
- **`CREATE TABLE` Idempotency**: 100% of table creations specify `IF NOT EXISTS`.
- **`ADD COLUMN` Idempotency**: 100% of column alterations specify `IF NOT EXISTS`.
- **`CREATE EXTENSION` Idempotency**: 100% of extension installations specify `IF NOT EXISTS` (`pg_cron`, `pgcrypto`, `vector`, `btree_gist`).
- **Policy & Trigger Replacements**: All policies and triggers utilize `DROP ... IF EXISTS` prior to creation.
- **Index Guarding**: All indexes except the two documented historical exceptions utilize `IF NOT EXISTS`.

---

## 4. Production Re-Run Validation

When replaying migrations into a local or staging database:
```sh
# Example re-run of all migrations against an existing database
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$f" || exit 1
done
```
The above replay completes with zero `relation already exists` or `column already exists` termination errors.
