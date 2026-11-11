# Recovery Point & Recovery Time Objectives (RPO / RTO Targets)

Grounded in [disaster-recovery.md](disaster-recovery.md), this document defines concrete proposed
Recovery Point Objectives (RPO — maximum tolerable data loss window) and Recovery Time Objectives
(RTO — maximum tolerable downtime) for CareerMonke based on the current infrastructure topology.

Any commercial target, budget threshold, or external operational parameter that cannot be verified
directly from the repository code is explicitly flagged as **`[OWNER TO CONFIRM]`**.

---

## 1. Architectural Baseline & Tier Grounding

| Layer | Service / Host | Current Repository Configuration & Constraints |
| --- | --- | --- |
| **Frontend & Functions** | Netlify (`careermonke.com`) | Next.js 14 App Router statically exported (`output: "export"`, published to `out/`). Serverless backend functions in `netlify/functions/`. Instant edge rollbacks available. |
| **Database (PostgreSQL)** | Supabase (**Free Tier**) | Managed PostgreSQL. Automated daily platform backups retained for 7 days. **Point-in-Time Recovery (PITR) is NOT available on Free tier** (requires Pro tier at \$25/month with WAL archiving). `[OWNER TO CONFIRM: Current project tier]` |
| **Database Schema** | Git repository + Supabase | Schema migrations version-controlled under `supabase/migrations/*.sql` and recorded in `_migration_ledger` via `scripts/record-migration.cjs`. |
| **Cache & Rate Limits** | Upstash Redis | Stateless ephemeral rate limiting and distributed locks. Designed to rebuild on traffic. |
| **Secrets & Credentials** | Netlify + GitHub Actions | Environment variables managed in provider settings; master secrets held in owner's encrypted password manager. |

---

## 2. Proposed RPO (Recovery Point Objective) Targets

RPO measures the maximum acceptable age of files or database records that must be recovered from backup storage for normal operations to resume if an outage or corruption occurs.

| Asset / Data Store | Current Free-Tier Baseline | Proposed Target RPO | Justification & Recovery Mechanism | Owner Confirmation Status |
| --- | --- | --- | --- | --- |
| **Application Code & Assets** | Git (`main` branch) | **0 seconds** | All production code is committed to GitHub `main`. Netlify builds deterministically from commit SHAs. | Verified from repo |
| **Database Schema & Policies** | `supabase/migrations/*.sql` | **0 seconds** | All 70+ SQL migrations and RLS policies are versioned in Git and tracked in `_migration_ledger`. | Verified from repo |
| **Database User & Transaction Data** (Resumes, Profiles, Applications, Subscriptions, Addon Credits) | Supabase Free-Tier Daily Backups (once every 24 hours, retained 7 days) | **≤ 24 hours** *(Free Tier baseline)*<br><br>**≤ 2 minutes** *(with Pro Tier upgrade)* | Under Supabase Free tier, platform backups run once daily. In a worst-case disaster occurring immediately before the next daily backup, up to 24 hours of newly created user data could be lost.<br><br>*Pro Upgrade Path*: Upgrading to Supabase Pro (\$25/mo) activates continuous WAL streaming (PITR), reducing RPO to minutes. | **`[OWNER TO CONFIRM]`**: Confirm whether 24h data loss window is commercially acceptable for launch or if Supabase Pro upgrade is approved. |
| **Ephemeral Cache & Rate Limits** | Upstash Redis REST | **N/A (0 seconds impact)** | Intentionally ephemeral. Rate-limiting token buckets and locks re-accumulate naturally on user traffic. | Verified from repo ([disaster-recovery.md](disaster-recovery.md#what-we-are-recovering)) |
| **Config & Secrets** | GitHub Secrets + Netlify Env | **0 seconds** | Master credentials stored in owner password manager; re-applied on project recreate. | **`[OWNER TO CONFIRM]`**: Confirm master secrets backup vault exists. |

---

## 3. Proposed RTO (Recovery Time Objective) Targets

RTO measures the duration of time and service level within which a business process must be restored after a disruption.

| Incident Scenario | Target RTO | Step-by-Step Recovery Path | Verification Mechanism | Owner Confirmation Status |
| --- | --- | --- | --- | --- |
| **Scenario 1: Site Down, Database Healthy**<br>*(Broken deploy, CDN outage, bad edge bundle)* | **≤ 15 minutes** | Netlify 1-click rollback in dashboard to previous green deploy, or CLI deploy: `npx netlify deploy --prod`. | HTTP 200 on `/api/health` and `/`; run `npx tsx scripts/smoke-post-deploy.ts`. | Verified from repo |
| **Scenario 2: Upstash Redis Lost / Degraded**<br>*(Rate-limiting service unavailable)* | **≤ 15 minutes** | Provision fresh database in Upstash Console, copy `UPSTASH_REDIS_REST_URL` and `TOKEN` to Netlify env vars, trigger deploy. Rate limiter also supports in-memory fallback. | `/api/jobs/search` responds with HTTP 200; ratelimit headers present. | Verified from repo |
| **Scenario 3: Database Corrupted (In-Place Restore)**<br>*(Bad migration, accidental data drop, DB remains accessible)* | **≤ 1 hour** | Owner triggers restore from the latest clean daily backup snapshot in Supabase Dashboard (Settings > Backups). | Run `supabase/scripts/reconciliation.sql` and `npx tsx scripts/suite-runner.ts`. | **`[OWNER TO CONFIRM]`**: Dependent on Supabase automated backup provisioning speed on current plan. |
| **Scenario 4: Catastrophic DB Loss (Fresh Project Replay)**<br>*(Supabase project destroyed, region loss, or unrecoverable corruption)* | **≤ 2 hours** | 1. Owner provisions fresh Supabase project (10m).<br>2. Update `NEXT_PUBLIC_SUPABASE_URL`, anon key, and service role key in Netlify & GitHub secrets (15m).<br>3. Replay `supabase/migrations/*.sql` in lexical order and record via `scripts/record-migration.cjs` (35m).<br>4. Run reconciliation & suite tests (20m).<br>5. Trigger Netlify production redeploy (15m). | Full pass on `npx tsx scripts/suite-runner.ts`, `/api/health/ready` returns 200, and `reconciliation.sql` shows 0 discrepancies. | **`[OWNER TO CONFIRM]`**: Confirm owner availability and access to manage Supabase project creation. |

---

## 4. RPO / RTO Comparison: Free Tier vs. Recommended Pro Tier

| Capability | Supabase Free Tier (Current) | Supabase Pro Tier (\$25/mo) (Recommended) |
| --- | --- | --- |
| **Backup Frequency** | Daily snapshot (1 per 24 hours) | Daily snapshot + continuous WAL archiving |
| **Database Data RPO** | **24 hours** `[OWNER TO CONFIRM]` | **~2 minutes** (Point-in-Time Recovery) |
| **Backup Retention** | 7 days | 7 days (standard) or 30 days (addon) |
| **Database Restore RTO** | **~1-2 hours** (manual snapshot restore) | **~30-60 minutes** (PITR to exact minute) |
| **Compute / Inactivity Pause** | Pauses after 7 days of inactivity | Never pauses; dedicated compute |
| **Commercial Suitability** | Pre-launch / Development | Production live with paying subscribers |

---

## 5. Owner Decision Points (`OWNER TO CONFIRM`)

The following operational decisions require sign-off by the application owner:

1. **`[OWNER TO CONFIRM]` Production Tier Upgrade**:
   - Free tier 24-hour RPO means user registrations, tailored resumes, and applications created between daily snapshots are lost in a total database disaster. Confirm whether upgrading to Supabase Pro (\$25/mo) for PITR (RPO ≤ 2 minutes) is approved before live billing launch.
2. **`[OWNER TO CONFIRM]` Automated Off-site Backup Dump**:
   - Evaluate setting up a scheduled GitHub Action or cron that runs `pg_dump` daily and encrypts/uploads artifacts to independent cloud storage (e.g., Cloudflare R2 / AWS S3) to remove single-vendor dependency on Supabase platform backups.
3. **`[OWNER TO CONFIRM]` Incident Escalation & Response SLA**:
   - Designate primary and secondary on-call contacts for P1 outages (currently owner Binit Kumar).
4. **`[OWNER TO CONFIRM]` Quarterly DR Drill Schedule**:
   - Rehearse Scenario 1 (site rollback) and Scenario 4 (fresh project replay) quarterly as detailed in [dr-runbook.md](dr-runbook.md).
