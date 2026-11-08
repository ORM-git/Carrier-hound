# Incident Log

Reverse-chronological record of production incidents. Newest first. Every
entry links a postmortem when one exists.

Public status page: none yet. See [status-page.md](status-page.md) for the plan and owner steps.

| Date | Incident | Impact | Root cause | Follow-up |
| --- | --- | --- | --- | --- |
| 2026-10-30 → 2026-11-06 | Early-access digest cron failing nightly | No daily early-access signup digest to owner | One of `APPS_SCRIPT_MAIL_URL` / `APPS_SCRIPT_MAIL_SECRET` / `EARLY_ACCESS_NOTIFY_EMAIL` missing from GitHub Actions secrets; script fails closed with `missing_env` | [postmortem](postmortems/2026-11-06-early-access-digest-missing-env.md) |
| 2026-11-05 | GitHub Actions stopped on private repo | CI + 3 daily crons halted | Actions spending limit hit (failed payment) | Repo made public as workaround; billing fix pending owner |
| 2026-11-04/05 | Main CI red | Merge gate weakened | Workflow permissions on security scan | Fixed in #239 / #242 |
| 2026-10 (mid) | Job detail page 500 loop | Job detail broken in prod | Runtime error on edge route | Fixed; regression prompt issued |
| 2026-10 (mid) | Jobs search 500 | Search down | Query error | Fixed same day |
| 2026-10-31 | Netlify deploys paused | Backup host stale | Netlify credits exhausted | Cloudflare Pages is primary; credits reset monthly |
