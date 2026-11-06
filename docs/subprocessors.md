# Sub-Processor Inventory (INTERNAL)

> Internal compliance working document. Not customer-facing copy; do not
> publish or link from the site. Backend row BE#4.
> Last reviewed: 2026-11-06 (against `main`).

This lists third-party services that process CareerMonke user data, based on
what the codebase actually calls. Data categories are taken from the call
sites; where a provider-side detail (region, retention) is not visible in
code it is marked "provider-side - confirm with vendor docs" rather than
guessed.

| Sub-processor | Purpose | User data sent | Evidence in code |
| --- | --- | --- | --- |
| Supabase (project `szakevhxhwpeskidvtfs`) | Postgres database, Auth, file storage | All account and profile data: auth identities, candidate profiles, resumes (files), applications, preferences, usage logs | `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_*` env; `supabase/migrations/*`; `src/lib/account/*` |
| Cloudflare Pages | PRODUCTION hosting: serves the app and runs production functions; holds the Groq API key in Pages env | Full production request/response traffic (URLs, form submissions, cookies); the Groq credential | Per repo config (`carrier-hound.pages.dev`, `@cloudflare/next-on-pages`); owner to confirm. Groq key in Cloudflare Pages env |
| Netlify | Preview deploys + legacy functions only (NOT production traffic) | Preview/legacy request traffic only | `@netlify/plugin-nextjs` in `package.json`; edge `runtime` exports in API routes |
| Sentry | Error monitoring | Error events with stack traces and request context; may incidentally include user identifiers or payload fragments | `@sentry/nextjs` in `package.json`; `src/lib/monitoring/sentryErrorReporter.ts` |
| Groq | LLM inference for AI features (tailoring, analysis) | Resume and profile text submitted to AI endpoints | `https://api.groq.com/openai/v1/chat/completions` in `src/lib/ai/serviceHandler.ts` |
| Google (Gmail API) | Transactional email for early access (thank-you / digest) | Recipient email addresses; message content | `src/lib/early-access/gmail.ts`; `gmail_send_log` table |
| Razorpay | Payment processing (currently DISABLED - payments off) | Would receive billing identity + payment instrument details when enabled | `src/lib/billing/razorpay.ts`; `/api/billing/razorpay/*` routes |

## Contacted but NOT sub-processors (no user data)

- `open.er-api.com` - public FX rates only (`src/lib/salary/fx.ts`).
- `unavatar.io` - company logos by public company domain (`src/components/CompanyLogo.tsx`).
- Job-board sources (greenhouse.io, lever.co, ashbyhq.com) - read-only ingestion
  of public job posts. Never name these in customer-facing copy.

## Maintenance

- Review this file whenever a dependency or outbound integration is added.
- When payments are enabled, move Razorpay to the active list and re-review
  the privacy policy.
