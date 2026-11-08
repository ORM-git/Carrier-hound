# Environments, parity and dashboard-only settings (Backend sheet rows: Infrastructure as Code, Staging Environment, Environment Parity)

Status: inventory. It changes no code or setting, and nothing here was checked against the live dashboards. The rows
stay PARTIAL. It extends `docs/config-drift.md`, which already covers the repo files pinned by hash and a monthly
dashboard checklist.

## What is defined in the repo (infrastructure as code, partial)

| Concern | Repo file | Note |
| --- | --- | --- |
| Netlify build, publish dir, function redirects | `netlify.toml` | Pinned by `scripts/config-drift-baseline.json` |
| Build variant (Cloudflare edge build vs static export) | `next.config.mjs` | Chosen by `CF_PAGES`, `NEXT_ON_PAGES` or `VERCEL`; otherwise `output: "export"` |
| Static response headers | `public/_headers` | Applied by the host |
| CI and cron workflows | `.github/workflows/` | Pinned by the config-drift baseline |
| Database schema | `supabase/migrations/`, `docs/schema-drift-baseline.md` | Applied by hand (`docs/zero-downtime-migrations.md`) |
| Environment variable names | `.env.example` | Names only, never values |

## What lives only in dashboards (not in code)

The repo cannot show these, so they are not infrastructure as code (owner to confirm each current value):

- Cloudflare Pages: build command and output directory, production branch, environment variables, custom domain and
  SSL mode, preview deployment policy, any firewall rules.
- Netlify (backup host): build command, deploy hooks, branch deploys.
- GitHub: repository secrets, default workflow-token permissions, branch protection.
- Supabase: project settings, auth providers, storage buckets, applied-migration state.
- Third parties: UptimeRobot monitors (`docs/slo.md`), Sentry projects, Razorpay and Groq account settings.

Secret classes and where each is stored: `docs/security/secrets-rotation-runbook.md`. The variable names the app reads
are the ones in `.env.example` (Supabase, Groq, cron secret, billing flag and Razorpay keys, mail script URL and
secret, notify address). Whether each host has every variable set is unproven from the repo.

## Staging (partial, by the sheet's own statement)

- No persistent staging environment is defined in the repo. The sheet row says Cloudflare Pages branch previews exist
  and there is no staging with production-like data (owner to confirm the preview setup).
- `docs/disaster-recovery.md` proposes a throwaway Supabase project plus a preview deploy for restore rehearsals.
  That is a plan, not an existing environment.
- `.env.example` sets `NEXT_PUBLIC_BILLING_ENABLED=false`, so a copy of the example does not turn billing on.

## Parity (partial)

- Production is Cloudflare Pages with the edge build; the Netlify backup uses the static export plus functions
  (`next.config.mjs`, `netlify.toml`). The two differ by design, so a bug can appear on one host only.
- CI builds one variant (`.github/workflows/ci.yml`). The other host's build is not exercised in CI.
- The test suite runs offline against code and fixtures; database-capable entries need a test project the owner
  provides (`scripts/lib/test-guard.cjs` guards which projects they may touch).

## What stays unproven

- Every dashboard value and every host's environment variables.
- Whether preview deployments exist, what data they use, and whether they match production settings.

## Owner steps (for the keeper's Doc)

1. Walk the dashboard list above once, and write down current values (names, not secret values) in a private note.
2. Say whether Cloudflare previews are on, and decide if a persistent staging project with fake data is wanted.
3. Decide whether to export host settings as code later (a wrangler or Terraform file), as a separate change.
4. Decide whether CI should also build the Netlify variant.
