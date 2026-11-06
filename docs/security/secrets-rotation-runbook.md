# Secrets Rotation Runbook

Every secret, where it lives, and how to rotate it. Rotate immediately on
suspected exposure; otherwise review quarterly. Git history before 2026-10
contained real Groq and Supabase keys - anything from that era must be
treated as exposed.

| Secret | Stored in | Used by | How to rotate |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions secrets, Cloudflare Pages env, Netlify env | Server-side DB writes, crons | Supabase dashboard > Project Settings > API > regenerate service role key; update all three stores. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public bundle (safe) | Browser client | Rotates with the Supabase JWT signing secret (below). |
| Supabase JWT signing secret | Supabase dashboard | All issued tokens | Supabase dashboard > Auth settings. **PENDING since Oct 20** - rotating signs out every user; do it in a low-traffic window. |
| `GROQ_API_KEY` | GitHub Actions, Cloudflare, Netlify env | AI routes, matching cron | console.groq.com > API Keys > create new, deploy, revoke old. Old keys are in pre-Oct-20 git history - confirm they are revoked. |
| `CRON_SECRET` | GitHub Actions + Cloudflare/Netlify env | Cron endpoint auth | Generate a new random 32+ char value; never ship the `.env.example` placeholder in production (verify it is not the placeholder). |
| `UNSUBSCRIBE_SECRET` | Cloudflare/Netlify env (+ GitHub Actions if crons sign links) | One-click unsubscribe HMAC | **PENDING initial setup** - generate random 32+ char value, set in Pages/Netlify env. Code fails closed when missing. |
| `APPS_SCRIPT_MAIL_URL` / `APPS_SCRIPT_MAIL_SECRET` | GitHub Actions secrets | Digest + transactional mail via Apps Script | Rotate the shared secret in the Apps Script project and GitHub secrets together. |
| `EARLY_ACCESS_NOTIFY_EMAIL` | GitHub Actions secrets | Early-access digest recipient | Not a secret value; update in GitHub secrets if the recipient changes. |
| Razorpay key id/secret + webhook secret | Cloudflare/Netlify env | Billing (disabled pre-launch) | Razorpay dashboard > Settings > API Keys > regenerate; update webhook secret too. |
| `SENTRY_DSN` / auth token | Cloudflare/Netlify env, GitHub (release upload) | Error monitoring | Sentry > Settings > Projects > Client Keys; revoke old DSN. |
| Supabase DB password | Supabase | Direct psql access (manual checks) | Supabase dashboard > Database settings > reset password. |

After any rotation: redeploy Cloudflare Pages, re-run one scheduled cron
manually (`workflow_dispatch` dry run), and confirm no auth errors in
Sentry for 24h.
