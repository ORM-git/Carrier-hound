# Admin MFA posture (Backend sheet row: MFA / 2FA)

Status: documentation and a read-only guard test. No MFA is enforced by this repo, and this change
adds no enforcement. No admin route, middleware or login behavior changes. The row stays MISSING.

## What the code does today (repo evidence)

- Admin identity is decided server-side by `isVerifiedAdminUser` in `src/lib/admin/constants.ts`. It needs
  all three: the email is in the admin list, the email is confirmed (`email_confirmed_at` or
  `confirmed_at`, never `user_metadata`), and the account has a Google identity.
- Every admin API route under `src/app/api/admin` calls `verifyAdminSession` (`src/lib/admin/auth.ts`).
  The admin page layout (`src/app/admin/layout.tsx`) and `src/middleware.ts` call `isVerifiedAdminUser` too.
- `verifyAdminSession` applies a progressive IP lockout after failed admin verifications and logs failures
  through `src/lib/security/authMonitor.ts`.
- Because admin sign-in is Google-only, the second factor in practice is whatever the owner's Google
  account enforces (Google 2-Step Verification). The repo cannot see or prove that setting.
- Nothing in `src/lib/admin`, `src/app/api/admin`, `src/app/admin` or `src/middleware.ts` reads a Supabase
  assurance level (`aal`) or any MFA factor. The guard test checks this, so this doc cannot drift quietly.

## What would be needed for real enforcement (not done, owner decision)

1. Owner turns on Google 2-Step Verification for the admin Google account (an account setting).
   This alone gives most of the protection because admin login is Google-only.
2. Optional extra layer: enable Supabase Auth MFA (TOTP) for the project and require assurance level `aal2`
   inside `verifyAdminSession`. Enabling MFA is a Supabase project setting (dashboard) and enrolling the
   admin is a manual step. Adding the `aal2` check changes admin access behavior, so it needs an explicit
   owner decision and its own PR with a lock-out recovery plan (what happens if the factor is lost).
3. Update this doc and `scripts/test-admin-mfa-posture.ts` in the same PR as any enforcement.

## What stays unproven

- Whether Google 2-Step Verification is on for the admin account. Not visible from the repo.
- Whether Supabase MFA is enabled in the project. Not visible from the repo.
- No enforcement exists in code, so the sheet row stays MISSING.

## Owner steps (for the keeper's Doc)

1. Confirm 2-Step Verification (prefer a security key or passkey) on the admin Google account, and on the
   GitHub, hosting, Supabase and Razorpay owner accounts (`docs/maintainer-handoff.md` already asks for MFA
   on individual accounts).
2. Decide whether to add Supabase TOTP MFA with an `aal2` check for admin routes. If yes, approve a
   separate PR and set up a recovery path first.
3. After step 1 or 2 is confirmed, say so, and the row can be re-assessed.
