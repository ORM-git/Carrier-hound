# Feature flags (Backend sheet row: Feature Flags)

The flags are plain environment variables. `src/lib/flags/flags.ts` lists every one the code reads, the exact rule it
uses, and its default (all off, which is today's behavior). `scripts/test-flags-registry.ts` fails if a new
`process.env.NAME === "true"` flag appears in `src/` or `netlify/` without an entry, or if an entry is no longer used.

| Variable | Rule | Scope |
| --- | --- | --- |
| `NEXT_PUBLIC_BILLING_ENABLED` | exact `true` | public, inlined at build. Payments stay off until the owner activates billing |
| `NEXT_PUBLIC_ENABLE_INTERVIEW_PACK` | exact `true` | public, inlined at build |
| `NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF` | exact `true` | public, inlined at build |
| `ALLOW_LOCALHOST_CORS` | exact `true` | server |
| `AI_GLOBAL_DISABLE` | `true`, `1`, `yes` or `on` | server, emergency kill switch for AI routes |
| `__CAREERMONKE_LEGACY_*` (six names, see the registry) | exact `true` | server, restores earlier behavior |

## How to change a flag

Set or remove the variable in the host environment (Cloudflare Pages or Netlify) and redeploy. `NEXT_PUBLIC_` flags are
read at build time, so they need a new build. Do not put a secret value in a flag.

## Adding a flag

1. Add an entry to `FLAGS` in `src/lib/flags/flags.ts` with a default of off.
2. Read it where needed. Public (`NEXT_PUBLIC_`) flags must keep the literal `process.env.NAME` form so the build can
   inline them. Server code may call `isFlagEnabled(name, env)`.
3. Run `npx tsx scripts/test-flags-registry.ts`.

## What this is not (row stays PARTIAL)

- No flag service: no per-user or percentage rollout, no change without a redeploy, no audit trail beyond host logs.
- No existing call site was changed to use the helper. The registry documents and guards them; the rules were copied
  from the call sites and the test checks the AI rule against the handler's own parser.
- `docs/edge-kv.md` describes a possible later runtime store (owner decision, not set up).
