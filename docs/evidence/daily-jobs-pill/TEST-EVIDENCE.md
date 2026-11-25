# Daily jobs pill controlled native proof

Source tree: 33e37b252717ff442021b4030b360298ccb283d1. Reconstructed from live PR769 9ec36151 plus integration and IST v2 patches. Captured November 25, 2026 at 23:32 IST. These are controlled fixtures, not live database count verification.

Actual HomePage bundle, actual useDailyJobsCount hook, actual LandingJobsPreview component, compiled landing CSS and Tailwind stylesheet. Chrome viewports 390x844 and 1440x900. Next font loader is stubbed to Arial rather than downloaded Plus Jakarta Sans; preview image requests outside local origin are blocked and show fallback initials. Therefore these images prove pill copy, fit, visibility and surrounding flow, not exact full-page font/logo parity. Production browser acceptance remains required.

At both widths: 1122 renders 1,122 new job records added today; 1 uses singular record; 12345 fits with no pill overflow. Zero,503,malformed and previous-IST-day updatedAt hide the pill. Previous-day fixture uses current time minus24hours, ensuring the prior IST calendar day. Metrics include visibility and bounding rectangles. No production requests or profile edits.

Older PNGs in this directory are historical only. Current captures are named daily-STATE-WIDTH.png and phone-states.png. metrics.json is current. Ignore old UTC or found-today copy in historical files.
