# DNS cutover plan between hosts (Backend sheet row: Multi-provider Redundancy)

Status: a written plan. Nothing here was run, and no DNS record, dashboard or host was touched. The row stays PARTIAL
because the cutover has never been tested. This doc says what the repo shows, what to check, and which steps only
the owner can do in the DNS and host dashboards.

## What the repo shows

- Cloudflare Pages (`carrier-hound.pages.dev`) is the primary host and Netlify is the backup (`docs/runbooks.md`
  section 4, `docs/config-drift.md`). Supabase is the single database for both.
- The two hosts build differently (`next.config.mjs`): the Cloudflare build is an edge server build, and the Netlify
  build is a static export plus functions (`netlify.toml`). See `docs/config-drift.md`.
- The production domain is not recorded in the repo as configuration. `scripts/smoke-post-deploy.ts` defaults to
  `https://careermonke.com`, and the allow-list in `netlify/functions/_cors.ts` includes `careermonke.com`,
  `www.careermonke.com`, `carrier-hound.pages.dev` and several `netlify.app` names. Which host the domain points at
  today, and who holds the DNS zone, are owner facts (owner to confirm).

## Before any cutover (checks, no change)

1. Netlify can build the current `main` and passes its deploy preview. Netlify builds may be paused when credits run
   out (`docs/runbooks.md` section 4), so check this first.
2. The backup host has every environment variable the primary has. Names are in `.env.example` and
   `docs/security/secrets-rotation-runbook.md`. Compare names only, never paste values.
3. Run the post-deploy smoke script against the backup host URL (not the domain):
   `npx tsx scripts/smoke-post-deploy.ts https://<backup-host-url>`.
4. Confirm the backup host's URL is in the CORS allow-list (`netlify/functions/_cors.ts`), or that
   `NEXT_PUBLIC_SITE_URL` is set there.
5. Supabase Auth redirect URLs and any email links must include the host that will serve users (dashboard setting,
   owner to confirm).
6. Find the DNS record's current TTL. A long TTL slows both the cutover and the return.

## Cutover steps (owner, in the DNS and host dashboards)

1. Announce the maintenance window if users could see errors.
2. Write down the current record values (type, name, target, TTL) in a private note. This is the rollback.
3. Attach the domain to the backup host in its dashboard, so it can serve and issue a certificate.
4. Change the record to the backup host's target.
5. Wait for the TTL. Then run the smoke script against the real domain and check `/api/health`.
6. Check one signed-in page, one job search, and one cron-protected endpoint with the cron secret.
7. Note the time and the result in `docs/incident-log.md`.

## Return to primary

Reverse steps 3 to 6 using the values saved in step 2, then record it. Do the same order: attach the domain on the
primary first, then change the record.

## What stays unproven

- Whether the cutover works end to end: certificate issue time, the TTL actually in force, and cookies or sessions
  across hosts. None of this has been run.
- Whether the backup host serves every route the same way, since the two builds differ.
- Who holds the DNS zone and what access they have.

## Owner steps (for the keeper's Doc)

1. Say where the DNS zone is hosted and who has access, and which host the domain points at today.
2. Pick a quiet time for one real rehearsal. A rehearsal could also use a spare subdomain instead of the main domain.
3. After the rehearsal, record the result here and in `docs/incident-log.md`, and then the row can be re-assessed.
