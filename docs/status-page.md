# Public status page (Backend sheet row: Status Page)

Status: runbook only. No public status page exists yet. This change adds no code, no route and
no external account. The row stays MISSING until the owner creates the page (steps below).

## What already exists (repo evidence)

- `src/app/api/health/route.ts`: `GET` and `HEAD` return 200 with `{"status":"ok"}` and no-store headers.
  It does not check the database or any provider, so it proves only that the edge function is up.
- `docs/slo.md`: availability SLIs for the site and for `/api/stats` and `/api/jobs`, measured by
  UptimeRobot monitors (the doc names UptimeRobot; whether the monitors exist live is owner to confirm).
- `docs/incident-log.md` and `docs/postmortems/`: the internal incident record.
- `docs/runbooks.md`: recurring failure runbooks.

## Proposed page (owner decision)

Components to show, one monitor each:

| Component | Monitor target | Source |
| --- | --- | --- |
| Website | `https://careermonke.com/` | docs/slo.md |
| Health endpoint | `/api/health` | src/app/api/health/route.ts |
| Stats API | `/api/stats` | docs/slo.md |
| Jobs API | `/api/jobs/search` (GET) | docs/slo.md |

Not shown on a public page: cron jobs (GitHub Actions), AI provider, email provider. They are internal
and an outage there is not a user-facing availability signal (owner to confirm).

## Incident communication template

Post on the status page, then log the incident in `docs/incident-log.md`.

1. Investigating: "We are looking into <symptom>. Started about <time IST>."
2. Identified: "The cause is <plain cause>. Working on a fix."
3. Resolved: "Fixed at <time IST>. <Who was affected and for how long>."
4. For anything over 30 minutes or with data impact, link the postmortem when it exists
   (the 30 minute threshold is a suggestion, owner to confirm).

## Owner steps (for the keeper's Doc)

1. Create a public status page in UptimeRobot (or another provider) and attach the monitors above.
2. Decide the page URL and whether to use a custom domain such as `status.<domain>`.
3. Add the final URL to the site footer or help page (a frontend change, separate from this doc).
4. After the page is live, update this file with the URL and flip the sheet row.

## What stays unproven

- Whether the UptimeRobot monitors named in `docs/slo.md` exist and alert today.
- The health endpoint is shallow by design; a database or provider outage would not turn it red.
