# Config drift detection

Deployment behavior for CareerMonke is defined in two places:

1. **Repo files** - `netlify.toml`, `next.config.mjs`, `package.json` build
   scripts, and the GitHub Actions workflows under `.github/workflows/`.
2. **Dashboard clickops** - Cloudflare Pages (production hosting) and
   Netlify (preview/legacy only) settings that exist only in the vendor
   dashboards: build command, environment variables, custom domain,
   deploy hooks, branch deploy rules.

Drift in the first group is now detected automatically. Drift in the
second group cannot be detected from the repo, so it is covered by the
manual review checklist below.

## Automated detection (CI)

`scripts/check-config-drift.ts` pins a sha256 of every covered repo file
in `scripts/config-drift-baseline.json` and runs in CI
(`Config Drift Check` step). A change to a covered file fails the build
unless the baseline is regenerated in the same PR:

```
npx tsx scripts/check-config-drift.ts --update
```

Commit the updated `scripts/config-drift-baseline.json` together with the
config change. The reviewer then sees the config edit and the baseline
update side by side, which is the audit trail the sheet row asks for.

Covered files (17 files pinned):

- `netlify.toml`
- `next.config.mjs`
- `package.json` (build/start scripts and dependency pins drive the deploy)
- `scripts/suite-runner.ts` (central test execution registry)
- Every workflow in `.github/workflows/`:
  - `board-ingest.yml`
  - `capacity-report-cron.yml`
  - `ci.yml`
  - `daily-digest-cron.yml`
  - `early-access-digest-cron.yml`
  - `ingest.yml`
  - `license-guard.yml`
  - `plan-regression.yml`
  - `quality-advisory.yml`
  - `retention-cron.yml`
  - `security-scan.yml`
  - `source-health-cron.yml`
  - `workflow-failure-alert.yml`

A covered file that is deleted, or a covered file modified without a baseline
update, fails the check.

## Baseline Refresh Procedure

Follow this procedure whenever a covered configuration or workflow file is modified or added:

### Step 1: Make your intentional config changes
Edit the target file (for example, adding a workflow file, registering a suite in `scripts/suite-runner.ts`, updating build scripts in `package.json`, or tuning headers in `netlify.toml`).

If introducing a *new* covered file not yet tracked by the checker, also add its relative path to `COVERED_FILES` in `scripts/check-config-drift.ts`.

### Step 2: Regenerate the baseline
Run the drift generator to recompute sha256 hashes for all covered files:
```bash
npx tsx scripts/check-config-drift.ts --update
```
Expected output:
```
Baseline written: 17 files pinned.
```

### Step 3: Verify the updated baseline locally
Run the verification check without the `--update` flag:
```bash
npx tsx scripts/check-config-drift.ts
```
Expected output:
```
Config drift check passed: 17 files match the pinned baseline.
```

### Step 4: Commit and open PR
Stage and commit `scripts/config-drift-baseline.json` (along with any edits to `scripts/check-config-drift.ts` or `docs/config-drift.md`) in the same commit or PR as the configuration change. This guarantees reviewer visibility into both the configuration diff and the cryptographic hash update.

### Troubleshooting
- **`DRIFTED: <file> changed without a baseline update.`**: A covered file was altered without updating `scripts/config-drift-baseline.json`. Run `npx tsx scripts/check-config-drift.ts --update` and commit the regenerated baseline.
- **`MISSING: <file> is pinned in the baseline but no longer exists.`**: A pinned file was deleted or renamed. If intentional, run `npx tsx scripts/check-config-drift.ts --update` (and update `COVERED_FILES` in `scripts/check-config-drift.ts`) to prune the file from the baseline.

## Manual dashboard review (clickops)

These settings live only in the vendor dashboards. Review them on a
monthly cadence and after any incident that touches deploys. Any change
found here is made deliberately in the dashboard and noted in the
incident/change log.

**Cloudflare Pages (production)**

- Build command and output directory match the repo scripts
- Production branch setting matches the expected default branch
- Environment variables: no unexpected additions/removals (names only;
  values are never recorded in the repo)
- Custom domain and SSL mode unchanged
- Preview deployments policy unchanged

**Netlify (preview/legacy only - production is Cloudflare Pages)**

- Build command matches repo scripts
- No production traffic routed here
- Deploy hooks and branch deploys as expected

See also: [environments-and-manual-settings.md](environments-and-manual-settings.md) for the list of dashboard-only settings, staging and parity facts.

## What this does not cover

- Secret values (never hashed into the repo).
- Supabase project settings (covered by the database sheet's migration
  workflow instead).
