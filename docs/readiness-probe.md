# Readiness probe (Backend sheet row: Liveness & Readiness Probes)

`GET` and `HEAD` `/api/health/ready` (`src/app/api/health/ready/route.ts`, logic in `src/lib/health/readiness.ts`).

- Liveness stays `/api/health` (unchanged). It says the process is up.
- Readiness adds two checks: the Supabase URL and anon key names are present, and one read-only
  `select id ... limit 1` on `jobs_public` with the anon key succeeds.
- 200 `{"status":"ready","checks":{...}}` or 503 `{"status":"not_ready","checks":{...}}`. `HEAD` returns the status only.
- The body lists check names and `ok`, `fail` or `skipped`. It never contains environment values or error text.
- `READINESS_TIMEOUT_MS` (optional, positive integer) stops waiting on the database after that many ms. Unset means no
  timer in the code, so the platform's own request limit applies.
- No service-role key, no writes. The route is on the existing public `/api/health/` allowlist in `src/middleware.ts`.

Offline test: `npx tsx scripts/test-readiness.ts` (logic with injected probes, plus static checks on the route file).

## Not proven (owner to confirm)

- The route was not built or called against a live host or database. CI's build step is the first real build.
- Each request makes one database call. No rate limit is added here; a monitor interval should be modest
  (`docs/slo.md` lists the current monitors) and any edge rate rule is an owner dashboard setting.
- Build-time behavior is not verified. The route handlers take a `Request`, and CI builds the route, but nobody has
  checked how the static-export (Netlify backup) build treats it. The `NOT_PROBED` branch in the route (no request,
  so no database call) is a defensive guard that the current handlers do not reach. If a static export serves this
  route, readiness there could be a build-time snapshot. Treat the Cloudflare edge build as the meaningful target
  (owner to confirm after the first deploy).
- No monitor is pointed at it yet. Adding it to UptimeRobot is an owner step. The sheet row stays PARTIAL until that
  and a live call are done.
