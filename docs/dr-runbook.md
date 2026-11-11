# Disaster Recovery Restore Runbook

Operational, step-by-step procedures for recovering CareerMonke services, databases, and secrets
during a P1 outage.

This runbook references and operationalizes the recovery architecture documented in
[disaster-recovery.md](disaster-recovery.md) and targets defined in
[rpo-rto-targets.md](rpo-rto-targets.md). Do not duplicate foundational asset definitions here;
refer to those documents for scope and commercial RPO/RTO commitments.

---

## 1. Quick Incident Triage

Before executing recovery steps, determine the failure domain:

```bash
# 1. Check public health endpoint
curl -i https://careermonke.com/api/health

# 2. Check full readiness (verifies database connectivity and essential tables)
curl -i https://careermonke.com/api/health/ready
```

| Triage Result | Probable Cause | Action |
| --- | --- | --- |
| `/api/health` fails (HTTP 502/503/timeout), `/` fails | Site/Edge deploy failure or Netlify CDN issue | Go to **[Procedure 1: Site Restore](#procedure-1-site-restore)** |
| `/api/health` passes, but `/api/health/ready` reports DB error | Database connection, credentials, or table drop | Go to **[Procedure 2: Database Restore](#procedure-2-database-restore)** |
| Rate-limit errors or HTTP 429 across all requests | Redis connection loss or Upstash outage | Fallback in-memory active; see [disaster-recovery.md Section 3](disaster-recovery.md#3-redis-upstash-lost) |
| Missing environment variables in logs (`missing_env`) | Netlify or GitHub Secrets wipe/drift | Go to **[Procedure 3: Env / Secrets Restore](#procedure-3-env--secrets-restore)** |

---

## Procedure 1: Site Restore

*Target RTO: ≤ 15 minutes (Target RPO: 0s)*  
*References: [disaster-recovery.md Section 1](disaster-recovery.md#1-site-down-database-healthy)*

Use this procedure when the production website is broken or returning 5xx errors, but the underlying database is healthy.

### Step 1.1: Netlify Instant Rollback (Recommended)
1. Open the Netlify Dashboard: `https://app.netlify.com/`
2. Navigate to **Sites** > **careermonke** > **Deploys**.
3. Identify the last known green deploy prior to the incident commit.
4. Click into the deploy details, then click **Options** > **Publish deploy**.
5. Netlify will point CDN edge routing to the previous static build within ~30 seconds.

### Step 1.2: CLI Emergency Deploy (Alternative)
If dashboard access is unavailable, deploy from the local repository checked out at the last green commit on `main`:

```bash
# Ensure clean build
npm ci
npm run build

# Deploy statically exported output directly to production
npx netlify deploy --prod --dir=out
```

### Step 1.3: Verification
Verify that both edge HTML and serverless function endpoints respond with HTTP 200:

```bash
curl -i https://careermonke.com/
curl -i https://careermonke.com/api/health
npx tsx scripts/smoke-post-deploy.ts
```

---

## Procedure 2: Database Restore

*Target RTO: ≤ 1 hour (Path A) / ≤ 2 hours (Path B)*  
*Target RPO: ≤ 24 hours (Free Tier snapshot) / ≤ 2 minutes (Pro PITR)*  
*References: [disaster-recovery.md Section 2](disaster-recovery.md#2-database-corrupted-or-dropped)*

### Path A: In-Place Platform Backup Restore (Existing Project)
Use this path when tables have been corrupted or accidentally modified, but the Supabase project container remains intact.

1. **Access Backups in Supabase**:
   - Owner logs into `https://supabase.com/dashboard/project/<project-ref>/settings/database`.
   - In the left sidebar, click **Backups**.
2. **Select Snapshot Timestamp**:
   - Locate the most recent daily snapshot generated before the incident corruption occurred.
   - Note: On Supabase Free Tier, snapshots occur once every 24 hours (retained for 7 days).
3. **Trigger Restore**:
   - Click **Restore** next to the selected snapshot.
   - Confirm project name and proceed. `[OWNER TO CONFIRM: Snapshot restore approval]`
   - Wait for the project status to return to `ACTIVE` (typically 15–45 minutes).
4. **Reconcile and Validate Data**:
   - Execute the labeled read-only reconciliation queries in the Supabase SQL Editor:
     ```sql
     -- Copy and run: supabase/scripts/reconciliation.sql
     ```
   - Ensure `jobs_vs_jobs_public_discrepancy` = 0 and sanity ratios are within valid bounds.
5. **Run Integration Suite**:
   ```bash
   npx tsx scripts/suite-runner.ts
   ```

---

### Path B: Disaster Recovery Replay into Fresh Project
Use this path if the Supabase project was deleted, suffered catastrophic provider loss, or corrupted beyond recovery.

1. **Create Fresh Supabase Project**:
   - Owner logs into `https://supabase.com/dashboard/` and clicks **New Project**.
   - Region: Select primary region (e.g., `ap-south-1` Mumbai).
   - Generate and securely store a strong database password in the password manager.
2. **Collect API Credentials**:
   - Retrieve from **Project Settings** > **API**:
     - `Project URL` (`NEXT_PUBLIC_SUPABASE_URL`)
     - `anon` `public` key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`)
     - `service_role` `secret` key (`SUPABASE_SERVICE_ROLE_KEY`)
     - Direct connection string (`DATABASE_URL` via Transaction pooler port 6543)
3. **Update Environment Secrets**:
   - Follow **[Procedure 3](#procedure-3-env--secrets-restore)** below to inject the new credentials into Netlify and GitHub Actions.
4. **Replay Migrations in Chronological Lexical Order**:
   - Apply all migration files under `supabase/migrations/` sequentially and record each in the migration ledger:
   ```bash
   # Replay migrations and update _migration_ledger
   # For each SQL file in supabase/migrations/ in filename order:
   for migration in $(ls -1 supabase/migrations/*.sql | sort); do
     echo "Applying: $migration"
     # Run SQL via psql or Supabase SQL Editor
     # Then record migration entry:
     node scripts/record-migration.cjs "$migration"
   done
   ```
5. **Apply Pending Fixes & Seed Verification**:
   - Run `supabase/scripts/apply-pending.sql` if any hardening steps were outstanding.
6. **Verify Restored Database**:
   ```bash
   # Run offline and live policy test suites
   npx tsx scripts/suite-runner.ts
   ```

---

## Procedure 3: Env / Secrets Restore

*Target RTO: ≤ 15 minutes (Target RPO: 0s)*  
*References: [disaster-recovery.md Table 1](disaster-recovery.md#what-we-are-recovering)*

Use this procedure when Netlify or GitHub environment variables have been lost, rotated, or point to a new infrastructure instance.

### Step 3.1: Required Secrets Checklist

| Variable Name | Consumer | Expected Source / Description |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Frontend & Functions | Supabase Project API URL (`https://<ref>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Frontend & Functions | Supabase Anon Public JWT |
| `SUPABASE_SERVICE_ROLE_KEY` | Netlify Functions & CI | Supabase Service Role Privileged Secret |
| `UPSTASH_REDIS_REST_URL` | Netlify Functions & CI | Upstash Redis REST endpoint (`https://...upstash.io`) |
| `UPSTASH_REDIS_REST_TOKEN` | Netlify Functions & CI | Upstash Redis REST authentication token |
| `GROQ_API_KEY` | AI endpoints & Cron | Groq Cloud API Key (`gsk_...`) |
| `NEXT_PUBLIC_SITE_URL` | Canonical links & CORS | Production site domain (`https://careermonke.com`) |
| `ADMIN_SECRET` | Admin API routes | High-entropy shared secret for administrative operations |
| `CRON_SECRET` | Cron webhooks | High-entropy bearer token for scheduled ingestion triggers |
| `RAZORPAY_KEY_ID` | Billing (when active) | Razorpay Key ID |
| `RAZORPAY_KEY_SECRET` | Billing (when active) | Razorpay Key Secret |

### Step 3.2: Retrieval
- Owner opens primary password manager vault (e.g., 1Password / Bitwarden).
- Locate vault entry `CareerMonke Production Secrets`.

### Step 3.3: Inject Secrets into Hosting & CI
1. **Netlify**:
   - Go to **Site configuration** > **Environment variables**.
   - Paste each key-value pair and select **All deploy contexts** (Production, Deploy Previews, Branch deploys).
2. **GitHub Actions**:
   - Go to Repository **Settings** > **Secrets and variables** > **Actions**.
   - Update repository secrets matching the checklist above.
3. **Trigger Production Redeploy**:
   - Rebuilding is **mandatory** because `NEXT_PUBLIC_*` variables are statically baked into the Next.js export bundle during `npm run build`.
   ```bash
   npx netlify build
   npx netlify deploy --prod
   ```

---

## Procedure 4: Post-Restore Health & Reconciliation Verification

Once all restore procedures are complete, perform this 3-tier validation:

1. **Smoke & Health Probes**:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://careermonke.com/api/health
   # Expected: 200

   curl -s -o /dev/null -w "%{http_code}\n" https://careermonke.com/api/health/ready
   # Expected: 200
   ```

2. **Data Consistency Reconciliation**:
   - Run the read-only reconciliation queries from `supabase/scripts/reconciliation.sql`.
   - Verify that:
     - `jobs` vs `jobs_public` active counts match exactly (difference = 0).
     - No orphan add-on credits exist without users.
     - `funnel_events` vs `page_views` counts obey realistic conversion sanity bounds.

3. **Offline & CI Suite Runner**:
   ```bash
   npx tsx scripts/suite-runner.ts
   ```

---

## 5. Restore Drill Checklist

To validate disaster recovery readiness, the owner should rehearse each recovery path periodically.
Record results of each rehearsal in [incident-log.md](incident-log.md).

| Drill ID | Drill Objective & Scenario | Cadence | Required Access & Prerequisites | Verification Command / Artifact | Target RTO | Last Run (Date) | Owner Sign-Off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **DR-01** | **Site Rollback Drill**: Revert Netlify deployment to previous green commit and verify edge failover. | Monthly | Netlify dashboard or Netlify CLI access | `/api/health` returns 200; `smoke-post-deploy.ts` PASS | ≤ 15 min | | `[OWNER TO CONFIRM]` |
| **DR-02** | **Ephemeral Cache Eviction Drill**: Temporarily invalidate Upstash Redis credentials to confirm seamless fallback. | Quarterly | Upstash console + Netlify env access | `/api/jobs/search` responds without 500; in-memory fallback engages | ≤ 15 min | | `[OWNER TO CONFIRM]` |
| **DR-03** | **Platform Backup Inspection Drill**: Inspect Supabase daily platform backup availability and verify retention window (7 days). | Monthly | Supabase Dashboard access | Backup snapshot timestamp verified ≤ 24h old | ≤ 10 min | | `[OWNER TO CONFIRM]` |
| **DR-04** | **Reconciliation & Integrity Audit Drill**: Run read-only reconciliation queries against production database. | Bi-weekly | Read-only SQL access to Supabase | `supabase/scripts/reconciliation.sql` produces 0 discrepancies | ≤ 10 min | | `[OWNER TO CONFIRM]` |
| **DR-05** | **Fresh Project Schema Replay Drill**: Replay all `supabase/migrations/*.sql` into a throwaway Supabase project and verify ledger. | Semi-annually | Secondary throwaway Supabase project | `scripts/suite-runner.ts` passes; ledger matches file list | ≤ 2 hours | | `[OWNER TO CONFIRM]` |
| **DR-06** | **Secrets & Credential Recovery Drill**: Audit and re-verify that all production secrets exist in the owner password manager. | Quarterly | Owner primary password vault | Checklist in Procedure 3 verified complete | ≤ 15 min | | `[OWNER TO CONFIRM]` |
