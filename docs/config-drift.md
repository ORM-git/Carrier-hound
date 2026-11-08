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

Covered files:

- `netlify.toml`
- `next.config.mjs`
- `package.json` (build/start scripts and dependency pins drive the deploy)
- every workflow in `.github/workflows/`

A covered file that is deleted, or a new workflow added without a baseline
update, also fails the check.

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
