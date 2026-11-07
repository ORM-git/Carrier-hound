# Hotfix Process

For a production break that cannot wait for the normal review cycle.
The goal is the fastest safe return to a known-good state, then a calm
root-cause pass.

## 1. Revert first

- Default move is `git revert` of the offending merge, pushed to `main`.
  Revert is preferred over a hand-written forward fix because it returns
  to a state that already passed CI. (Used in practice: the #57
  rollback.)
- Cloudflare Pages auto-deploys `main`; a revert commit is the whole
  deployment mechanism. No special hotfix branch or manual dashboard
  deploy is needed.
- If a forward fix is genuinely smaller and safer than the revert, it
  still goes through a PR and the full local suite; "hotfix" changes
  urgency, not standards.

## 2. If a migration is involved

- Never edit an already-applied migration file. Write a new corrective
  migration (expand/contract per `docs/zero-downtime-migrations.md`),
  have the owner apply it in the Supabase SQL Editor, then record it
  with `node scripts/record-migration.cjs <name>`.
- Every migration's commented ROLLBACK section (see
  `supabase/scripts/rollback-notes.md` for the general guide) is the
  documented way back for a bad apply.

## 3. Record what happened

- Add the incident to `docs/incident-log.md` (newest first), even when
  the revert fixed it in minutes.
- User-facing impact or data risk: write a postmortem in
  `docs/postmortems/` and link it from the incident-log row.
- If the break escaped CI, add the missing regression check to the
  suite (`scripts/suite-runner.ts`) as part of the follow-up, not as
  part of the revert.

## 4. Communicate

- Owner posts status to affected users when impact was user-visible;
  the wording is the owner's call, never agent-authored copy.
