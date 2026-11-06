# Service Level Objectives (initial, pre-launch)

Initial targets. Review after the first month of real traffic; tighten or
drop per what the data shows.

| SLI | Target | Measured by |
| --- | --- | --- |
| Site availability (careermonke.com) | >= 99.5% monthly | UptimeRobot external monitor |
| API availability (/api/stats, /api/jobs) | >= 99.5% monthly | UptimeRobot monitor on /api/stats |
| Mobile LCP (p75) | <= 2.5s | Web Vitals collection (`web_vitals` table, PR #240/#248) |
| Server response TTFB (p75) | <= 800 ms | RUM `web_vitals` (`name=TTFB`) evaluated by `scripts/check-ttfb-slo.ts` ([web.dev guidance](https://web.dev/articles/ttfb); provisional standard-based target, not a measured production baseline) |
| API latency | p95 < 3s and p99 < 5s under 200-user load | k6 (`scripts/loadtest/cm-load.js`, thresholds enforced) |
| Daily digest delivery | Sent by 00:30 IST or alert | Cron run status + `cron_run_logs` |
| Error budget | 0.5% of monthly uptime | Downtime beyond budget pauses feature work for reliability work |

## Error budget policy (BE#8)

Budget: 0.5% of monthly uptime per availability SLI (row above). The policy
is defined now and applies as soon as each SLI has measurement data; until
then the freeze rule below is manual.

- **Fast burn**: if an SLI burns budget at more than 14.4x its allocated
  rate sustained for 1 hour (canonical SRE multiwindow default), page the
  on-call and stop non-fix deploys to the affected surface.
- **Slow burn**: more than 6x allocated rate sustained over 6 hours opens a
  reliability issue and is triaged next business day.
- **Budget exhausted for the month**: feature work on the affected surface
  pauses; merges are reliability fixes only until the monthly window resets.
- **Measurement**: availability SLIs from the UptimeRobot monitors, TTFB from
  `web_vitals` via `scripts/check-ttfb-slo.ts`, cron delivery from
  `cron_run_logs`. Burn-rate alerting automation is an owner-side monitor
  configuration step; this policy defines the thresholds it should use.
