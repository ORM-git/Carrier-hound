# Owner Preflight: Account Deletion Schema & Security Validation (20261106h)

This runbook guides the repository owner in safely inspecting and verifying the production database schema and security permissions for account deletion, soft deletes, and tombstones before enabling or rolling out production deletion workflows.

> [!IMPORTANT]
> **READ-ONLY INSPECTION ONLY**: Do not execute destructive SQL or re-run broad migrations blindly. All queries below are read-only inspection statements.

---

## 1. Schema Preflight Checks

Execute the following SQL queries in the Supabase SQL Editor:

### 1.1 Verify Tombstones Table and Structure
```sql
SELECT
    table_name,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'deleted_account_tombstones'
ORDER BY ordinal_position;
```
**Expected Columns**:
- `id` (uuid, NO)
- `user_id` (uuid, NO)
- `email_hash` (text, NO)
- `deletion_completed_at` (timestamptz, NO)
- `hard_delete_after` (timestamptz, NO)
- `purged_at` (timestamptz, YES)
- `created_at` (timestamptz, NO)

### 1.2 Verify Row-Level Security (RLS) and Client Permissions
```sql
-- Check RLS is enabled
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname = 'deleted_account_tombstones';

-- Check table permissions: anon and authenticated must NOT have SELECT, INSERT, UPDATE, or DELETE
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'deleted_account_tombstones';
```
**Expected Grants**:
- `service_role`: `SELECT`, `INSERT`, `UPDATE`
- `anon`, `authenticated`: **NO GRANTS** (revoked per `20261106h_soft_delete_tombstones.sql`).

### 1.3 Verify Soft-Delete Columns (`deleted_at`)
```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'deleted_at'
  AND table_name IN (
    'candidate_profiles', 'user_preferences', 'resumes', 'tailored_resumes',
    'saved_jobs', 'applications', 'job_applications', 'search_alerts',
    'daily_digests', 'ai_usage_quotas', 'ai_usage_ledger', 'page_views',
    'user_roles', 'user_consents', 'early_access_emails'
  )
ORDER BY table_name;
```

---

## 2. API Contract Verification

To verify that the application correctly interacts with the database:

1. **Authenticated User Status Check**:
   Call the authenticated endpoint:
   ```bash
   curl -s -H "Authorization: Bearer <USER_SESSION_TOKEN>" https://<SITE_ORIGIN>/api/account/status
   ```
   **Expected Response** for a healthy active user:
   ```json
   {
     "onboardingCompleted": true,
     "deletionPending": false,
     "accountState": "active"
   }
   ```
   *Must return HTTP 200, never HTTP 42501 or permission error.*

2. **Interrupted Deletion Safety**:
   If an account deletion is interrupted, the tombstone keeps `deletionPending: true` so the user is routed to Settings recovery rather than re-entering ordinary onboarding.
   The user can:
   - Retry deletion via `POST /api/account/delete`
   - Cancel deletion & reset via `POST /api/account/delete` with `{ "action": "cancel" }`.

---

## 3. Rollout Checklist

- [ ] All 15 user-owned tables have `deleted_at` column.
- [ ] `deleted_account_tombstones` table exists with RLS enabled and grants restricted to `service_role`.
- [ ] No client-side code directly selects from `deleted_account_tombstones`.
- [ ] Server endpoint `/api/account/status` returns expected JSON shape under `service_role` authority.
