# Evidence: Preferences sheet + phone Hidden Jobs (PR branch `feat/preferences-sheet`)

Evidence only. This branch shares no history with `main` and is never merged.

**CONTROLLED FIXTURE — not live proof.** Every screenshot comes from `next dev` with:
- a mocked signed-in session and mocked Supabase/API responses (the repo harness `scripts/test-prompt5-base.cjs`);
- a dummy Supabase URL (`https://fixtureref.supabase.co`);
- every unmocked non-localhost request aborted.

No real account, database or production endpoint was touched. Nothing here shows live persistence or real job results.

| Folder | Code |
|---|---|
| `screenshots/after/` | `feat/preferences-sheet` head a0ff1152 on base b18f522b |
| `screenshots/before/` | untouched `main` b18f522b (Hidden Jobs states only; main has no Preferences sheet) |

## Screenshots
Each name starts with the viewport width: 320, 390, 1280 or 1440.

| Suffix | State |
|---|---|
| `-00-jobs-entry` | Entry point |
| `-01-sheet-collapsed` | Collapsed summaries, `+N`, "(saved, not applied)" |
| `-02/-03-basic` | Basic group |
| `-04/-05-role-picker` | Nested job-function picker and search |
| `-06-compensation` | Compensation group |
| `-07-interests` | Interests group, unavailable controls |
| `-08-company-conflict-blocked` | Update blocked by an include/exclude conflict |
| `-09-validation` | Validation error |
| `-10-keyboard-focus` | Visible keyboard focus |
| `-11-saving` | Upsert held pending |
| `-12-save-failed` | Upsert returns 500, retryable error |
| `-20-hidden-url` | `/jobs?hidden=true` with one saved hidden job |
| `-21-mobile-filter-sheet-bottom` | Bottom of the phone filter sheet |

## Logs
- `screenshots/*/capture-log.txt`: measured geometry, focus, Escape behaviour and the hidden-jobs URL/state per width.
- `before-repair.txt` and `after-repair.txt`: the new edge tests on the same files before and after the repair. Before: 25 failed / 58 passed. After: 83 passed.

## Reproduce
From a checkout of the PR branch with `node_modules` installed:

```
NEXT_PUBLIC_SUPABASE_URL=https://fixtureref.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=fixture-anon npx next dev -p 3610
REPO=. NEXT_PUBLIC_SUPABASE_URL=https://fixtureref.supabase.co node capture-preferences-and-hidden.cjs http://localhost:3610 out
# untouched main, Hidden Jobs states only:
... node capture-preferences-and-hidden.cjs http://localhost:3611 out-before before
```
