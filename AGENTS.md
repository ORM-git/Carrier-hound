# AGENTS.md — CareerMonke Project Context & Operational Guidelines

## 1. What This Project Is
CareerMonke is a job-search web application for discovering unindexed remote engineering, product, design, and data roles directly from employer career pages before they hit aggregators.
- **Frontend**: Next.js 14 App Router compiled via static export (`output: "export"`, published to `out/`).
- **Backend / APIs**: Netlify Functions (`netlify/functions/`) for serverless dynamic endpoints (search, AI, Pro paywall).
- **Database & Auth**: Supabase (PostgreSQL with RLS, Auth, storage) and Groq LLM API for AI matching.

---

## 2. Folder Map
- `src/app/`: Next.js App Router static pages (home, jobs, worldwide, remote, dashboard, tracker, resume, settings, admin).
- `src/components/`: Modular React components (job cards, slide-over filters, radar globe, resume parsers, UI primitives).
- `src/lib/api/`: Query helpers and direct PostgREST client builders (`src/lib/api/jobs.ts`).
- `src/lib/ai/`: AI security configurations, operation limits, prompt templates, and quota checking (`src/lib/ai/security.ts`).
- `src/lib/billing/`: Subscription tiers, Stripe webhook handlers, client Pro caching, and server entitlement verification.
- `netlify/functions/`: Serverless backend functions handling search, AI operations, paid field unlocking, and account actions.
- `scripts/`: Offline verification scripts, ingestion pipelines, test runners, and regression suites.
- `reports/`: Audit reports, hardening manifests, and security review documentation.
- `data/`: Taxonomy dictionaries, fallback datasets, role guides, and static seed data.
- `.github/workflows/`: CI/CD workflows for linting, builds, testing, and cron ingestion.

---

## 3. Commands
- `npm install`: Install dependencies.
- `npm run dev`: Start local Next.js development server.
- `npm run build`: Production build and static HTML export to `out/` (~25-35s, generates 49 static pages).
- `npx tsc --noEmit`: Full TypeScript type check across the project.
- `npm run lint`: Next.js ESLint validation.
- `npx tsx scripts/suite-runner.ts`: Central offline test suite runner.
- **Slow commands**: `npm run build` and `scripts/run-full-pro-regression.js` (takes ~30-60s generating sample PDF/DOCX and screenshots).

---

## 4. Auth & Security Map
### Endpoint Access Levels
- **Public**:
  - `netlify/functions/jobs-search.ts:114` & `src/app/api/jobs/search/route.ts:50`: Rate-limited keyword/facet job search.
  - `netlify/functions/stats.ts:12`: Aggregate live job statistics.
- **Logged-In Users**:
  - `netlify/functions/account-delete.ts:51-61`: Self-service account deletion (JWT verified).
  - `netlify/functions/simulate-checkout.ts:39-49`: Simulated checkout endpoint for testing.
- **Pro Subscribers**:
  - `netlify/functions/jobs-pro.ts:36-58`: Gated job compensation, direct apply URL, and full descriptions.
  - `netlify/functions/jobs-top10.ts:40-62`: Top 10 tailored candidate-matched jobs.
  - `netlify/functions/ai.ts:89-106`: AI resume tailoring, cover letter generation, and fit scoring (daily limit = 30).
- **Administrators**:
  - `src/app/api/admin/stats/route.ts:16-36`: Platform-wide administrative metrics.
  - `src/app/api/admin/users/route.ts:16-36`: User account list and subscription inspections.
  - `src/app/api/admin/users/block/route.ts:18-38`: Account suspension and access blocking.

### Core Security Controls
- **PostgREST Injection Sanitizer**: `sanitizeSearchQuery` in `src/lib/api/jobs.ts:47`, `netlify/functions/jobs-search.ts:38`, `src/app/api/jobs/search/route.ts:40` (strips `[%_(),"'`;\\$*]`).
- **CORS Allow-List**: `netlify/functions/_cors.ts:1-94` (strictly allows `localhost:3000`, `*.netlify.app`, `careermonke.com`).
- **IP Rate Limiter**: `netlify/functions/jobs-search.ts:48-95` (in-memory token bucket, 30 req / 60s per client IP).

---

## 5. Permanent Rules
1. **Zero Unintended Diffs**: Never change UI, design, layout, typography, colors, or copy unless explicitly instructed.
2. **No Route Creation**: Never create or rename pages/routes unless explicitly requested.
3. **Safety Locks**: No DB writes, migrations, GRANT/REVOKE, live-site requests, deploys, merges, or pushes to main unless instructed.
4. **Secrets Discipline**: Never print raw secret values. Always mask tokens (e.g. `abcd****`) with `file:line` references only.
5. **Rigorous Verification**: Every new test must include a negative control proving non-zero exit on invalid conditions.
6. **No Phantom Passes**: Never write PASS or DONE without raw terminal output. Allowed verdicts: `PASS-LOCAL`, `FAIL`, `NOT RUN`, `REPORT-ONLY`.
7. **Atomic Commits**: One bug/task = one commit. Display `git diff --stat` after each commit.
8. **Protected Files**: Do NOT touch `.github/workflows/`, `scripts/ingest.ts`, or `scripts/cleanup.ts` unless instructed.

---

## 6. Done So Far & Open Items
### Completed (Prompts 1–12)
- Hardened CORS on all serverless functions via centralized `_cors.ts`.
- Implemented in-memory rate limiting (30 req / 60s) on search functions.
- Fortified `.gitignore` against all `.env*` files, keys, and coverage logs.
- Added non-tech seniority blocklists (nurses, accountants, teachers) in `sanitizer.ts`.
- Auth & quota test suite with negative controls (`scripts/test-authz-handlers.ts`).
- Neutralized PostgREST filter injection at search call-sites (`src/lib/api/jobs.ts`).
- Quota check fails closed with HTTP 503 on database timeouts or errors (`src/lib/ai/security.ts`).
- Centralized site domain to `NEXT_PUBLIC_SITE_URL` with `https://careermonke.com` fallback.
- Added 21 invisible accessibility fixes (`role="presentation"` on backdrop div, `aria-label`s on 20 inputs).
- Configured immutable caching for `/_next/static/*` in `netlify.toml`.

### Known Open Items
- **Next.js Advisories**: Migration to Next.js 15.5.x required prior to public launch (currently unexploitable due to static export `output: "export"`).
- **Deployment Status**: Netlify production deployments are currently paused until 31 October.

---

## 7. How to Work
- **Targeted Reading**: Read only the specific files mentioned in the prompt.
- **No Full Scans**: Do not traverse or grep the entire codebase unnecessarily.
- **Search First**: If a file is not explicitly named, use targeted `git grep -n "<symbol>"` before opening files.

---

## 8. Graphify Knowledge Graph
Before any task read graphify-out/GRAPH_REPORT.md, then use /graphify query, /graphify path and /graphify explain to find files. Do not scan the whole repo. After changing files, run the graph update.
- **Impact Checks**: Before editing a shared function, query what depends on it (e.g. `graphify query` or `graphify affected "<symbol>"`).
- **Manual Rebuild**: Run `npm run graph` (or `graphify update .`).

