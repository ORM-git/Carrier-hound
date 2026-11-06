# Service Level Objectives (initial, pre-launch)

Initial targets. Review after the first month of real traffic; tighten or
drop per what the data shows.

| SLI | Target | Measured by |
| --- | --- | --- |
| Site availability (careermonke.com) | >= 99.5% monthly | UptimeRobot external monitor |
| API availability (/api/stats, /api/jobs) | >= 99.5% monthly | UptimeRobot monitor on /api/stats |
| Mobile LCP (p75) | <= 2.5s | Web Vitals collection (`web_vitals` table, PR #240/#248) |
| API latency | p95 < 3s under 200-user load | k6 (`scripts/loadtest/cm-load.js`, threshold enforced) |
| Daily digest delivery | Sent by 00:30 IST or alert | Cron run status + `cron_run_logs` |
| Error budget | 0.5% of monthly uptime | Downtime beyond budget pauses feature work for reliability work |

Error budgets beyond "did we burn it" (allocation policies, freeze rules)
are intentionally deferred until these SLIs have a month of data.
